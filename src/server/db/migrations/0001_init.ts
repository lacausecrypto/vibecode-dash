export const version = 1;

export const sql = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS projects (
  id              TEXT PRIMARY KEY,
  path            TEXT UNIQUE NOT NULL,
  name            TEXT NOT NULL,
  type            TEXT,
  description     TEXT,
  readme_path     TEXT,
  last_modified   INTEGER NOT NULL,
  git_branch      TEXT,
  git_remote      TEXT,
  last_commit_at  INTEGER,
  uncommitted     INTEGER DEFAULT 0,
  loc             INTEGER,
  languages_json  TEXT,
  health_score    INTEGER DEFAULT 0,
  scanned_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_projects_last_commit ON projects(last_commit_at DESC);
CREATE INDEX IF NOT EXISTS idx_projects_health ON projects(health_score DESC);

CREATE TABLE IF NOT EXISTS github_contributions (
  date        TEXT PRIMARY KEY,
  count       INTEGER NOT NULL,
  color       TEXT,
  synced_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS github_repos (
  name           TEXT PRIMARY KEY,
  description    TEXT,
  url            TEXT,
  stars          INTEGER DEFAULT 0,
  forks          INTEGER DEFAULT 0,
  primary_lang   TEXT,
  languages_json TEXT,
  topics_json    TEXT,
  pushed_at      INTEGER,
  is_fork        INTEGER DEFAULT 0,
  synced_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS github_commits (
  sha        TEXT PRIMARY KEY,
  repo       TEXT NOT NULL,
  date       INTEGER NOT NULL,
  message    TEXT,
  additions  INTEGER,
  deletions  INTEGER,
  FOREIGN KEY (repo) REFERENCES github_repos(name)
);
CREATE INDEX IF NOT EXISTS idx_commits_date ON github_commits(date DESC);

CREATE TABLE IF NOT EXISTS github_repo_traffic_daily (
  repo             TEXT NOT NULL,
  date             TEXT NOT NULL,
  views_count      INTEGER DEFAULT 0,
  views_uniques    INTEGER DEFAULT 0,
  clones_count     INTEGER DEFAULT 0,
  clones_uniques   INTEGER DEFAULT 0,
  synced_at        INTEGER NOT NULL,
  PRIMARY KEY (repo, date),
  FOREIGN KEY (repo) REFERENCES github_repos(name) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_github_repo_traffic_repo ON github_repo_traffic_daily(repo);
CREATE INDEX IF NOT EXISTS idx_github_repo_traffic_date ON github_repo_traffic_daily(date DESC);

CREATE TABLE IF NOT EXISTS obsidian_notes (
  path             TEXT PRIMARY KEY,
  title            TEXT,
  tags_json        TEXT,
  frontmatter_json TEXT,
  modified         INTEGER NOT NULL,
  size             INTEGER,
  indexed_at       INTEGER NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS obsidian_notes_fts USING fts5(
  path,
  title,
  body
);

CREATE TABLE IF NOT EXISTS obsidian_links (
  src         TEXT NOT NULL,
  dst         TEXT NOT NULL,
  display     TEXT,
  PRIMARY KEY (src, dst),
  FOREIGN KEY (src) REFERENCES obsidian_notes(path)
);
CREATE INDEX IF NOT EXISTS idx_links_dst ON obsidian_links(dst);

CREATE TABLE IF NOT EXISTS usage_daily (
  date            TEXT PRIMARY KEY,
  input_tokens    INTEGER DEFAULT 0,
  output_tokens   INTEGER DEFAULT 0,
  cache_create    INTEGER DEFAULT 0,
  cache_read      INTEGER DEFAULT 0,
  cost_usd        REAL DEFAULT 0,
  models_json     TEXT,
  source          TEXT NOT NULL,
  synced_at       INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS usage_by_project (
  date          TEXT NOT NULL,
  project       TEXT NOT NULL,
  input_tokens  INTEGER,
  output_tokens INTEGER,
  cache_create  INTEGER,
  cache_read    INTEGER,
  cost_usd      REAL,
  tool_usage_json TEXT,
  PRIMARY KEY (date, project)
);

CREATE TABLE IF NOT EXISTS usage_hourly (
  hour         INTEGER PRIMARY KEY,
  tokens       INTEGER DEFAULT 0,
  messages     INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS usage_codex_daily (
  date                      TEXT PRIMARY KEY,
  input_tokens              INTEGER DEFAULT 0,
  cached_input_tokens       INTEGER DEFAULT 0,
  output_tokens             INTEGER DEFAULT 0,
  reasoning_output_tokens   INTEGER DEFAULT 0,
  total_tokens              INTEGER DEFAULT 0,
  cost_usd                  REAL DEFAULT 0,
  models_json               TEXT,
  synced_at                 INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_sessions (
  id             TEXT PRIMARY KEY,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  model          TEXT,
  title          TEXT,
  context_json   TEXT,
  archived       INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS agent_messages (
  id             TEXT PRIMARY KEY,
  session_id     TEXT NOT NULL,
  role           TEXT NOT NULL,
  content        TEXT,
  tool_calls_json TEXT,
  ts             INTEGER NOT NULL,
  FOREIGN KEY (session_id) REFERENCES agent_sessions(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_agent_messages_session ON agent_messages(session_id, ts);

CREATE TABLE IF NOT EXISTS competitors (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL,
  name            TEXT NOT NULL,
  url             TEXT,
  pitch           TEXT,
  strengths_json  TEXT,
  weaknesses_json TEXT,
  features_json   TEXT,
  last_seen       INTEGER NOT NULL,
  discovered_at   INTEGER NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_competitors_project ON competitors(project_id);

CREATE TABLE IF NOT EXISTS insights (
  id                     TEXT PRIMARY KEY,
  type                   TEXT NOT NULL,
  title                  TEXT NOT NULL,
  body                   TEXT,
  related_projects_json  TEXT,
  related_notes_json     TEXT,
  meta_json              TEXT,
  created_at             INTEGER NOT NULL,
  status                 TEXT DEFAULT 'pending',
  explored_at            INTEGER
);
CREATE INDEX IF NOT EXISTS idx_insights_status ON insights(status, created_at DESC);

CREATE TABLE IF NOT EXISTS embeddings (
  id          TEXT PRIMARY KEY,
  source      TEXT NOT NULL,
  ref_id      TEXT NOT NULL,
  vec         BLOB NOT NULL,
  dim         INTEGER NOT NULL,
  model       TEXT NOT NULL,
  computed_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS kv (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS schema_migrations (
  version     INTEGER PRIMARY KEY,
  applied_at  INTEGER NOT NULL
);
`;
