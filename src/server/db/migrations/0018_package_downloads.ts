export const version = 18;

/**
 * Generic per-registry package download tracking.
 *
 * The dashboard already tracks npm download stats via the dedicated
 * `npm_downloads` + `npm_downloads_daily` tables. This migration adds
 * a registry-aware twin so PyPI, crates.io and any future registry can
 * be tracked with the SAME shape, without duplicating per-registry
 * tables (one schema → one set of fetchers → one query path).
 *
 * `registry` is an open string at the SQL level (no CHECK constraint)
 * but in code it MUST match the `Registry` enum in
 * src/server/lib/packageDownloads.ts. Adding a new registry only needs
 * a new adapter file + the enum widening; no schema migration.
 *
 * Coexistence with npm_downloads:
 *   The legacy `npm_downloads` + `npm_downloads_daily` tables stay
 *   intact for now. New registries (pypi, crates) only write into the
 *   generic tables below. A future migration can backfill npm into
 *   `package_downloads*` and drop the legacy pair; not in scope here
 *   to avoid touching code paths that already work.
 *
 * Indexes match the dominant query shapes:
 *   - "all packages for a repo, all registries" → (repo_name)
 *   - "downloads for a specific (registry, repo) over a date window"
 *     → composite (registry, repo_name, date) covered by the PK.
 *   - "daily totals across registries for a date range" → (date).
 */
export const sql = `
CREATE TABLE IF NOT EXISTS package_downloads (
  registry      TEXT NOT NULL,
  repo_name     TEXT NOT NULL,
  package_name  TEXT,
  last_day      INTEGER NOT NULL DEFAULT 0,
  last_week     INTEGER NOT NULL DEFAULT 0,
  last_month    INTEGER NOT NULL DEFAULT 0,
  not_found     INTEGER NOT NULL DEFAULT 0,
  fetched_at    INTEGER NOT NULL,
  PRIMARY KEY (registry, repo_name),
  FOREIGN KEY (repo_name) REFERENCES github_repos(name) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_package_downloads_repo
  ON package_downloads(repo_name);

CREATE TABLE IF NOT EXISTS package_downloads_daily (
  registry      TEXT NOT NULL,
  repo_name     TEXT NOT NULL,
  date          TEXT NOT NULL,
  downloads     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (registry, repo_name, date),
  FOREIGN KEY (repo_name) REFERENCES github_repos(name) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_package_daily_date
  ON package_downloads_daily(date DESC);

CREATE INDEX IF NOT EXISTS idx_package_daily_repo
  ON package_downloads_daily(repo_name);
`;
