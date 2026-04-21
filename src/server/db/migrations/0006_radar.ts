export const version = 6;

/**
 * Phase 3 — Competitor Radar + Divergence Engine
 *
 * The `competitors` and `insights` tables shipped with 0001_init but were
 * never consumed. Before enabling the radar surface we add the columns and
 * constraints needed for idempotent upsert.
 *
 * - `source` on competitors distinguishes agent-scraped rows from manual
 *   entries so a re-scan can safely wipe agent-owned rows without touching
 *   the user's curated list.
 * - UNIQUE (project_id, LOWER(name)) prevents duplicates when an agent rerun
 *   proposes a competitor the user has already named (case-insensitive).
 */
export const sql = `
ALTER TABLE competitors ADD COLUMN source TEXT NOT NULL DEFAULT 'manual';

CREATE UNIQUE INDEX IF NOT EXISTS ux_competitors_project_name
  ON competitors(project_id, LOWER(name));
`;
