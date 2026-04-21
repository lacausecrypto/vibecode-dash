import type { Database } from 'bun:sqlite';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { type Settings, expandHomePath } from '../config';

export type MemoryScope = 'global' | `project:${string}` | `session:${string}`;

export type MemorySource = 'manual' | 'auto' | 'persona';

export type MemoryRow = {
  id: string;
  scope: string;
  key: string;
  content: string;
  source: MemorySource;
  created_at: number;
  updated_at: number;
  related_project_id: string | null;
  related_session_id: string | null;
  tags_json: string | null;
  pinned: number;
  last_used_at: number | null;
  use_count: number;
};

export type PersonaSnapshot = {
  identity: string | null;
  values: string | null;
  path: string | null;
};

export type VaultMatch = {
  path: string;
  title: string;
  snippet: string;
  score: number;
};

export type ContextSnapshot = {
  persona: PersonaSnapshot;
  projectId: string | null;
  projectName: string | null;
  projectPath: string | null;
  memories: {
    global: MemoryRow[];
    project: MemoryRow[];
    session: MemoryRow[];
  };
  vaultMatches: VaultMatch[];
  tokensEstimate: number;
};

const MAX_PERSONA_CHARS = 4_000;
const MAX_MEMORY_ITEMS_PER_SCOPE = 10;
const MAX_VAULT_MATCHES = 5;
const VAULT_SNIPPET_LENGTH = 220;

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

async function safeReadFile(path: string, maxChars = MAX_PERSONA_CHARS): Promise<string | null> {
  try {
    const content = await readFile(path, 'utf8');
    return content.length > maxChars ? `${content.slice(0, maxChars)}\n... [truncated]` : content;
  } catch {
    return null;
  }
}

export async function loadPersona(settings: Settings): Promise<PersonaSnapshot> {
  // Preferred source: the Obsidian vault's Persona/ folder (Karpathy LLM OS layout)
  if (settings.paths.vaultPath) {
    const vaultRoot = resolve(expandHomePath(settings.paths.vaultPath));
    const base = resolve(vaultRoot, 'Persona');
    const [identity, values] = await Promise.all([
      safeReadFile(join(base, 'identity.md')),
      safeReadFile(join(base, 'values.md')),
    ]);

    if (identity || values) {
      return { identity, values, path: base };
    }
  }

  // Fallback: per-project collaborator workspace
  const roots = settings.paths.projectsRoots.map((root) => expandHomePath(root));
  for (const root of roots) {
    const base = resolve(root, '.collaborator', 'persona');
    const [identity, values] = await Promise.all([
      safeReadFile(join(base, 'identity.md')),
      safeReadFile(join(base, 'values.md')),
    ]);

    if (identity || values) {
      return { identity, values, path: base };
    }
  }

  return { identity: null, values: null, path: null };
}

/**
 * List memories for a given scope, ordered by decay-weighted relevance:
 *   score = pinned * 100 + age_recency + usage_bonus
 * Pinned items always float to the top. Others are ranked by:
 *  - time since last use (last_used_at falls back to updated_at)
 *  - raw usage count
 * This means a 3-month-old memory never touched since sinks below a 10-day-old
 * memory the agent keeps pulling in.
 */
export function listMemories(
  db: Database,
  scope: string,
  limit = MAX_MEMORY_ITEMS_PER_SCOPE,
): MemoryRow[] {
  const now = nowSec();
  // SQLite-friendly scoring: recency_days = (now - last_used_at)/86400.
  // We subtract that from a big constant so fresher = higher, then add a
  // small logarithmic-ish bonus for use_count (clamped by cap).
  return db
    .query<MemoryRow, [number, string, number]>(
      `SELECT *,
        (
          pinned * 1000000
          + CAST((? - COALESCE(last_used_at, updated_at)) / -86400.0 AS INTEGER)
          + MIN(use_count, 20) * 5
        ) AS score
       FROM agent_memories
       WHERE scope = ?
       ORDER BY score DESC
       LIMIT ?`,
    )
    .all(now, scope, limit);
}

/**
 * Purge memories whose scope references a deleted project or a missing
 * session. Cheap SQL: NOT EXISTS subquery against the referenced table.
 * Returns the number of rows removed so the caller can log / expose it.
 *
 * global scope is NEVER touched (always valid).
 */
export function purgeOrphanMemories(db: Database): number {
  const before = db
    .query<{ count: number }, []>('SELECT COUNT(*) AS count FROM agent_memories')
    .get();
  db.exec(`
    DELETE FROM agent_memories
    WHERE scope LIKE 'project:%'
      AND NOT EXISTS (
        SELECT 1 FROM projects p WHERE 'project:' || p.id = agent_memories.scope
      );
    DELETE FROM agent_memories
    WHERE scope LIKE 'session:%'
      AND NOT EXISTS (
        SELECT 1 FROM agent_sessions s WHERE 'session:' || s.id = agent_memories.scope
      );
  `);
  const after = db
    .query<{ count: number }, []>('SELECT COUNT(*) AS count FROM agent_memories')
    .get();
  return (before?.count ?? 0) - (after?.count ?? 0);
}

