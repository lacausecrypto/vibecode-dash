import type { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import type { Settings } from '../config';
import { listDrafts, transitionDraft } from '../lib/presence';
import { xPostTweet } from '../wrappers/xApi';

/**
 * Auto-publish worker — Tier 1 of the presence-copilot publish pipeline.
 *
 * Looks at every draft in `approved` state and decides whether to publish.
 * X drafts go through `xPostTweet` (OAuth 1.0a). Reddit drafts are HANDED
 * OFF to the UI: the worker does not call any Reddit API; it logs a
 * `reddit_handed_off` decision with a deeplink the UI surfaces. The user's
 * subsequent click → "Mark posted" callback transitions the draft.
 *
 * Every decision (publish, skip, defer, fail) writes one row to
 * `presence_publish_log`, including dry-run runs. The log is the single
 * place to look when the user wonders why a draft did or didn't go out.
 *
 * Safety rails — applied in order, first-fail wins:
 *
 *   1. Kill switch         (settings.presence.publishMode === 'off' / 'dry_run')
 *   2. Time-window gate    (publishWindowStart..End, publishDays)
 *   3. Daily rate cap      (maxPostsPerDayX, maxPostsPerDayReddit) — counts
 *                          rows in presence_drafts with posted_at >= local
 *                          midnight + the right platform.
 *   4. Per-source cooldown (publishCooldownPerSourceHours) — checks the
 *                          most recent posted draft for the same source.
 *   5. Duplicate detection (sha1 of normalized body matches a posted-in-
 *                          last-7-days draft).
 *
 * Only after all five pass does the worker actually call the platform.
 *
 * Idempotency: the worker is safe to run on a 60 s tick. It picks up
 * exactly the drafts whose status is still `approved` and whose posted_at
 * is null. Calling `transitionDraft` to `posted` flips both atomically,
 * so a second tick that fires before the first finished its API call
 * will simply find no eligible drafts (the first call was the one to
 * succeed; if it fails before transitioning, the audit log captures the
 * failure and the next tick retries).
 *
 * Concurrency: we never run two ticks in parallel — the scheduler caller
 * `await`s `runPresencePublish` to completion. The internal loop is
 * sequential per draft to respect daily caps + jitter.
 */

const DAY_SEC = 86400;

export type PublishDecision =
  | 'published'
  | 'reddit_handed_off'
  | 'skipped_kill_switch'
  | 'skipped_window'
  | 'skipped_rate_cap'
  | 'skipped_cooldown'
  | 'skipped_duplicate'
  | 'dry_run'
  | 'failed';

export type PublishOutcome = {
  considered: number;
  published: number;
  reddit_handed_off: number;
  skipped: number;
  failed: number;
  decisions: Array<{
    draft_id: string;
    decision: PublishDecision;
    reason: string | null;
  }>;
};

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function normalizeBody(body: string): string {
  // sha1 over normalized body — strips whitespace edges and collapses
  // internal runs so a one-newline difference doesn't fool the dedup.
  return body.trim().replace(/\s+/g, ' ');
}

function bodyHash(body: string): string {
  return createHash('sha1').update(normalizeBody(body)).digest('hex');
}

/** Local-midnight epoch for "today". Per-day caps reset here. */
function todayMidnightSec(now: Date = new Date()): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return Math.floor(d.getTime() / 1000);
}

// ─────────────────── Audit log ───────────────────

