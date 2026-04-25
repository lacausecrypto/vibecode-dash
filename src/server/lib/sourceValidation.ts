import type { Database } from 'bun:sqlite';
import {
  type SubredditValidation,
  validateRedditUser,
  validateSubreddit,
} from '../wrappers/redditApi';
import { type XHandleValidation, extractFromHandles, validateXHandles } from '../wrappers/xApi';
import type { PresenceSourceRow, SourceValidationDetail, SourceValidationStatus } from './presence';

/**
 * Pack A — Source-level validation dispatcher.
 *
 * Handles the four (platform, kind) combinations our scanners care about,
 * via the gratis-CDN endpoints already exercised elsewhere in the app:
 *
 *   - reddit / subreddit   → /r/{name}/about.json
 *   - reddit / reddit_user → /user/{name}/about.json
 *   - x / x_user          → cdn.syndication.twimg.com followbutton info
 *   - x / x_topic         → parse `from:` operands, batch-validate handles
 *   - x / x_list          → no free validation; treat as unknown (skip)
 *
 * The dispatcher returns a SourceValidationDetail. `setSourceValidationStatus`
 * then persists it onto the row, with auto-deactivation when the platform
 * confirms the source is dead (`not_found` / `banned` / `invalid_format`).
 *
 * Cost: zero across all paths.
 */

const nowSec = () => Math.floor(Date.now() / 1000);

function mapRedditSubResult(r: SubredditValidation): SourceValidationDetail {
  switch (r.status) {
    case 'valid':
      return { status: 'valid' };
    case 'not_found':
      return { status: 'not_found' };
    case 'private':
      return { status: 'private' };
    case 'banned':
      return { status: 'banned' };
    case 'invalid_format':
      return { status: 'invalid_format', details: r.details };
    case 'error':
      return { status: 'error', details: r.details };
    default:
      return { status: 'error' };
  }
}

function mapXHandleResult(r: XHandleValidation): SourceValidationStatus {
  switch (r.status) {
    case 'valid':
      return 'valid';
    case 'not_found':
      return 'not_found';
    case 'invalid_format':
      return 'invalid_format';
    case 'error':
      return 'error';
    default:
      return 'error';
  }
}

export async function validateSourceIdentifier(opts: {
  platform: string;
  kind: string;
  identifier: string;
}): Promise<SourceValidationDetail> {
  const { platform, kind, identifier } = opts;

  if (platform === 'reddit' && kind === 'subreddit') {
    return mapRedditSubResult(await validateSubreddit(identifier));
  }

  if (platform === 'reddit' && kind === 'reddit_user') {
    const r = await validateRedditUser(identifier);
    if (r.status === 'valid') return { status: 'valid' };
    if (r.status === 'not_found') return { status: 'not_found' };
    if (r.status === 'banned') return { status: 'banned' };
    if (r.status === 'invalid_format') return { status: 'invalid_format', details: r.details };
    return { status: 'error', details: r.details };
  }

  if (platform === 'x' && kind === 'x_user') {
    const map = await validateXHandles([identifier]);
    const lower = identifier.replace(/^@/, '').toLowerCase();
    const r = map.get(lower);
    if (!r) return { status: 'error', details: 'no result' };
    return { status: mapXHandleResult(r), details: 'details' in r ? r.details : undefined };
  }

  if (platform === 'x' && kind === 'x_topic') {
    // Pull every `from:handle` reference. A topic with zero from: clauses
    // (pure keyword search) is structurally always valid; we trust the X
    // search engine to parse it. With one or more from:, validate each.
    const handles = extractFromHandles(identifier);
    if (handles.length === 0) {
      return { status: 'valid' };
    }
    const map = await validateXHandles(handles);
    const breakdown: Array<{ handle: string; status: SourceValidationStatus }> = handles.map(
      (h) => ({
        handle: h,
        status: mapXHandleResult(map.get(h.toLowerCase()) ?? { status: 'not_found' }),
      }),
    );
    const allValid = breakdown.every((b) => b.status === 'valid');
    const allDead = breakdown.every(
      (b) => b.status === 'not_found' || b.status === 'invalid_format',
    );
    if (allValid) return { status: 'valid', handles: breakdown };
    if (allDead) return { status: 'not_found', handles: breakdown };
    return {
      status: 'partial',
      handles: breakdown,
      details: `${breakdown.filter((b) => b.status === 'valid').length}/${breakdown.length} handles valid`,
    };
  }

  if (platform === 'x' && kind === 'x_list') {
    // X list IDs require Bearer auth to verify existence. We can't validate
    // free, so we mark as `valid` and rely on the scanner's per-attempt
    // status to surface dead lists later.
    return { status: 'valid', details: 'x_list validation requires Bearer; skipped' };
  }

  return { status: 'error', details: `unsupported (platform=${platform}, kind=${kind})` };
}