/**
 * Mark a batch of memory IDs as "used right now". Called whenever the agent
 * injects them into a turn's context. Feeds the decay scoring in listMemories.
 */
export function touchMemoriesUsed(db: Database, ids: string[]): void {
  if (ids.length === 0) {
    return;
  }
  const now = nowSec();
  const placeholders = ids.map(() => '?').join(',');
  db.query(
    `UPDATE agent_memories
     SET last_used_at = ?, use_count = use_count + 1
     WHERE id IN (${placeholders})`,
  ).run(now, ...ids);
}

export function listAllMemoriesGrouped(
  db: Database,
  projectId: string | null,
  sessionId: string | null,
): ContextSnapshot['memories'] {
  const global = listMemories(db, 'global');
  const project = projectId ? listMemories(db, `project:${projectId}`) : [];
  const session = sessionId ? listMemories(db, `session:${sessionId}`) : [];

  return { global, project, session };
}

export function createMemory(
  db: Database,
  input: {
    scope: string;
    key: string;
    content: string;
    source: MemorySource;
    relatedProjectId?: string | null;
    relatedSessionId?: string | null;
    tags?: string[];
    pinned?: boolean;
  },
): MemoryRow {
  const id = crypto.randomUUID();
  const ts = nowSec();
  db.query(
    `INSERT INTO agent_memories (
      id, scope, key, content, source, created_at, updated_at,
      related_project_id, related_session_id, tags_json, pinned
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.scope,
    input.key,
    input.content,
    input.source,
    ts,
    ts,
    input.relatedProjectId || null,
    input.relatedSessionId || null,
    input.tags && input.tags.length > 0 ? JSON.stringify(input.tags) : null,
    input.pinned ? 1 : 0,
  );

  const row = db.query<MemoryRow, [string]>('SELECT * FROM agent_memories WHERE id = ?').get(id);
  if (!row) {
    throw new Error('memory_create_failed');
  }
  return row;
}

export function updateMemory(
  db: Database,
  id: string,
  input: {
    content?: string;
    key?: string;
    pinned?: boolean;
    tags?: string[];
  },
): MemoryRow | null {
  const current = db
    .query<MemoryRow, [string]>('SELECT * FROM agent_memories WHERE id = ?')
    .get(id);
  if (!current) {
    return null;
  }

  const ts = nowSec();
  db.query(
    `UPDATE agent_memories SET
       content = ?,
       key = ?,
       pinned = ?,
       tags_json = ?,
       updated_at = ?
     WHERE id = ?`,
  ).run(
    input.content ?? current.content,
    input.key ?? current.key,
    input.pinned === undefined ? current.pinned : input.pinned ? 1 : 0,
    input.tags ? JSON.stringify(input.tags) : current.tags_json,
    ts,
    id,
  );

  return db.query<MemoryRow, [string]>('SELECT * FROM agent_memories WHERE id = ?').get(id);
}

export function deleteMemory(db: Database, id: string): boolean {
  const result = db.query<unknown, [string]>('DELETE FROM agent_memories WHERE id = ?').run(id);
  return (result.changes ?? 0) > 0;
}

function toFtsQuery(input: string): string {
  const tokens = input
    .trim()
    .split(/\s+/)
    .map((token) => token.replace(/[^\p{L}\p{N}_-]/gu, ''))
    .filter((token) => token.length >= 2);

  if (tokens.length === 0) {
    return '';
  }

  return tokens
    .slice(0, 6)
    .map((token) => `${token}*`)
    .join(' OR ');
}

function normalizeSnippet(snippet: string): string {
  return snippet
    .replace(/<mark>/g, '')
    .replace(/<\/mark>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, VAULT_SNIPPET_LENGTH);
}

export function searchVault(db: Database, query: string, limit = MAX_VAULT_MATCHES): VaultMatch[] {
  const ftsQuery = toFtsQuery(query);
  if (!ftsQuery) {
    return [];
  }

  try {
    const rows = db
      .query<{ path: string; title: string; snippet: string; score: number }, [string, number]>(
        `SELECT
           path,
           title,
           snippet(obsidian_notes_fts, 2, '<mark>', '</mark>', ' ... ', 18) AS snippet,
           bm25(obsidian_notes_fts) AS score
         FROM obsidian_notes_fts
         WHERE obsidian_notes_fts MATCH ?
         ORDER BY score
         LIMIT ?`,
      )
      .all(ftsQuery, limit);

    return rows.map((row) => ({
      path: row.path,
      title: row.title || row.path,
      snippet: normalizeSnippet(row.snippet),
      score: row.score,
    }));
  } catch {
    return [];
  }
}

function estimateTokens(text: string): number {
  // Rough 4 char / token heuristic.
  return Math.ceil(text.length / 4);
}

export async function buildContextSnapshot(options: {
  db: Database;
  settings: Settings;
  projectId: string | null;
  projectName: string | null;
  projectPath: string | null;
  sessionId: string | null;
  userMessage: string;
}): Promise<ContextSnapshot> {
  const persona = await loadPersona(options.settings);
  const memories = listAllMemoriesGrouped(options.db, options.projectId, options.sessionId);
  const vaultMatches = options.userMessage ? searchVault(options.db, options.userMessage) : [];

  const estimate =
    estimateTokens(persona.identity || '') +
    estimateTokens(persona.values || '') +
    [...memories.global, ...memories.project, ...memories.session].reduce(
      (sum, memory) => sum + estimateTokens(memory.content),
      0,
    ) +
    vaultMatches.reduce((sum, match) => sum + estimateTokens(match.snippet), 0);

  return {
    persona,
    projectId: options.projectId,
    projectName: options.projectName,
    projectPath: options.projectPath,
    memories,
    vaultMatches,
    tokensEstimate: estimate,
  };
}

function formatMemorySection(title: string, memories: MemoryRow[]): string | null {
  if (memories.length === 0) {
    return null;
  }
  const lines = memories.map((memory) => {
    const pinned = memory.pinned ? ' (pinned)' : '';
    return `- ${memory.key}${pinned}: ${memory.content.trim()}`;
  });
  return `<${title}>\n${lines.join('\n')}\n</${title}>`;
}

export function renderContextPrelude(snapshot: ContextSnapshot): string {
  const parts: string[] = [];

  if (snapshot.persona.identity || snapshot.persona.values) {
    const inner: string[] = [];
    if (snapshot.persona.identity) {
      inner.push(`<identity>\n${snapshot.persona.identity.trim()}\n</identity>`);
    }
    if (snapshot.persona.values) {
      inner.push(`<values>\n${snapshot.persona.values.trim()}\n</values>`);
    }
    parts.push(`<persona>\n${inner.join('\n')}\n</persona>`);
  }

  if (snapshot.projectId || snapshot.projectPath) {
    const projectInner: string[] = [];
    projectInner.push(
      `<meta>${snapshot.projectName || 'unknown'} · ${snapshot.projectPath || 'n/a'}</meta>`,
    );
    const projectSection = formatMemorySection('memories', snapshot.memories.project);
    if (projectSection) {
      projectInner.push(projectSection);
    }
    parts.push(`<project>\n${projectInner.join('\n')}\n</project>`);
  }

  const globalMem = formatMemorySection('global-memories', snapshot.memories.global);
  if (globalMem) {
    parts.push(globalMem);
  }

  const sessionMem = formatMemorySection('session-memories', snapshot.memories.session);
  if (sessionMem) {
    parts.push(sessionMem);
  }

  if (snapshot.vaultMatches.length > 0) {
    const lines = snapshot.vaultMatches.map(
      (match) => `<note path="${match.path}" title="${match.title}">\n${match.snippet}\n</note>`,
    );
    parts.push(`<vault-context>\n${lines.join('\n')}\n</vault-context>`);
  }

  if (parts.length === 0) {
    return '';
  }

  return `${parts.join('\n\n')}\n`;
}

const MEMORY_BLOCK_REGEX =
  /<memory(?:\s+key="([^"]+)")?(?:\s+scope="([^"]+)")?>([\s\S]*?)<\/memory>/gi;
const REMEMBER_SECTION_REGEX = /^##\s*Remember\s*:?\s*$([\s\S]*?)(?=^##\s|\Z)/im;

export function extractMemoriesFromReply(reply: string): Array<{
  key: string;
  content: string;
  scope?: string;
}> {
  const hits: Array<{ key: string; content: string; scope?: string }> = [];

  const blockMatches = reply.matchAll(MEMORY_BLOCK_REGEX);
  for (const match of blockMatches) {
    const key = (match[1] || '').trim();
    const scope = (match[2] || '').trim() || undefined;
    const content = match[3]?.trim() || '';
    if (content.length === 0) {
      continue;
    }
    hits.push({
      key: key || content.slice(0, 40).replace(/\s+/g, ' '),
      content,
      scope,
    });
  }

  const rememberMatch = reply.match(REMEMBER_SECTION_REGEX);
  if (rememberMatch) {
    const body = rememberMatch[1].trim();
    const bullets = body
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('-') || line.startsWith('*'))
      .map((line) => line.replace(/^[-*]\s*/, '').trim())
      .filter((line) => line.length > 0);

    for (const bullet of bullets) {
      hits.push({
        key: bullet.slice(0, 50).replace(/\s+/g, ' '),
        content: bullet,
      });
    }
  }

  return hits;
}
