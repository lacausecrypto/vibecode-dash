export const version = 16;

/**
 * Pack C — Auto-prune cooldown column.
 *
 * The prune assistant offers the user a 1-click "Deactivate" or "Keep,
 * recompute next week" decision per low-ROI source. "Keep" must not just
 * vanish silently — otherwise the same suggestion comes back next time the
 * user opens the panel and decision-fatigue sets in. We persist the
 * dismissal timestamp so the suggestion endpoint can exclude any source
 * whose `prune_dismissed_at` falls within the cooldown window (7 days).
 *
 * Why a column rather than a separate decisions log:
 *   - One source can only be "kept" or not — there's no history value;
 *     the latest decision is all that matters.
 *   - The query stays a simple WHERE clause on the same table the
 *     suggestion endpoint already reads.
 */

export const sql = `
ALTER TABLE presence_sources ADD COLUMN prune_dismissed_at INTEGER;
`;
