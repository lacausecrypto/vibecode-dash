export const version = 12;

/**
 * Reliability cleanup (R13/R14/R15 from the data-reliability audit).
 *
 * R13 — add composite index (source, project_id, date) on usage_daily_by_project.
 *   Existing indexes cover (project_key), (date), (source, date) but not the
 *   common filter pattern `WHERE source=? AND project_id=?`, which scans the
 *   (source, date) index entirely.
 *
 * R14 — drop zombie tables never read nor written:
 *   - usage_hourly: created in 0001, never touched.
 *   - embeddings: created in 0001, never touched.
 *   Keeping them pollutes schema inspection and tempts future writers to
 *   reuse half-baked structures.
 *
 * R15 — add ON DELETE CASCADE to github_commits.repo FK.
 *   SQLite doesn't support ALTER TABLE ADD CONSTRAINT or modifying FK, so we
 *   must rebuild: CREATE new → copy rows → DROP old → RENAME. Wrapped in the
 *   runMigrations transaction so partial failure rolls back cleanly.
 */
export const sql = `
CREATE INDEX IF NOT EXISTS idx_udbp_source_project_date
  ON usage_daily_by_project(source, project_id, date);

DROP TABLE IF EXISTS usage_hourly;
DROP TABLE IF EXISTS embeddings;

CREATE TABLE IF NOT EXISTS github_commits_new (
  sha        TEXT PRIMARY KEY,
  repo       TEXT NOT NULL,
  date       INTEGER NOT NULL,
  message    TEXT,
  additions  INTEGER,
  deletions  INTEGER,
  FOREIGN KEY (repo) REFERENCES github_repos(name) ON DELETE CASCADE
);

INSERT OR IGNORE INTO github_commits_new (sha, repo, date, message, additions, deletions)
  SELECT sha, repo, date, message, additions, deletions FROM github_commits;

DROP TABLE github_commits;
ALTER TABLE github_commits_new RENAME TO github_commits;
CREATE INDEX IF NOT EXISTS idx_commits_date ON github_commits(date DESC);
CREATE INDEX IF NOT EXISTS idx_commits_repo_date ON github_commits(repo, date DESC);
`;
