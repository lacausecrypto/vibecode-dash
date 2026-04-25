export const version = 15;

/**
 * Pack B — Source health diagnostics (V4 source-intelligence)
 *
 * Adds three columns to `presence_sources` so the UI can colour-code each
 * source by its current ROI band, and so the user can filter the Sources
 * table to "show me only the noisy / dead / stale ones" without running
 * a query in their head.
 *
 *   - `health_status` : enum-like text. Values:
 *       NULL          → never classified yet
 *       'never_scanned' → no scan ever attempted on this source
 *       'unscored'    → too young or not enough data to classify (warm-up)
 *       'pristine'    → 1+ posted in 30d, low edit_ratio (< 0.4)
 *       'workhorse'   → 3+ posted in 30d AND low edit_ratio (top performer)
 *       'noisy'       → 5+ proposed in 30d but high edit_ratio (> 0.6)
 *       'stale'       → had posts in 30-60d window, 0 in last 14d (lost steam)
 *       'dead'        → scanned recently, 0 candidates produced; also forced
 *                       when validation_status confirms platform-side death
 *
 *   - `health_snapshot_at` : unix seconds of the last classification run.
 *     Lets the UI surface "checked 2h ago" and the daily cron decide whether
 *     to recompute (idempotent re-runs are cheap but skipping when fresh
 *     keeps the table quiet).
 *
 *   - `health_metrics_json` : the raw counts that drove the label, stored
 *     as JSON. Lets the UI tooltip explain ("2 posted, 0.32 avg edit ratio,
 *     last scanned 18 min ago") without re-running the SQL.
 *
 * Backward compat: existing rows have NULL on all three; the daily refresh
 * (or the manual /sources/refresh-health endpoint) backfills them.
 */

export const sql = `
ALTER TABLE presence_sources ADD COLUMN health_status TEXT;
ALTER TABLE presence_sources ADD COLUMN health_snapshot_at INTEGER;
ALTER TABLE presence_sources ADD COLUMN health_metrics_json TEXT;

CREATE INDEX IF NOT EXISTS idx_presence_sources_health
  ON presence_sources(health_status);
`;
