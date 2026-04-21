export const version = 8;

/**
 * Daily npm download snapshots. Populated from the npm range API
 * (https://api.npmjs.org/downloads/range/{start}:{end}/{pkg}) up to 365 days
 * of history per package. Lets us compute a meaningful local cumul since npm
 * does not expose an all-time total on the free API.
 */
export const sql = `
CREATE TABLE IF NOT EXISTS npm_downloads_daily (
  repo_name  TEXT NOT NULL,
  date       TEXT NOT NULL,
  downloads  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (repo_name, date),
  FOREIGN KEY (repo_name) REFERENCES github_repos(name) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_npm_daily_repo ON npm_downloads_daily(repo_name);
CREATE INDEX IF NOT EXISTS idx_npm_daily_date ON npm_downloads_daily(date DESC);
`;
