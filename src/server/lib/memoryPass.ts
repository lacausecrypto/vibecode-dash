import type { Database } from 'bun:sqlite';
import { type AgentMode, getAgentMode } from '../../shared/agentModes';
import type { Settings } from '../config';
import { type AgentProvider, execAgentCli } from '../wrappers/agentCli';
import { currentLocale } from './i18n';
import { type MemoryRow, createMemory, extractMemoriesFromReply, listMemories } from './memory';
import { syncMemoriesToVault } from './memoryVaultSync';

/**
 * Karpathy-style write-back pass: after the main reply is persisted, we run a
 * second lightweight CLI call asking the model to distill any durable facts
 * from the exchange. This closes the learning loop — the agent doesn't need to
 * remember to emit <memory> blocks spontaneously; we force a scan every turn.
 *
 * Tools are disabled (--tools "") so this pass is fast, deterministic, and
 * produces no side effects on the filesystem. Expected duration: 2–8 s for
 * claude-sonnet, 3–10 s for opus.
 */

const MEMORY_PASS_PROMPT_TEMPLATE = `You are a memory-extraction subsystem for a personal LLM OS. Given the exchange below, distill 0 to 3 durable facts worth remembering for FUTURE conversations.

The conversation was in mode: {mode}
Prioritise facts of these kinds (mode-specific):
{modeFocus}

Always also watch for:
- User preferences, constraints, explicit rules or no-gos
- Project decisions (tech choices, architecture, scope, deadlines)
- Patterns or approaches the user has confirmed as his
- Stable context newly revealed about the user, his tools, or the project

Strictly ignore:
- Conversational pleasantries or greetings
- Facts the model invented or merely speculated on
- Restatements of the user's prompt
- Anything the user may change within days

Output format — STRICT:
- If nothing memorable: output exactly the single token NONE (uppercase) and nothing else.
- Otherwise, output 1 to 3 blocks in this exact shape:

<memory key="short-kebab-slug" scope="project">
One sentence. State the fact directly.
</memory>

Rules:
- scope MUST be one of: "global" (applies to the user across all projects), "project" (scoped to the current project), or "session" (only relevant to this conversation thread — avoid unless truly ephemeral).
- Prefer "project" or "global" over "session".
- One atomic fact per block. No fluff. No "The user said X" — just state X.
- key must be kebab-case, 2–6 words, unique within the block set.

<existing-memories>
{existingMemories}
</existing-memories>

Do not duplicate an existing memory. If a fact is already captured, skip it.

EXCHANGE:
<user-message>
{userMessage}
</user-message>
<assistant-reply>
{assistantReply}
</assistant-reply>

Now output ONLY the memory blocks, or NONE.`;

export type MemoryPassResult = {
  ok: boolean;
  durationMs: number;
  extracted: number;
  skippedDuplicates: number;
  reply: string;
  items: Array<{ key: string; content: string; scope: string }>;
  /** Tokens spent on this extraction pass. Charged to the parent turn so the
   * dashboard's session total reflects the full cost, not just the main reply. */
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheCreateTokens: number;
    cacheReadTokens: number;
  } | null;
  aborted: boolean;
};

type ExistingMemoryRef = { scope: string; key: string; content: string };

function gatherExistingMemories(
  db: Database,
  projectScope: string | null,
  sessionScope: string | null,
): ExistingMemoryRef[] {
  const rows: ExistingMemoryRef[] = [];
  for (const row of listMemories(db, 'global')) {
    rows.push({ scope: 'global', key: row.key, content: row.content });
  }
  if (projectScope) {
    for (const row of listMemories(db, projectScope)) {
      rows.push({ scope: 'project', key: row.key, content: row.content });
    }
  }
  if (sessionScope) {
    for (const row of listMemories(db, sessionScope)) {
      rows.push({ scope: 'session', key: row.key, content: row.content });
    }
  }
  return rows;
}

function formatExistingMemories(rows: ExistingMemoryRef[]): string {
  if (rows.length === 0) {
    return '(none yet)';
  }
  return rows.map((row) => `- [${row.scope}] ${row.key}: ${row.content}`).join('\n');
}

function normalizeKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
}

function resolveScope(
  requested: string | undefined,
  projectId: string | null,
  sessionId: string | null,
  fallback: 'global' | 'project' | 'session' = 'project',
): string {
  const normalized = (requested || fallback).toLowerCase();
  if (normalized === 'global') {
    return 'global';
  }
  if (normalized === 'session' && sessionId) {
    return `session:${sessionId}`;
  }
  if (normalized === 'project' && projectId) {
    return `project:${projectId}`;
  }
  // Fallbacks if the requested scope can't be resolved.
  if (projectId) {
    return `project:${projectId}`;
  }
  if (sessionId) {
    return `session:${sessionId}`;
  }
  return 'global';
}

