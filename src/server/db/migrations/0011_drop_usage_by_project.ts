export const version = 11;

/**
 * Drop the legacy `usage_by_project` table created in 0001_init.
 * It was superseded by `usage_daily_by_project` (migration 0003) which has
 * a source column and the right uniqueness key. Nothing reads or writes the
 * old table anymore — verified by grep before shipping this migration.
 */
export const sql = `
DROP TABLE IF EXISTS usage_by_project;
`;
