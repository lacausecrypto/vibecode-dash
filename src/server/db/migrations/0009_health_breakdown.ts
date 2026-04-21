export const version = 9;

/**
 * Persist the full health-score breakdown per project so the UI can explain
 * WHY a project scores what it scores (documentation / tests / ci / activity
 * / hygiene / structure) instead of showing an opaque single number.
 *
 * Added as JSON so we can evolve the factor set without schema migrations.
 * Rows that predate this migration get NULL — the scanner backfills on next
 * rescan.
 */
export const sql = `
ALTER TABLE projects ADD COLUMN health_breakdown_json TEXT;
`;
