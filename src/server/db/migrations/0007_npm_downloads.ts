export const version = 7;

/**
 * Track npm download counts for GitHub repos that also publish on npm.
 * We store one row per repo (not per package version): the point-in-time
 * counts from npm's downloads API, plus a `not_found` flag to cache repos
 * that aren't published and shouldn't be re-queried every refresh.
 */
export const sql = `
CREATE TABLE IF NOT EXISTS npm_downloads (
  repo_name     TEXT PRIMARY KEY,
  npm_package   TEXT,
  last_day      INTEGER DEFAULT 0,
  last_week     INTEGER DEFAULT 0,
  last_month    INTEGER DEFAULT 0,
  not_found     INTEGER DEFAULT 0,
  fetched_at    INTEGER NOT NULL,
  FOREIGN KEY (repo_name) REFERENCES github_repos(name) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_npm_downloads_fetched ON npm_downloads(fetched_at);
`;
