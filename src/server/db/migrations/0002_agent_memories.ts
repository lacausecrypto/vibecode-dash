export const version = 2;

export const sql = `
CREATE TABLE IF NOT EXISTS agent_memories (
  id                 TEXT PRIMARY KEY,
  scope              TEXT NOT NULL,           -- 'global' | 'project:<id>' | 'session:<id>'
  key                TEXT NOT NULL,           -- short slug / human label
  content            TEXT NOT NULL,
  source             TEXT NOT NULL,           -- 'manual' | 'auto' | 'persona'
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  related_project_id TEXT,
  related_session_id TEXT,
  tags_json          TEXT,
  pinned             INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_agent_memories_scope ON agent_memories(scope, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_memories_project ON agent_memories(related_project_id);
CREATE INDEX IF NOT EXISTS idx_agent_memories_session ON agent_memories(related_session_id);
`;
