export const version = 3;

// Column semantics by source (IMPORTANT: read before touching):
//   - input_tokens : Claude = non-cached input billed normally.
//                    Codex  = inputNet (raw - cached_input).
//                    i.e. in BOTH cases, "fresh input tokens".
//   - cache_create : Claude = tokens written to cache.
//                    Codex  = always 0 (no cache-write concept).
//   - cache_read   : Claude = tokens read from cache.
//                    Codex  = cached_input_tokens (input billed at cached rate).
//                    Semantically equivalent concept (input reused from a cache),
//                    so summing this column across sources is meaningful.
//   - output_tokens: Codex folds reasoning_output into this (we lose the split here).
//   - messages     : Claude = assistant messages. Codex = turns.
// Keep queries aware: per-source aggregation is safe, cross-source sums on
// cache_read are meaningful, but cost_usd already encodes the per-source rate
// so do NOT re-derive costs from the token columns without source context.
export const sql = `
CREATE TABLE IF NOT EXISTS usage_daily_by_project (
  date           TEXT NOT NULL,         -- YYYY-MM-DD (UTC)
  project_key    TEXT NOT NULL,
  source         TEXT NOT NULL,         -- 'claude' | 'codex'
  project_path   TEXT,
  project_id     TEXT,
  project_name   TEXT,
  input_tokens   INTEGER NOT NULL DEFAULT 0,
  output_tokens  INTEGER NOT NULL DEFAULT 0,
  cache_create   INTEGER NOT NULL DEFAULT 0,
  cache_read     INTEGER NOT NULL DEFAULT 0,
  total_tokens   INTEGER NOT NULL DEFAULT 0,
  messages       INTEGER NOT NULL DEFAULT 0,
  sessions       INTEGER NOT NULL DEFAULT 0,
  cost_usd       REAL    NOT NULL DEFAULT 0,
  models_json    TEXT,
  tools_json     TEXT,
  synced_at      INTEGER NOT NULL,
  PRIMARY KEY (date, project_key, source)
);
CREATE INDEX IF NOT EXISTS idx_udbp_project_key ON usage_daily_by_project(project_key);
CREATE INDEX IF NOT EXISTS idx_udbp_date ON usage_daily_by_project(date);
CREATE INDEX IF NOT EXISTS idx_udbp_source_date ON usage_daily_by_project(source, date);
`;