function recordDecision(
  db: Database,
  args: {
    draft_id: string | null;
    decision: PublishDecision;
    reason?: string | null;
    platform_post_id?: string | null;
  },
): void {
  db.query<unknown, [string | null, PublishDecision, string | null, string | null, number]>(
    `INSERT INTO presence_publish_log (draft_id, decision, reason, platform_post_id, at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    args.draft_id,
    args.decision,
    (args.reason ?? null)?.slice(0, 500) ?? null,
    args.platform_post_id ?? null,
    nowSec(),
  );
}

// ─────────────────── Rails ───────────────────

/** Inside one of the user's allowed weekday + hour slots. */
export function isWithinPublishWindow(
  settings: Settings,
  now: Date = new Date(),
): { ok: true } | { ok: false; reason: string } {
  const day = now.getDay(); // 0=Sun..6=Sat — matches Date#getDay
  const hour = now.getHours();
  const allowedDays = settings.presence.publishDays;
  if (!allowedDays.includes(day)) {
    return {
      ok: false,
      reason: `day=${day} not in publishDays=[${allowedDays.join(',')}]`,
    };
  }
  const start = settings.presence.publishWindowStartHour;
  const end = settings.presence.publishWindowEndHour;
  if (hour < start || hour >= end) {
    return {
      ok: false,
      reason: `hour=${hour} outside window=${start}..${end}`,
    };
  }
  return { ok: true };
}

/** True iff the user's daily cap for that platform is already used up. */
export function dailyCapHit(
  db: Database,
  platform: 'x' | 'reddit',
  cap: number,
): { hit: boolean; postedToday: number; cap: number } {
  if (cap <= 0) return { hit: true, postedToday: 0, cap };
  const sinceMidnight = todayMidnightSec();
  const row = db
    .query<{ n: number }, [string, number]>(
      `SELECT COUNT(*) AS n
         FROM presence_drafts
        WHERE platform = ?
          AND status = 'posted'
          AND posted_at >= ?`,
    )
    .get(platform, sinceMidnight);
  const postedToday = row?.n ?? 0;
  return { hit: postedToday >= cap, postedToday, cap };
}

/** True iff a draft from the same source was posted within cooldown. */
export function inCooldown(
  db: Database,
  sourceId: string,
  cooldownHours: number,
): { in_cooldown: boolean; last_posted_at: number | null } {
  if (cooldownHours <= 0) return { in_cooldown: false, last_posted_at: null };
  const cutoff = nowSec() - Math.round(cooldownHours * 3600);
  const row = db
    .query<{ posted_at: number | null }, [string, number]>(
      `SELECT MAX(posted_at) AS posted_at
         FROM presence_drafts
        WHERE source_id = ?
          AND status = 'posted'
          AND posted_at IS NOT NULL
          AND posted_at >= ?`,
    )
    .get(sourceId, cutoff);
  const last = row?.posted_at ?? null;
  return { in_cooldown: last != null, last_posted_at: last };
}

/** Has the same body been posted in the last 7 days, on this or any platform? */
export function isRecentDuplicate(db: Database, body: string): boolean {
  const hash = bodyHash(body);
  const cutoff = nowSec() - 7 * DAY_SEC;
  // Compute hash inside SQL would force a UDF; cheaper to scan recent
  // posted drafts in JS — there are tens, not thousands.
  const rows = db
    .query<{ draft_body: string }, [number]>(
      `SELECT draft_body
         FROM presence_drafts
        WHERE status = 'posted'
          AND posted_at >= ?
        ORDER BY posted_at DESC
        LIMIT 100`,
    )
    .all(cutoff);
  for (const r of rows) {
    if (bodyHash(r.draft_body) === hash) return true;
  }
  return false;
}

// ─────────────────── Worker ───────────────────

export async function runPresencePublish(
  db: Database,
  settings: Settings,
  // Test seam — production callers omit this and the real X API is hit.
  // Tests pass `{ skipNetwork: true }` to exercise the rail logic without
  // touching the keychain or the network.
  opts: { skipNetwork?: boolean } = {},
): Promise<PublishOutcome> {
  const outcome: PublishOutcome = {
    considered: 0,
    published: 0,
    reddit_handed_off: 0,
    skipped: 0,
    failed: 0,
    decisions: [],
  };

  const mode = settings.presence.publishMode;
  if (mode === 'off') return outcome;

  const drafts = listDrafts(db, { statuses: ['approved'], limit: 50 });
  outcome.considered = drafts.length;
  if (drafts.length === 0) return outcome;

  const window = isWithinPublishWindow(settings);
  if (!window.ok) {
    // We log ONE outside-window decision per tick (not per draft) — otherwise
    // a 50-draft backlog floods the audit log every minute the worker fires
    // outside the window. The reason carries draft_count for context.
    recordDecision(db, {
      draft_id: null,
      decision: 'skipped_window',
      reason: `${window.reason} (drafts_pending=${drafts.length})`,
    });
    outcome.skipped += drafts.length;
    return outcome;
  }

  for (const d of drafts) {
    const decision = await processDraft(db, settings, d, opts);
    outcome.decisions.push({
      draft_id: d.id,
      decision: decision.decision,
      reason: decision.reason ?? null,
    });
    if (decision.decision === 'published') outcome.published += 1;
    else if (decision.decision === 'reddit_handed_off') outcome.reddit_handed_off += 1;
    else if (decision.decision === 'failed') outcome.failed += 1;
    else outcome.skipped += 1;

    // Only sleep BETWEEN drafts that actually published (jitter applies to
    // outbound network calls, not internal skips). Cheap calls don't need
    // pacing — the platform never sees them.
    if (decision.decision === 'published') {
      const jitterMs = jitterMillis(settings.presence.publishJitterMinutes);
      if (jitterMs > 0) await new Promise((r) => setTimeout(r, jitterMs));
    }
  }

  return outcome;
}

function jitterMillis(maxMinutes: number): number {
  // Uniform random in [0, maxMinutes * 60_000). Predictable upper bound is
  // useful for the user (it caps how long a 50-draft batch can take) and
  // human-like enough at maxMinutes=10 to dodge cadence detection.
  if (maxMinutes <= 0) return 0;
  return Math.floor(Math.random() * maxMinutes * 60_000);
}

type DraftRow = ReturnType<typeof listDrafts>[number];

async function processDraft(
  db: Database,
  settings: Settings,
  d: DraftRow,
  opts: { skipNetwork?: boolean },
): Promise<{ decision: PublishDecision; reason?: string }> {
  const mode = settings.presence.publishMode;

  // Daily cap — per platform.
  const cap =
    d.platform === 'x' ? settings.presence.maxPostsPerDayX : settings.presence.maxPostsPerDayReddit;
  const capState = dailyCapHit(db, d.platform as 'x' | 'reddit', cap);
  if (capState.hit) {
    const reason = `cap=${capState.cap} reached (postedToday=${capState.postedToday})`;
    recordDecision(db, { draft_id: d.id, decision: 'skipped_rate_cap', reason });
    return { decision: 'skipped_rate_cap', reason };
  }

  // Per-source cooldown. Drafts orphaned from their source (source_id NULL,
  // shouldn't happen in practice — created with NOT NULL) skip the cooldown
  // check entirely; without a source we have no anchor for "same source
  // recently posted".
  if (d.source_id) {
    const cool = inCooldown(db, d.source_id, settings.presence.publishCooldownPerSourceHours);
    if (cool.in_cooldown) {
      const reason = `last posted ${Math.round(
        (nowSec() - (cool.last_posted_at ?? 0)) / 60,
      )}m ago < ${settings.presence.publishCooldownPerSourceHours}h cooldown`;
      recordDecision(db, { draft_id: d.id, decision: 'skipped_cooldown', reason });
      return { decision: 'skipped_cooldown', reason };
    }
  }

  // Duplicate — same body posted in last 7d.
  if (isRecentDuplicate(db, d.draft_body)) {
    recordDecision(db, {
      draft_id: d.id,
      decision: 'skipped_duplicate',
      reason: 'body sha1 matches a recently-posted draft',
    });
    return { decision: 'skipped_duplicate', reason: 'duplicate body' };
  }

  // Reddit branch — never call API; surface deeplink for the UI to use.
  // The actual publish happens when the user calls /api/presence/drafts/:id/mark-posted
  // (which transitions the draft and writes its own audit row).
  if (d.platform === 'reddit') {
    recordDecision(db, {
      draft_id: d.id,
      decision: 'reddit_handed_off',
      reason: 'auth-free deeplink path; awaiting user click + mark-posted callback',
    });
    return { decision: 'reddit_handed_off' };
  }

  // X branch — the only platform that auto-publishes via API.
  if (d.platform !== 'x') {
    // Defensive — unreachable today (only x|reddit) but the schema is
    // open-typed so future platforms must opt-in here explicitly.
    const reason = `unsupported platform=${d.platform}`;
    recordDecision(db, { draft_id: d.id, decision: 'failed', reason });
    return { decision: 'failed', reason };
  }

  if (mode === 'dry_run') {
    recordDecision(db, {
      draft_id: d.id,
      decision: 'dry_run',
      reason: `would have posted to X (${d.draft_body.length} chars)`,
    });
    return { decision: 'dry_run' };
  }

  if (opts.skipNetwork) {
    // Test path. Caller has already mocked or wants to verify the rails
    // pipeline reached the post stage; we DO NOT hit the network and
    // DO NOT transition the draft.
    return { decision: 'published', reason: '[skipNetwork] would post now' };
  }

  // ── Live publish ─────────────────────────────
  try {
    const result = await xPostTweet(d.draft_body);
    transitionDraft(db, d.id, 'posted', {
      posted_external_id: result.id,
      posted_external_url: `https://x.com/i/web/status/${result.id}`,
    });
    recordDecision(db, {
      draft_id: d.id,
      decision: 'published',
      reason: `tweet id=${result.id}`,
      platform_post_id: result.id,
    });
    return { decision: 'published' };
  } catch (error) {
    const reason = String(error).slice(0, 500);
    recordDecision(db, { draft_id: d.id, decision: 'failed', reason });
    return { decision: 'failed', reason };
  }
}

