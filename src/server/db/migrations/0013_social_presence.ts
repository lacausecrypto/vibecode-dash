export const version = 13;

/**
 * Phase 4 — Social Presence Copilot (Reddit + X, human-in-the-loop)
 *
 * Scaffolds the data model for a drafts-feed workflow: scanners produce
 * proposals from sources (subreddits, X lists, X topic searches) that the
 * user reviews, edits, and posts from their own account. Nothing here posts
 * autonomously — every outgoing message is gated by an explicit approval.
 *
 * Design notes
 * ─────────────
 * - Drafts are never hard-deleted. Lifecycle states (proposed → viewed →
 *   approved → posted, or expired/ignored/rejected) are tracked so the
 *   stats surface can compute funnel conversion and per-source ROI even
 *   after a draft "dies" in the freshness window.
 * - Cost ledger records every external $ spent (Claude tokens, X API reads,
 *   OpenRouter image generation). Joined to drafts when applicable so the
 *   UI can surface $/draft_posted and $/engagement as first-class KPIs.
 * - Engagement metrics are polled at t+1h / t+24h / t+7d after posting.
 *   The unique index on (draft_id, snapshot_tag) makes the poller idempotent
 *   so a re-run within the window is a no-op, not a duplicate row.
 * - Thread uniqueness (platform, external_thread_id) is enforced via a
 *   partial unique index so the scanner can safely resubmit what it sees
 *   without producing duplicate drafts for the same tweet/post.
 * - Platform OAuth tokens live in macOS Keychain, not in SQLite. The
 *   `presence_platform_connections` row only holds the Keychain reference
 *   and metadata (account handle, scopes, rate-limit state).
 */
export const sql = `
CREATE TABLE IF NOT EXISTS presence_sources (
  id                     TEXT PRIMARY KEY,
  platform               TEXT NOT NULL,
  kind                   TEXT NOT NULL,
  identifier             TEXT NOT NULL,
  label                  TEXT,
  weight                 REAL NOT NULL DEFAULT 1.0,
  freshness_ttl_minutes  INTEGER NOT NULL DEFAULT 240,
  active                 INTEGER NOT NULL DEFAULT 1,
  last_since_id          TEXT,
  last_scanned_at        INTEGER,
  last_scan_status       TEXT,
  added_at               INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_presence_sources_pki
  ON presence_sources(platform, kind, LOWER(identifier));
CREATE INDEX IF NOT EXISTS idx_presence_sources_active
  ON presence_sources(active, platform);

CREATE TABLE IF NOT EXISTS presence_drafts (
  id                     TEXT PRIMARY KEY,
  platform               TEXT NOT NULL,
  source_id              TEXT REFERENCES presence_sources(id) ON DELETE SET NULL,
  external_thread_id     TEXT,
  external_thread_url    TEXT,
  thread_snapshot_json   TEXT NOT NULL,
  format                 TEXT NOT NULL,
  relevance_score        REAL NOT NULL,
  freshness_expires_at   INTEGER NOT NULL,
  draft_body             TEXT NOT NULL,
  draft_rationale        TEXT,
  vault_citations_json   TEXT,
  radar_insight_ids_json TEXT,
  image_plan_json        TEXT,
  status                 TEXT NOT NULL DEFAULT 'proposed',
  posted_external_id     TEXT,
  posted_external_url    TEXT,
  posted_at              INTEGER,
  created_at             INTEGER NOT NULL,
  viewed_at              INTEGER,
  decided_at             INTEGER
);
CREATE INDEX IF NOT EXISTS idx_presence_drafts_status
  ON presence_drafts(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_presence_drafts_platform_status
  ON presence_drafts(platform, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_presence_drafts_expires
  ON presence_drafts(freshness_expires_at)
  WHERE status = 'proposed';
CREATE UNIQUE INDEX IF NOT EXISTS ux_presence_drafts_thread
  ON presence_drafts(platform, external_thread_id)
  WHERE external_thread_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS presence_draft_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  draft_id     TEXT NOT NULL REFERENCES presence_drafts(id) ON DELETE CASCADE,
  event_type   TEXT NOT NULL,
  payload_json TEXT,
  at           INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_presence_events_draft
  ON presence_draft_events(draft_id, at DESC);

CREATE TABLE IF NOT EXISTS presence_cost_ledger (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  draft_id      TEXT REFERENCES presence_drafts(id) ON DELETE SET NULL,
  service       TEXT NOT NULL,
  operation     TEXT NOT NULL,
  units         REAL,
  unit_cost_usd REAL,
  total_usd     REAL NOT NULL,
  meta_json     TEXT,
  at            INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_presence_cost_at
  ON presence_cost_ledger(at DESC);
CREATE INDEX IF NOT EXISTS idx_presence_cost_draft
  ON presence_cost_ledger(draft_id, at DESC);
CREATE INDEX IF NOT EXISTS idx_presence_cost_service
  ON presence_cost_ledger(service, at DESC);

CREATE TABLE IF NOT EXISTS presence_engagement_metrics (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  draft_id     TEXT NOT NULL REFERENCES presence_drafts(id) ON DELETE CASCADE,
  snapshot_tag TEXT NOT NULL,
  at           INTEGER NOT NULL,
  likes        INTEGER,
  replies      INTEGER,
  reposts      INTEGER,
  impressions  INTEGER,
  ratio        REAL,
  raw_json     TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_presence_engagement_draft_tag
  ON presence_engagement_metrics(draft_id, snapshot_tag);
CREATE INDEX IF NOT EXISTS idx_presence_engagement_at
  ON presence_engagement_metrics(at DESC);

CREATE TABLE IF NOT EXISTS presence_platform_connections (
  platform              TEXT PRIMARY KEY,
  account_handle        TEXT,
  keychain_ref          TEXT,
  scopes_json           TEXT,
  connected_at          INTEGER,
  last_refresh_at       INTEGER,
  rate_limit_state_json TEXT
);
`;