export async function runMemoryPass(options: {
  db: Database;
  settings?: Settings;
  provider: AgentProvider;
  model?: string;
  cwd: string;
  projectId: string | null;
  sessionId: string;
  userMessage: string;
  assistantReply: string;
  timeoutMs?: number;
  mode?: AgentMode;
  abortSignal?: AbortSignal;
}): Promise<MemoryPassResult> {
  const mode = options.mode ?? 'chat';
  const locale = await currentLocale();
  const modeConfig = getAgentMode(mode, locale);
  const projectScope = options.projectId ? `project:${options.projectId}` : null;
  const sessionScope = `session:${options.sessionId}`;

  const existing = gatherExistingMemories(options.db, projectScope, sessionScope);
  const existingKeys = new Set(existing.map((row) => normalizeKey(row.key)));
  const existingContents = new Set(existing.map((row) => row.content.trim().toLowerCase()));

  const prompt = MEMORY_PASS_PROMPT_TEMPLATE.replace('{mode}', mode)
    .replace(
      '{modeFocus}',
      modeConfig.memoryBias.focus.map((line) => `- ${line}`).join('\n') || '(nothing specific)',
    )
    .replace('{existingMemories}', formatExistingMemories(existing))
    .replace('{userMessage}', options.userMessage.trim())
    .replace('{assistantReply}', options.assistantReply.trim());

  // Honour early abort: if the stream was cancelled, don't even start the
  // second CLI call. Saves tokens and avoids running a pass whose result
  // nobody will see.
  if (options.abortSignal?.aborted) {
    return {
      ok: false,
      durationMs: 0,
      extracted: 0,
      skippedDuplicates: 0,
      reply: '',
      items: [],
      usage: null,
      aborted: true,
    };
  }

  const result = await execAgentCli({
    provider: options.provider,
    prompt,
    cwd: options.cwd,
    model: options.model,
    timeoutMs: options.timeoutMs ?? 25_000,
    toolPolicy: 'none',
    abortSignal: options.abortSignal,
  });

  const reply = (result.text || '').trim();
  const usage = result.usage
    ? {
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        cacheCreateTokens: result.usage.cacheCreateTokens,
        cacheReadTokens: result.usage.cacheReadTokens,
      }
    : null;

  if (!result.ok) {
    return {
      ok: false,
      durationMs: result.durationMs,
      extracted: 0,
      skippedDuplicates: 0,
      reply,
      items: [],
      usage,
      aborted: Boolean(options.abortSignal?.aborted),
    };
  }

  if (reply === 'NONE' || reply.length === 0) {
    return {
      ok: true,
      durationMs: result.durationMs,
      extracted: 0,
      skippedDuplicates: 0,
      reply,
      items: [],
      usage,
      aborted: false,
    };
  }

  const blocks = extractMemoriesFromReply(reply);
  const inserted: MemoryPassResult['items'] = [];
  const insertedRows: MemoryRow[] = [];
  let skippedDuplicates = 0;

  for (const block of blocks) {
    const key = normalizeKey(block.key) || normalizeKey(block.content.slice(0, 40));
    if (!key) {
      continue;
    }
    const content = block.content.trim();
    if (!content) {
      continue;
    }

    const isDuplicateKey = existingKeys.has(key);
    const isDuplicateContent = existingContents.has(content.toLowerCase());
    if (isDuplicateKey || isDuplicateContent) {
      skippedDuplicates += 1;
      continue;
    }

    const scope = resolveScope(
      block.scope,
      options.projectId,
      options.sessionId,
      modeConfig.memoryBias.defaultScope,
    );
    try {
      const row = createMemory(options.db, {
        scope,
        key,
        content,
        source: 'auto',
        relatedProjectId: options.projectId,
        relatedSessionId: options.sessionId,
      });
      existingKeys.add(key);
      existingContents.add(content.toLowerCase());
      inserted.push({ key, content, scope });
      insertedRows.push(row);
    } catch {
      // Failed insert — likely a race or constraint. Count as duplicate.
      skippedDuplicates += 1;
    }
  }

  // Karpathy write-back: mirror the new memories into the vault as markdown
  // so the user can read/curate them in Obsidian. Best-effort, never throws.
  if (options.settings && insertedRows.length > 0) {
    try {
      await syncMemoriesToVault({
        settings: options.settings,
        db: options.db,
        memories: insertedRows,
      });
    } catch {
      // Filesystem error shouldn't block the turn.
    }
  }

  return {
    ok: true,
    durationMs: result.durationMs,
    extracted: inserted.length,
    skippedDuplicates,
    reply,
    items: inserted,
    usage,
    aborted: false,
  };
}