// ─────────────────── Audit log read ───────────────────

export type PublishLogRow = {
  id: number;
  draft_id: string | null;
  decision: PublishDecision;
  reason: string | null;
  platform_post_id: string | null;
  at: number;
};

export function listPublishLog(
  db: Database,
  opts: { limit?: number; draftId?: string } = {},
): PublishLogRow[] {
  const limit = Math.min(500, Math.max(1, opts.limit ?? 100));
  if (opts.draftId) {
    return db
      .query<PublishLogRow, [string, number]>(
        `SELECT id, draft_id, decision, reason, platform_post_id, at
           FROM presence_publish_log
          WHERE draft_id = ?
          ORDER BY at DESC
          LIMIT ?`,
      )
      .all(opts.draftId, limit);
  }
  return db
    .query<PublishLogRow, [number]>(
      `SELECT id, draft_id, decision, reason, platform_post_id, at
         FROM presence_publish_log
        ORDER BY at DESC
        LIMIT ?`,
    )
    .all(limit);
}

/**
 * Record a manual `published` row when the user posts a Reddit draft via
 * the deeplink (no API → no automatic transition possible). Called from
 * the `/drafts/:id/mark-posted` route AFTER `transitionDraft(..., 'posted')`
 * so the draft + audit log stay consistent.
 */
export function recordManualPublish(
  db: Database,
  draftId: string,
  platform_post_id: string | null,
  reason: string | null = 'user clicked Mark Posted after deeplink',
): void {
  recordDecision(db, {
    draft_id: draftId,
    decision: 'published',
    reason,
    platform_post_id,
  });
}