/**
 * Persist the validation outcome onto the source row. When the platform
 * confirms the source is dead, auto-flip `active = 0` so the scanner
 * doesn't keep wasting cycles. Status `partial` and `error` keep `active`
 * untouched (the user should review).
 */
export function setSourceValidationStatus(
  db: Database,
  sourceId: string,
  detail: SourceValidationDetail,
): void {
  const at = nowSec();
  const shouldDeactivate =
    detail.status === 'not_found' ||
    detail.status === 'banned' ||
    detail.status === 'invalid_format';

  db.query<unknown, [string, number, number | null, string]>(
    `UPDATE presence_sources
        SET validation_status = ?,
            validated_at = ?,
            active = COALESCE(?, active)
      WHERE id = ?`,
  ).run(detail.status, at, shouldDeactivate ? 0 : null, sourceId);
}

export type ValidateAllOutcome = {
  total: number;
  valid: number;
  not_found: number;
  private_count: number;
  banned: number;
  partial: number;
  error: number;
  deactivated: number;
  per_source: Array<{
    source_id: string;
    platform: string;
    identifier: string;
    label: string | null;
    detail: SourceValidationDetail;
  }>;
};

/**
 * Walk every source (active or not, since the user may want to know that a
 * dormant one is now broken) and run the dispatcher. Reddit calls are
 * throttled (~5 req/sec) to stay polite on the public endpoints; X calls
 * are batched to a single request per chunk.
 */
export async function validateAllSources(
  db: Database,
  opts: { activeOnly?: boolean } = {},
): Promise<ValidateAllOutcome> {
  const where = opts.activeOnly ? 'WHERE active = 1' : '';
  const sources = db.query<PresenceSourceRow, []>(`SELECT * FROM presence_sources ${where}`).all();

  const outcome: ValidateAllOutcome = {
    total: sources.length,
    valid: 0,
    not_found: 0,
    private_count: 0,
    banned: 0,
    partial: 0,
    error: 0,
    deactivated: 0,
    per_source: [],
  };

  for (let i = 0; i < sources.length; i++) {
    const s = sources[i];
    const detail = await validateSourceIdentifier({
      platform: s.platform,
      kind: s.kind,
      identifier: s.identifier,
    });
    const wasActive = s.active === 1;
    setSourceValidationStatus(db, s.id, detail);

    switch (detail.status) {
      case 'valid':
        outcome.valid += 1;
        break;
      case 'not_found':
        outcome.not_found += 1;
        if (wasActive) outcome.deactivated += 1;
        break;
      case 'private':
        outcome.private_count += 1;
        break;
      case 'banned':
        outcome.banned += 1;
        if (wasActive) outcome.deactivated += 1;
        break;
      case 'invalid_format':
        outcome.not_found += 1; // accounted for under the not_found bucket
        if (wasActive) outcome.deactivated += 1;
        break;
      case 'partial':
        outcome.partial += 1;
        break;
      default:
        outcome.error += 1;
    }
    outcome.per_source.push({
      source_id: s.id,
      platform: s.platform,
      identifier: s.identifier,
      label: s.label,
      detail,
    });

    // Throttle Reddit calls (one HTTP request each). X is already batched
    // by the underlying validateXHandles so it's fine.
    if (s.platform === 'reddit' && i < sources.length - 1) {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  return outcome;
}
