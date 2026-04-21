export const version = 4;

export const sql = `
-- Track each memory's real usage so decay can privilege what the agent
-- actually pulls into context, not just what was written recently.
ALTER TABLE agent_memories ADD COLUMN last_used_at INTEGER;
ALTER TABLE agent_memories ADD COLUMN use_count INTEGER NOT NULL DEFAULT 0;
UPDATE agent_memories SET last_used_at = updated_at WHERE last_used_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_agent_memories_last_used ON agent_memories(last_used_at DESC);
`;
