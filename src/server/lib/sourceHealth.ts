import type { Database } from 'bun:sqlite';
import type { SourceHealthStatus } from './presence';

/**
 * Pack B — Source health diagnostics
 *
 * Classifies each source into one of seven ROI bands based on the last 30/60
 * days of activity. The classification is fully deterministic from the
 * draft + event tables (no LLM, no external calls), so the daily refresh
 * is essentially free and the result is the same whether it runs now or
 * tomorrow.
 *
 * Why this exists: with 40+ sources, the user can't tell at a glance which
 * ones are pulling their weight versus burning the X PAYG quota for nothing.
 * The seven bands map cleanly to UI colour bands and to the V4 Pack C
 * "auto-prune assistant" that proposes deactivation candidates.
 *
 * Rule precedence (first matching wins):
 *   1. Validation override : if validation_status confirms platform-side
 *      death, force 'dead' regardless of activity.
 *   2. never_scanned : last_scanned_at IS NULL.
 *   3. workhorse : posted_30d >= 3 and avg_edit_ratio < 0.4 (or unknown).
 *   4. pristine  : posted_30d >= 1 and avg_edit_ratio < 0.4 (or unknown).
 *   5. noisy     : proposed_30d > 5 and avg_edit_ratio > 0.6.
 *   6. dead      : scanned within 7d, drafts_30d == 0, source older than 7d.
 *   7. stale     : posted_60d > 0 but posted_14d == 0.
 *   8. unscored  : default fallback (warming up, mixed signals).
 */

export type SourceHealthMetrics = {
  /** Drafts created in the last 30 days for this source. */
  drafts_30d: number;
  /** Posted drafts in the last 30 days. */
  posted_30d: number;
  /** Posted drafts in the last 14 days. */
  posted_14d: number;
  /** Posted drafts in the 30..60 day window (used for stale detection). */
  posted_30_60d: number;
  /** Proposed drafts (any state) in the last 30 days. */
  proposed_30d: number;
  /** Average edit_ratio across edited events on this source's drafts (30d). */
  avg_edit_ratio: number | null;
  /** Last scan timestamp from the source row, copied for the tooltip. */
  last_scanned_at: number | null;
  /** Validation status copied for the tooltip. */
  validation_status: string | null;
};

type SourceForHealth = {
  id: string;
  added_at: number;
  last_scanned_at: number | null;
  validation_status: string | null;
};

type DraftCountsRow = {
  source_id: string;
  drafts_30d: number;
  posted_30d: number;
  posted_14d: number;
  posted_30_60d: number;
  proposed_30d: number;
};

type EditRatioRow = {
  source_id: string;
  avg_edit_ratio: number | null;
};

const DAY = 86400;

function classify(
  source: SourceForHealth,
  m: SourceHealthMetrics,
  now: number,
): SourceHealthStatus {
  // Rule 1 — validation override. A source the platform reports as dead
  // stays 'dead' even if it had posts before; we can't reach it anymore.
  if (
    m.validation_status === 'not_found' ||
    m.validation_status === 'banned' ||
    m.validation_status === 'invalid_format'
  ) {
    return 'dead';
  }

  // Rule 2 — never scanned: trivial, no signal to work with.
  if (m.last_scanned_at == null) return 'never_scanned';

  // Rule 3-4 — performers. We treat unknown edit_ratio (no edits captured
  // yet) as healthy by default; it only becomes a noise signal when there's
  // enough edit data to make a judgement.
  const editKnown = m.avg_edit_ratio != null;
  const editLow = !editKnown || (m.avg_edit_ratio as number) < 0.4;
  const editHigh = editKnown && (m.avg_edit_ratio as number) > 0.6;

  if (m.posted_30d >= 3 && editLow) return 'workhorse';
  if (m.posted_30d >= 1 && editLow) return 'pristine';

  // Rule 5 — noisy: produces lots of proposed but you rewrite heavily.
  if (m.proposed_30d > 5 && editHigh) return 'noisy';

  // Rule 6 — dead: scanned recently, returned nothing (and source has had
  // time to accumulate signal — skip the rule for fresh sources < 7d old).
  const ageDays = (now - source.added_at) / DAY;
  const scanRecent = m.last_scanned_at != null && now - m.last_scanned_at < 7 * DAY;
  if (scanRecent && m.drafts_30d === 0 && ageDays > 7) return 'dead';

  // Rule 7 — stale: was producing 30-60 days ago, nothing in last 14d.
  if (m.posted_30_60d > 0 && m.posted_14d === 0) return 'stale';

  // Rule 8 — fallback: warming up or mixed.
  return 'unscored';
}

