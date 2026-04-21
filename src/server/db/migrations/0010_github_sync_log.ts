export const version = 10;

/**
 * Persistent audit log for GitHub + npm data refreshes.
 * Each row records one sync attempt: kind (repos/traffic/heatmap/npm),
 * trigger (manual/auto/background), outcome (ok/no-change/partial/error),
 * duration, and a JSON summary (delta counts or error message).
 *
 * Capped to 500 rows by a post-insert delete in recordSyncEvent (not a trigger,
 * to keep the migration cheap and readable). Queried descending by id.
 */
export const sql = `
CREATE TABLE IF NOT EXISTS github_sync_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  at          INTEGER NOT NULL,
  kind        TEXT NOT NULL,
  trigger     TEXT NOT NULL,
  status      TEXT NOT NULL,
  duration_ms INTEGER,
  summary_json TEXT
);

CREATE INDEX IF NOT EXISTS idx_github_sync_log_at ON github_sync_log(at DESC);
`;
