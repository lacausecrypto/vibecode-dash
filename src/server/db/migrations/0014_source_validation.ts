export const version = 14;

/**
 * Pack A — Source validation infrastructure (V4 source-intelligence)
 *
 * Adds two columns to `presence_sources` so we can record the result of an
 * out-of-band reachability check against the platform:
 *
 *   - `validation_status` : enum-like text. NULL = never validated. Otherwise
 *     'valid' | 'not_found' | 'private' | 'banned' | 'invalid_format' | 'error'.
 *   - `validated_at` : unix seconds of the last validation attempt. Lets the
 *     UI surface "checked 3 days ago" and the auto-revalidate job decide
 *     when a stale check is worth re-running.
 *
 * Why a separate column instead of overloading `last_scan_status`:
 *   - Scanning hits the data API (returns candidate threads) and is gated
 *     by TTL + budget. Validation hits a tiny existence-check endpoint
 *     (Reddit /about.json, X syndication CDN) that's free and fast,
 *     and we want to run it BEFORE the source ever scans, including at
 *     POST /sources time — so they're orthogonal lifecycle signals.
 *   - Validation_status drives the auto-deactivation rule (sources with
 *     `not_found` or `banned` are flipped to `active = 0` automatically),
 *     while `last_scan_status` remains a per-attempt scan trace.
 *
 * Backward compat: existing rows have NULL on both new columns. The
 * /sources/validate-all endpoint walks them on demand; the boot-time async
 * pass runs once after seed to backfill.
 */

export const sql = `
ALTER TABLE presence_sources ADD COLUMN validation_status TEXT;
ALTER TABLE presence_sources ADD COLUMN validated_at INTEGER;

CREATE INDEX IF NOT EXISTS idx_presence_sources_validation
  ON presence_sources(validation_status);
`;
