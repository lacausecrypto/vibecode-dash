export const version = 17;

/**
 * Audit log for the presence auto-publish pipeline.
 *
 * Every decision the publisher worker takes — whether a draft was
 * actually posted, deferred by the time-window gate, blocked by the
 * daily cap, dropped as duplicate, or hit a kill-switch — writes one
 * row here. The log is the single source of truth when the user wants
 * to know why a given draft did or didn't go out.
 *
 * Why a separate table:
 *   - presence_drafts.status only carries the terminal state. It can't
 *     show "skipped 3 times due to rate cap, then published on attempt
 *     4". The history matters for tuning the policy (cap too low?
 *     window too narrow?).
 *   - presence_cost_ledger is for $ spend; publish decisions are free
 *     for Reddit (deeplink) and ~$0.01 for X. Mixing them dilutes both.
 *
 * `decision` is a closed enum; the worker MUST use one of:
 *   'published'           — draft posted to X, posted_external_id set
 *   'reddit_handed_off'   — UI surfaced the deeplink to the user; not
 *                           yet posted (waiting on user's manual click +
 *                           "mark posted" callback)
 *   'skipped_kill_switch' — settings.presence.publishMode = 'off'
 *   'skipped_rate_cap'    — daily cap hit for the platform
 *   'skipped_window'      — outside the configured posting window
 *   'skipped_cooldown'    — same source posted within cooldown_hours
 *   'skipped_duplicate'   — body identical to a recent post (sha1)
 *   'dry_run'             — publishMode = 'dry_run'; would have posted
 *   'failed'              — API call attempted, returned error
 *
 * `platform_post_id` is set for 'published' (the X tweet id or the
 * reddit fullname returned by the platform). Null otherwise.
 *
 * `reason` is a short human-readable detail (HTTP code, "cap=10
 * already hit", etc.). Truncated to 500 chars by the worker before
 * insert.
 */

export const sql = `
CREATE TABLE IF NOT EXISTS presence_publish_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  draft_id TEXT,
  decision TEXT NOT NULL,
  reason TEXT,
  platform_post_id TEXT,
  at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_presence_publish_log_at
  ON presence_publish_log(at DESC);

CREATE INDEX IF NOT EXISTS idx_presence_publish_log_draft
  ON presence_publish_log(draft_id, at DESC);

CREATE INDEX IF NOT EXISTS idx_presence_publish_log_decision_at
  ON presence_publish_log(decision, at DESC);
`;
