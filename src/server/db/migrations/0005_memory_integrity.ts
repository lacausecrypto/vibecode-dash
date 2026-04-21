export const version = 5;

/**
 * Tighten agent_memories integrity:
 *   - Deduplicate existing (scope, key) pairs, keeping the row with highest
 *     use_count (else the most recent one). The earlier Karpathy-style
 *     distillation only deduped logically; doublons existaient en DB.
 *   - Add UNIQUE index to guarantee the invariant going forward. Future
 *     concurrent pass attempts will fail-fast instead of silently dupliquer.
 */
export const sql = `
-- Collapse duplicates: for each (scope,key), keep the row with the best
-- score (use_count DESC, updated_at DESC, created_at DESC).
DELETE FROM agent_memories
WHERE id NOT IN (
  SELECT id FROM (
    SELECT id,
      ROW_NUMBER() OVER (
        PARTITION BY scope, key
        ORDER BY use_count DESC, updated_at DESC, created_at DESC
      ) AS rn
    FROM agent_memories
  )
  WHERE rn = 1
);

-- Future-proof: no two rows may share (scope, key).
CREATE UNIQUE INDEX IF NOT EXISTS ux_agent_memories_scope_key
  ON agent_memories(scope, key);
`;
