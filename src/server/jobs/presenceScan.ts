import type { Database } from 'bun:sqlite';
import type { Settings } from '../config';
import { type PresencePlatform, type PresenceSourceRow, listSources } from '../lib/presence';
import { type RedditScanOutcome, scanRedditSource } from '../scanners/presenceReddit';
import { type XScanOutcome, scanXSource } from '../scanners/presenceX';

/**
 * Dispatcher that walks every active source and runs the platform-specific
 * scanner. Called by the scheduler on `presenceScanMinutes` cadence and by
 * the "scan now" button from the UI.
 *
 * Errors are isolated per source: one broken Reddit source cannot stop an
 * X scan from running, and vice-versa. The returned outcome lists one row
 * per attempted source — the UI surfaces it as a transient "last run" chip.
 */

export type PresenceScanOutcome = {
  reddit: RedditScanOutcome[];
  x: XScanOutcome[];
  started_at: number;
  finished_at: number;
  total_drafts_created: number;
  total_cost_usd: number;
  /** Sources skipped because they were scanned within their freshness TTL. */
  skipped_ttl: number;
  /** True when the scan stopped early because the daily budget was hit. */
  budget_exceeded: boolean;
};

/**
 * Decide which sources are eligible to scan right now.
 *
 * Two filters compose:
 *   - Caller filters: onlyPlatform / onlySourceId for narrow runs.
 *   - TTL gate: a source is eligible iff (now - last_scanned_at) is at least
 *     its freshness_ttl_minutes, OR it has never been scanned. This is what
 *     keeps the X PAYG bill bounded — without the gate, the scheduler firing
 *     every 45 min would re-scan every source even when its TTL is 4 h.
 *
 * `bypassTtl: true` (used by the manual "Scan now" button) skips the TTL
 * filter entirely so the user can force a refresh whenever they want.
 */
function eligibleSources(
  sources: PresenceSourceRow[],
  opts: {
    onlyPlatform?: PresencePlatform;
    onlySourceId?: string;
    bypassTtl?: boolean;
  },
): { eligible: PresenceSourceRow[]; skipped_ttl: number } {
  const now = Math.floor(Date.now() / 1000);
  let skipped_ttl = 0;
  const eligible = sources.filter((s) => {
    if (opts.onlyPlatform && s.platform !== opts.onlyPlatform) return false;
    if (opts.onlySourceId && s.id !== opts.onlySourceId) return false;
    if (opts.bypassTtl) return true;
    if (!s.last_scanned_at) return true; // never scanned → always eligible
    const ageMin = (now - s.last_scanned_at) / 60;
    if (ageMin >= s.freshness_ttl_minutes) return true;
    skipped_ttl += 1;
    return false;
  });
  return { eligible, skipped_ttl };
}

/**
 * Sum cost-ledger entries for the current local day. Used by the budget cap
 * to abort scans before we burn past the user's threshold. Reddit reads are
 * free in both modes so they don't count; X scan + image_gen are the only
 * line items that meaningfully accumulate.
 */
function todaySpendUsd(db: Database): number {
  // Today = midnight local. SQLite's `unixepoch('now', 'start of day', 'localtime')`
  // returns it directly. Cheap aggregate (indexed on `at`).
  const row = db
    .query<{ total: number | null }, []>(
      `SELECT SUM(total_usd) AS total
         FROM presence_cost_ledger
        WHERE at >= unixepoch('now', 'start of day', 'localtime')`,
    )
    .get();
  return row?.total ?? 0;
}

export async function runPresenceScan(
  db: Database,
  settings: Settings,
  opts: {
    onlyPlatform?: PresencePlatform;
    onlySourceId?: string;
    /** Skip the per-source TTL gate. Set true for manual "Scan now" UI clicks. */
    bypassTtl?: boolean;
  } = {},
): Promise<PresenceScanOutcome> {
  const started_at = Math.floor(Date.now() / 1000);

  // Daily budget gate. We check BEFORE running anything; if today's spend is
  // already past the cap, abort with an empty outcome and a clear flag so
  // the UI can surface "budget exceeded — increase cap or wait until tomorrow".
  const cap = settings.presence?.dailyBudgetUsd ?? 0;
  if (cap > 0 && todaySpendUsd(db) >= cap) {
    return {
      reddit: [],
      x: [],
      started_at,
      finished_at: started_at,
      total_drafts_created: 0,
      total_cost_usd: 0,
      skipped_ttl: 0,
      budget_exceeded: true,
    };
  }

  const sources = listSources(db, { activeOnly: true });
  const { eligible: redditSources, skipped_ttl: redditSkipped } = eligibleSources(
    sources.filter((s) => s.platform === 'reddit'),
    opts,
  );
  const { eligible: xSources, skipped_ttl: xSkipped } = eligibleSources(
    sources.filter((s) => s.platform === 'x'),
    opts,
  );

  // Sequential per platform; parallel across the two. Sequential inside a
  // platform because both scanners share rate limits on the same API key.
  const [redditOutcomes, xOutcomes] = await Promise.all([
    runSequential(redditSources, (src) => scanRedditSource(db, settings, src)),
    runSequential(xSources, (src) => scanXSource(db, settings, src)),
  ]);

  const finished_at = Math.floor(Date.now() / 1000);
  const total_drafts_created =
    redditOutcomes.reduce((n, o) => n + o.drafts_created, 0) +
    xOutcomes.reduce((n, o) => n + o.drafts_created, 0);
  const total_cost_usd = xOutcomes.reduce((n, o) => n + o.cost_usd, 0);

  return {
    reddit: redditOutcomes,
    x: xOutcomes,
    started_at,
    finished_at,
    total_drafts_created,
    total_cost_usd,
    skipped_ttl: redditSkipped + xSkipped,
    budget_exceeded: false,
  };
}

async function runSequential<S, O>(items: S[], fn: (item: S) => Promise<O>): Promise<O[]> {
  const out: O[] = [];
  for (const item of items) {
    try {
      out.push(await fn(item));
    } catch (error) {
      console.warn('[presenceScan] source failed:', String(error));
    }
  }
  return out;
}