export type ClassifiedSource = {
  source_id: string;
  health_status: SourceHealthStatus;
  metrics: SourceHealthMetrics;
};

export type RefreshHealthOutcome = {
  total: number;
  by_status: Record<SourceHealthStatus, number>;
  classified: ClassifiedSource[];
};

/**
 * One-shot classification + persistence pass over every source. Pulls the
 * draft counts and edit-ratio averages in two batched SQL queries (cheap),
 * then computes the label per source in TS and writes back to the row.
 */
export function refreshAllSourceHealth(db: Database): RefreshHealthOutcome {
  const now = Math.floor(Date.now() / 1000);
  const since30 = now - 30 * DAY;
  const since14 = now - 14 * DAY;
  const since60 = now - 60 * DAY;

  const sources = db
    .query<SourceForHealth, []>(
      'SELECT id, added_at, last_scanned_at, validation_status FROM presence_sources',
    )
    .all();

  const counts = new Map<string, DraftCountsRow>();
  for (const row of db
    .query<DraftCountsRow, [number, number, number, number, number, number]>(
      `SELECT source_id,
              COALESCE(SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END), 0) AS drafts_30d,
              COALESCE(SUM(CASE WHEN status = 'posted' AND posted_at >= ? THEN 1 ELSE 0 END), 0) AS posted_30d,
              COALESCE(SUM(CASE WHEN status = 'posted' AND posted_at >= ? THEN 1 ELSE 0 END), 0) AS posted_14d,
              COALESCE(SUM(CASE WHEN status = 'posted' AND posted_at >= ? AND posted_at < ? THEN 1 ELSE 0 END), 0) AS posted_30_60d,
              COALESCE(SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END), 0) AS proposed_30d
         FROM presence_drafts
        WHERE source_id IS NOT NULL
        GROUP BY source_id`,
    )
    .all(since30, since30, since14, since60, since30, since30)) {
    counts.set(row.source_id, row);
  }

  const editRatios = new Map<string, number>();
  for (const row of db
    .query<EditRatioRow, [number]>(
      `SELECT d.source_id,
              AVG(CAST(json_extract(ev.payload_json, '$.edit_ratio') AS REAL)) AS avg_edit_ratio
         FROM presence_drafts d
         JOIN presence_draft_events ev ON ev.draft_id = d.id AND ev.event_type = 'edited'
        WHERE d.source_id IS NOT NULL
          AND d.created_at >= ?
          AND ev.payload_json IS NOT NULL
          AND json_extract(ev.payload_json, '$.edit_ratio') IS NOT NULL
        GROUP BY d.source_id`,
    )
    .all(since30)) {
    if (row.avg_edit_ratio != null) editRatios.set(row.source_id, row.avg_edit_ratio);
  }

  const update = db.query<unknown, [string, number, string, string]>(
    `UPDATE presence_sources
        SET health_status = ?,
            health_snapshot_at = ?,
            health_metrics_json = ?
      WHERE id = ?`,
  );

  const outcome: RefreshHealthOutcome = {
    total: sources.length,
    by_status: {
      never_scanned: 0,
      unscored: 0,
      pristine: 0,
      workhorse: 0,
      noisy: 0,
      stale: 0,
      dead: 0,
    },
    classified: [],
  };

  const tx = db.transaction(() => {
    for (const s of sources) {
      const c = counts.get(s.id);
      const metrics: SourceHealthMetrics = {
        drafts_30d: c?.drafts_30d ?? 0,
        posted_30d: c?.posted_30d ?? 0,
        posted_14d: c?.posted_14d ?? 0,
        posted_30_60d: c?.posted_30_60d ?? 0,
        proposed_30d: c?.proposed_30d ?? 0,
        avg_edit_ratio: editRatios.get(s.id) ?? null,
        last_scanned_at: s.last_scanned_at,
        validation_status: s.validation_status,
      };
      const health = classify(s, metrics, now);
      update.run(health, now, JSON.stringify(metrics), s.id);
      outcome.by_status[health] += 1;
      outcome.classified.push({ source_id: s.id, health_status: health, metrics });
    }
  });
  tx();

  return outcome;
}
