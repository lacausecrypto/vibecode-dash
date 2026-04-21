import type { Database } from 'bun:sqlite';
import { resolve } from 'node:path';
import type { Hono } from 'hono';
import { z } from 'zod';
import { AGENT_MODES, type AgentMode, type Locale, getAgentMode } from '../../shared/agentModes';
import { todayIso } from '../../shared/dates';
import { type Settings, expandHomePath, loadSettings } from '../config';
import { getDb } from '../db';
import { getTokenPath, loadOrCreateToken } from '../lib/auth';
import {
  RECENT_TURNS,
  decideSummary,
  readSummaryFromContext,
  refreshConversationSummary,
  writeSummaryToContext,
} from '../lib/conversationSummary';
import { currentLocale } from '../lib/i18n';
import { acquireLock, withLock } from '../lib/locks';
import {
  buildContextSnapshot,
  createMemory,
  deleteMemory,
  extractMemoriesFromReply,
  listMemories,
  renderContextPrelude,
  touchMemoriesUsed,
  updateMemory,
} from '../lib/memory';
import { runMemoryPass } from '../lib/memoryPass';
import { syncMemoriesToVault } from '../lib/memoryVaultSync';
import { archiveSessionToVault } from '../lib/sessionArchive';
import {
  type AgentExecResult,
  type AgentProvider,
  type AgentStreamEvent,
  type AgentUsage,
  execAgentCli,
  execAgentCliStream,
} from '../wrappers/agentCli';

const PROVIDERS = [
  {
    id: 'claude',
    command: 'claude -p <prompt>',
  },
  {
    id: 'codex',
    command: 'codex exec --json <prompt>',
  },
] as const;

const ExecSchema = z.object({
  provider: z.enum(['claude', 'codex']),
  prompt: z.string().min(1),
  cwd: z.string().optional(),
  model: z.string().optional(),
  timeoutMs: z.number().int().min(1000).max(600000).optional(),
});

const SessionCreateSchema = z.object({
  provider: z.enum(['claude', 'codex']).default('claude'),
  title: z.string().optional(),
  model: z.string().optional(),
  cwd: z.string().optional(),
  context: z.record(z.string(), z.unknown()).optional(),
});

const SessionSendSchema = z.object({
  content: z.string().min(1),
  timeoutMs: z.number().int().min(1000).max(600000).optional(),
  mode: z.enum(['chat', 'plan', 'learn', 'reflect']).default('chat'),
});

const QuickSchema = z.object({
  sessionId: z.string().optional(),
  projectId: z.string().optional(),
  provider: z.enum(['claude', 'codex']).optional(),
  model: z.string().optional(),
  cwd: z.string().optional(),
  timeoutMs: z.number().int().min(1000).max(600000).optional(),
});

type SessionContext = {
  provider: AgentProvider;
  cwd: string;
  model?: string;
  [key: string]: unknown;
};

type SessionRow = {
  id: string;
  created_at: number;
  updated_at: number;
  model: string | null;
  title: string | null;
  context_json: string | null;
  archived: number;
  message_count: number;
  last_message: string | null;
  total_tokens?: number;
};

type MessageRow = {
  id: string;
  session_id: string;
  role: string;
  content: string | null;
  tool_calls_json: string | null;
  ts: number;
};

type QuickPromptResult = {
  title: string;
  prompt: string;
  cwd?: string;
};

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function isSubPath(candidate: string, root: string): boolean {
  const normalizedCandidate = resolve(candidate);
  const normalizedRoot = resolve(root);
  return (
    normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}/`)
  );
}

function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) {
    return fallback;
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function getAllowedRoots(settings: Settings): string[] {
  const roots = [
    ...settings.paths.projectsRoots.map((root) => expandHomePath(root)),
    expandHomePath(settings.paths.vaultPath),
    process.cwd(),
  ];

  const normalized = new Set<string>();
  for (const root of roots) {
    normalized.add(resolve(root));
  }

  return [...normalized];
}

function normalizeAllowedCwd(settings: Settings, requestedCwd?: string): string {
  const roots = getAllowedRoots(settings);
  const fallback = roots[0] || process.cwd();
  const candidate = resolve(requestedCwd ? expandHomePath(requestedCwd) : fallback);

  const allowed = roots.some((root) => isSubPath(candidate, root));
  if (!allowed) {
    throw new Error('cwd_not_allowed');
  }

  return candidate;
}

function toSessionResponse(row: SessionRow) {
  return {
    ...row,
    context: parseJson<SessionContext | null>(row.context_json, null),
  };
}

function sessionSummaryQuery(db: Database, limit: number): SessionRow[] {
  return db
    .query(
      `SELECT
        s.id,
        s.created_at,
        s.updated_at,
        s.model,
        s.title,
        s.context_json,
        s.archived,
        COALESCE(counts.message_count, 0) AS message_count,
        last_msg.content AS last_message,
        COALESCE(tok.total_tokens, 0) AS total_tokens
      FROM agent_sessions s
      LEFT JOIN (
        SELECT session_id, COUNT(*) AS message_count
        FROM agent_messages
        GROUP BY session_id
      ) counts ON counts.session_id = s.id
      LEFT JOIN (
        SELECT session_id, content,
               ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY ts DESC, rowid DESC) AS rn
        FROM agent_messages
      ) last_msg ON last_msg.session_id = s.id AND last_msg.rn = 1
      LEFT JOIN (
        SELECT session_id,
          SUM(
            COALESCE(json_extract(tool_calls_json, '$.usage.inputTokens'), 0) +
            COALESCE(json_extract(tool_calls_json, '$.usage.outputTokens'), 0) +
            COALESCE(json_extract(tool_calls_json, '$.usage.cacheCreateTokens'), 0) +
            COALESCE(json_extract(tool_calls_json, '$.usage.cacheReadTokens'), 0) +
            -- Side-costs: summary refresh + memory distillation pass.
            COALESCE(json_extract(tool_calls_json, '$.summaryUsage.inputTokens'), 0) +
            COALESCE(json_extract(tool_calls_json, '$.summaryUsage.outputTokens'), 0) +
            COALESCE(json_extract(tool_calls_json, '$.summaryUsage.cacheCreateTokens'), 0) +
            COALESCE(json_extract(tool_calls_json, '$.summaryUsage.cacheReadTokens'), 0) +
            COALESCE(json_extract(tool_calls_json, '$.memoryPassUsage.inputTokens'), 0) +
            COALESCE(json_extract(tool_calls_json, '$.memoryPassUsage.outputTokens'), 0) +
            COALESCE(json_extract(tool_calls_json, '$.memoryPassUsage.cacheCreateTokens'), 0) +
            COALESCE(json_extract(tool_calls_json, '$.memoryPassUsage.cacheReadTokens'), 0)
          ) AS total_tokens
        FROM agent_messages
        WHERE role = 'assistant' AND tool_calls_json IS NOT NULL
        GROUP BY session_id
      ) tok ON tok.session_id = s.id
      WHERE s.archived = 0
      ORDER BY s.updated_at DESC
      LIMIT ?`,
    )
    .all(limit) as SessionRow[];
}

function sessionById(db: Database, id: string): SessionRow | null {
  return db
    .query(
      `SELECT
        s.id,
        s.created_at,
        s.updated_at,
        s.model,
        s.title,
        s.context_json,
        s.archived,
        COALESCE((SELECT COUNT(*) FROM agent_messages m WHERE m.session_id = s.id), 0) AS message_count,
        (SELECT m.content FROM agent_messages m WHERE m.session_id = s.id ORDER BY m.ts DESC LIMIT 1) AS last_message
      FROM agent_sessions s
      WHERE s.id = ?
      LIMIT 1`,
    )
    .get(id) as SessionRow | null;
}

function messagesBySession(db: Database, sessionId: string, limit = 200): MessageRow[] {
  return db
    .query(
      `SELECT id, session_id, role, content, tool_calls_json, ts
       FROM agent_messages
       WHERE session_id = ?
       ORDER BY ts ASC
       LIMIT ?`,
    )
    .all(sessionId, limit) as MessageRow[];
}

function insertSession(
  db: Database,
  input: {
    provider: AgentProvider;
    cwd: string;
    model?: string;
    title?: string;
    context?: Record<string, unknown>;
  },
): SessionRow {
  const id = crypto.randomUUID();
  const ts = nowSec();

  const context: SessionContext = {
    provider: input.provider,
    cwd: input.cwd,
    ...(input.model ? { model: input.model } : {}),
    ...(input.context || {}),
  };

  const title = input.title?.trim() || `${input.provider} session`;

  db.query(
    `INSERT INTO agent_sessions (id, created_at, updated_at, model, title, context_json, archived)
     VALUES (?, ?, ?, ?, ?, ?, 0)`,
  ).run(id, ts, ts, input.model || null, title, JSON.stringify(context));

  const row = sessionById(db, id);
  if (!row) {
    throw new Error('session_create_failed');
  }
  return row;
}

function appendMessage(
  db: Database,
  input: {
    sessionId: string;
    role: 'user' | 'assistant' | 'tool';
    content: string;
    toolCalls?: Record<string, unknown>;
    ts?: number;
  },
): MessageRow {
  const id = crypto.randomUUID();
  const ts = input.ts || nowSec();

  db.query(
    `INSERT INTO agent_messages (id, session_id, role, content, tool_calls_json, ts)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.sessionId,
    input.role,
    input.content,
    input.toolCalls ? JSON.stringify(input.toolCalls) : null,
    ts,
  );

  db.query('UPDATE agent_sessions SET updated_at = ? WHERE id = ?').run(ts, input.sessionId);

  const row = db
    .query(
      'SELECT id, session_id, role, content, tool_calls_json, ts FROM agent_messages WHERE id = ?',
    )
    .get(id) as MessageRow | null;

  if (!row) {
    throw new Error('message_insert_failed');
  }

  return row;
}

const MAX_HISTORY_TURNS = 20;
const CONVERSATION_SUMMARY_REFRESH_TIMEOUT_MS = 30_000;

function buildSystemInstructions(): string {
  const today = todayIso();
  // Eager-load so the token file exists (and has 0600 perms) before we hand
  // its path to the CLI. Value is discarded on purpose — we never inline it.
  loadOrCreateToken();
  const tokenFile = getTokenPath();
  return [
    'You are the assistant embedded in a local engineering dashboard.',
    `Today: ${today}. Always use this as the reference for "today", "aujourd'hui", "cette semaine", etc. — do NOT ask the user for the date.`,
    "Treat the <persona>, <project>, <global-memories>, <session-memories>, and <vault-context> blocks below as authoritative context pulled from the user's own knowledge base.",
    'Be concise, structured, and actionable. Cite vault notes inline as [[path/to/note.md]] when you draw on them.',
    'Tools (Read, Grep, Glob, Bash, Task, etc.) are available but MUST be used sparingly — only when the user explicitly asks for an action on the codebase, or when the question cannot be answered from the injected context. For simple factual or conversational prompts, answer directly without tools.',
    'If the user asks you to remember something durable, include a <memory key="short-label" scope="project|global">content</memory> block in your reply; it will be persisted automatically. A separate memory-distillation pass runs after your reply, so you do not need to over-emit memory blocks — only emit them when the user explicitly says "retiens / remember / remember this".',
    'If older context was trimmed, acknowledge it once in one line.',
    '',
    '## Live dashboard API (local, http://127.0.0.1:4318)',
    `Use Bash + curl to query these when the user asks about stats / activity / state. Today = ${today}.`,
    'CURL RULES (strict):',
    '  1. Only curl the local dashboard at http://127.0.0.1:4318/** — never external URLs.',
    `  2. Auth header is MANDATORY: read the token via shell substitution from ${tokenFile}. NEVER print the token, NEVER paste it into your reply, NEVER store it in memory. Example:`,
    `     \`curl -s -H "x-dashboard-token: $(cat ${tokenFile})" http://127.0.0.1:4318/api/projects\``,
    '',
    'USAGE (tokens + cost):',
    `- GET /api/usage/daily?from=${today}&to=${today} → today's tokens, per provider (claude+codex)`,
    '- GET /api/usage/daily?from=YYYY-MM-DD&to=YYYY-MM-DD → date-range daily rows',
    '- GET /api/usage/by-project?from=...&to=... → tokens grouped by project',
    '- GET /api/usage/monthly → month totals',
    '- GET /api/usage/hour-distribution → hour-of-day heatmap',
    '- GET /api/usage/tool-usage → agent tool usage counts',
    '- GET /api/usage/by-model → tokens per model',
    '',
    'PROJECTS:',
    '- GET /api/projects → all projects (id, name, path, health_score, last_commit_at, uncommitted, loc, type)',
    '- GET /api/projects/:id → full project detail',
    '',
    'VAULT / OBSIDIAN:',
    '- GET /api/obsidian/activity → notes per day',
    '- GET /api/obsidian/orphans → notes with no backlink',
    '- GET /api/obsidian/tags → all tags',
    '- GET /api/obsidian/notes/search?q=... → FTS5',
    '',
    'GITHUB:',
    '- GET /api/github/status → repos state',
    '- GET /api/github/activity → commits per day',
    '- GET /api/github/traffic → clones + views',
    '',
    'AGENT SELF:',
    '- GET /api/agent/sessions?limit=N → your past sessions (with total_tokens)',
    '- GET /api/agent/memories?scope=global → your durable memories',
    '',
    'RADAR (competitors + insights per project):',
    '- GET /api/projects/:id/competitors → competitors known for a project',
    '- GET /api/insights?status=pending&projectId=... → divergence-engine insights',
    '',
    'Query strategy:',
    '1. Make ONE focused curl call, not a shotgun.',
    '2. Parse JSON and answer in ≤10 lines if the question is simple.',
    '3. If a chart is useful, emit it in a <chart> block — see below.',
    '',
    '## Chart rendering',
    'To show data visually, emit a fenced JSON block between <chart>…</chart> tags. The dashboard renders it inline with Recharts. Spec:',
    '',
    '```',
    '<chart type="bar" title="Titre lisible" unit="tokens">',
    '{"labels":["Claude","Codex"],"values":[15000,3200]}',
    '</chart>',
    '```',
    '',
    'Supported types: `bar` (colonnes), `line` (courbe), `area` (courbe remplie), `donut` (camembert).',
    'Multi-series: use `{"labels":[...], "series":[{"name":"Claude","values":[...]},{"name":"Codex","values":[...]}]}`.',
    'Keep charts focused: ≤10 points, clear title, explicit unit. One chart per question unless truly multi-dimensional.',
  ].join('\n');
}

function buildConversationPrompt(
  history: MessageRow[],
  _userContent: string,
  contextPrelude: string,
  summary: { text: string; turnsCovered: number } | null = null,
  mode: AgentMode = 'chat',
  locale: Locale = 'fr',
): string {
  const truncated = history.length > MAX_HISTORY_TURNS;
  const tail = history.slice(-MAX_HISTORY_TURNS);

  const conversationLines = tail
    .map((message) => {
      const role =
        message.role === 'assistant' ? 'ASSISTANT' : message.role === 'tool' ? 'TOOL' : 'USER';
      const content = (message.content || '').trim();
      return `${role}:\n${content}`;
    })
    .join('\n\n');

  const summaryBlock = summary
    ? `<conversation-summary covers="${summary.turnsCovered} earlier turns">\n${summary.text.trim()}\n</conversation-summary>`
    : null;

  const preamble =
    truncated && !summaryBlock
      ? `Note: only the last ${MAX_HISTORY_TURNS} turns are shown (older context trimmed).`
      : null;

  const modeBlock = getAgentMode(mode, locale).systemAddendum;

  return [
    buildSystemInstructions(),
    '',
    modeBlock,
    '',
    contextPrelude,
    summaryBlock,
    preamble,
    '<conversation>',
    conversationLines,
    '</conversation>',
    '',
    'ASSISTANT:',
  ]
    .filter((part): part is string => part !== null && part.length > 0)
    .join('\n')
    .trim();
}

function assistantContentFromExec(result: AgentExecResult): string {
  const text = (result.text || '').trim();
  if (text.length > 0) {
    return text;
  }

  if (result.stderr && result.stderr.trim().length > 0) {
    return `No output returned.\n\n${result.stderr.trim()}`;
  }

  return '(No output)';
}

function resolveProjectForCwd(
  db: Database,
  cwd: string,
): { id: string; name: string; path: string } | null {
  const normalized = resolve(cwd);
  const rows = db
    .query<{ id: string; name: string; path: string }, []>(
      'SELECT id, name, path FROM projects ORDER BY LENGTH(path) DESC',
    )
    .all();
  for (const row of rows) {
    if (isSubPath(normalized, row.path)) {
      return row;
    }
  }
  return null;
}

async function prepareSessionRun(
  db: Database,
  settings: Settings,
  session: SessionRow,
  content: string,
  mode: AgentMode = 'chat',
  abortSignal?: AbortSignal,
): Promise<{
  provider: AgentProvider;
  cwd: string;
  model: string | undefined;
  mode: AgentMode;
  project: { id: string; name: string; path: string } | null;
  context: SessionContext;
  snapshot: Awaited<ReturnType<typeof buildContextSnapshot>>;
  userMessage: MessageRow;
  prompt: string;
  /** Tokens spent on the conversation-summary refresh during this turn (null if no refresh). */
  summaryUsage: AgentUsage | null;
  /** Surface-level error from the summary pass (null if ok / skipped). */
  summaryError: string | null;
}> {
  const context = parseJson<SessionContext>(session.context_json, {
    provider: 'claude',
    cwd: process.cwd(),
  });

  const provider: AgentProvider = context.provider || 'claude';
  const cwd = normalizeAllowedCwd(
    settings,
    typeof context.cwd === 'string' ? context.cwd : undefined,
  );
  const model = typeof context.model === 'string' ? context.model : undefined;

  const project = resolveProjectForCwd(db, cwd);

  const snapshot = await buildContextSnapshot({
    db,
    settings,
    projectId: project?.id || null,
    projectName: project?.name || null,
    projectPath: project?.path || cwd,
    sessionId: session.id,
    userMessage: content,
  });
  const contextPrelude = renderContextPrelude(snapshot);

  // Mark the memories we just pulled into context as "used now" — this feeds
  // the decay scoring so frequently-useful facts float to the top over time.
  const usedMemoryIds = [
    ...snapshot.memories.global.map((memory) => memory.id),
    ...snapshot.memories.project.map((memory) => memory.id),
    ...snapshot.memories.session.map((memory) => memory.id),
  ];
  touchMemoriesUsed(db, usedMemoryIds);

  const previousMessages = messagesBySession(db, session.id, 200);

  // Rolling summary: when we have enough history, compress everything except
  // the last RECENT_TURNS into a running brief. Saves tokens and preserves
  // continuity on long conversations. Best-effort: if the summary pass fails
  // we fall back to the classic "only last N turns shown" preamble.
  const existingSummary = readSummaryFromContext(session.context_json);
  const previousSummaryCoveredTurns = existingSummary?.turnsCovered ?? 0;
  const oldestTs =
    previousMessages.length > 0 ? previousMessages[0].ts : Math.floor(Date.now() / 1000);
  const decision = decideSummary(
    previousMessages.length,
    existingSummary?.coveredThroughTs ?? null,
    oldestTs,
    previousSummaryCoveredTurns,
  );

  let summary: { text: string; turnsCovered: number } | null = existingSummary
    ? { text: existingSummary.text, turnsCovered: existingSummary.turnsCovered }
    : null;
  let summaryUsage: AgentUsage | null = null;
  let summaryError: string | null = null;

  if (decision.kind === 'refresh') {
    const toSummarise = previousMessages.slice(0, decision.coverableMessages);
    if (toSummarise.length > 0) {
      const lastCovered = toSummarise[toSummarise.length - 1];
      const memoriesBlock = [
        ...snapshot.memories.global.map((m) => `- [global] ${m.key}: ${m.content}`),
        ...snapshot.memories.project.map((m) => `- [project] ${m.key}: ${m.content}`),
        ...snapshot.memories.session.map((m) => `- [session] ${m.key}: ${m.content}`),
      ].join('\n');

      try {
        const refresh = await refreshConversationSummary({
          db,
          provider,
          model,
          cwd,
          messagesToSummarise: toSummarise,
          previousSummary: existingSummary?.text || null,
          existingMemoriesBlock: memoriesBlock,
          timeoutMs: CONVERSATION_SUMMARY_REFRESH_TIMEOUT_MS,
          abortSignal,
        });
        summaryUsage = refresh.usage;
        if (!refresh.ok && refresh.error) {
          summaryError = refresh.error;
        }
        if (refresh.ok && refresh.text) {
          summary = { text: refresh.text, turnsCovered: toSummarise.length };
          const record = {
            text: refresh.text,
            turnsCovered: toSummarise.length,
            generatedAt: Math.floor(Date.now() / 1000),
            coveredThroughTs: lastCovered.ts,
          };
          const nextContext = writeSummaryToContext(session.context_json, record);
          db.query('UPDATE agent_sessions SET context_json = ? WHERE id = ?').run(
            nextContext,
            session.id,
          );
          // Mutate the in-memory session so downstream code reads the fresh context.
          session.context_json = nextContext;
        }
      } catch (error) {
        // best-effort: keep any existing summary, surface the failure.
        summaryError = String(error).slice(0, 200);
      }
    }
  }
  // Reference to silence unused-var lint; RECENT_TURNS is exported for future use.
  void RECENT_TURNS;
  const userMessage = appendMessage(db, {
    sessionId: session.id,
    role: 'user',
    content,
    toolCalls: {
      context: {
        personaLoaded: Boolean(snapshot.persona.identity || snapshot.persona.values),
        projectId: snapshot.projectId,
        projectName: snapshot.projectName,
        memoriesGlobal: snapshot.memories.global.length,
        memoriesProject: snapshot.memories.project.length,
        memoriesSession: snapshot.memories.session.length,
        vaultMatches: snapshot.vaultMatches.map((match) => ({
          path: match.path,
          title: match.title,
        })),
        tokensEstimate: snapshot.tokensEstimate,
      },
    },
  });

  // The DB keeps the RAW user content (no output-contract scaffolding) so the
  // history stays clean across modes. The CLI, however, sees the WRAPPED
  // version so the current turn's mode guides the assistant output. Locale
  // drives which language the system prompt / output contract is rendered in
  // so the assistant answers natively in the user's chosen locale.
  const locale = await currentLocale();
  const wrappedContent = getAgentMode(mode, locale).userWrap(content);
  const turnMessage: MessageRow = { ...userMessage, content: wrappedContent };
  const prompt = buildConversationPrompt(
    [...previousMessages, turnMessage],
    content,
    contextPrelude,
    summary,
    mode,
    locale,
  );

  return {
    provider,
    cwd,
    model,
    mode,
    project,
    context,
    snapshot,
    userMessage,
    prompt,
    summaryUsage,
    summaryError,
  };
}

function finalizeAssistantMessage(
  db: Database,
  session: SessionRow,
  baseContext: SessionContext,
  cwd: string,
  model: string | undefined,
  provider: AgentProvider,
  execResult: AgentExecResult,
  project: { id: string; name: string; path: string } | null,
  extra: {
    summaryUsage?: AgentUsage | null;
    memoryPassUsage?: AgentUsage | null;
    activities?: unknown[] | null;
  } = {},
): { assistantMessage: MessageRow; extractedMemories: number; assistantContent: string } {
  const assistantContent = assistantContentFromExec(execResult);

  const assistantMessage = appendMessage(db, {
    sessionId: session.id,
    role: 'assistant',
    content: assistantContent,
    toolCalls: {
      provider: execResult.provider,
      command: execResult.command,
      exitCode: execResult.exitCode,
      durationMs: execResult.durationMs,
      ok: execResult.ok,
      timedOut: execResult.timedOut,
      model: execResult.model,
      usage: execResult.usage,
      costUsd: execResult.costUsd,
      remoteSessionId: execResult.remoteSessionId,
      // Side-costs charged to this turn — summary refresh + memory distillation
      // pass. Must be summed into the session total for honest reporting.
      summaryUsage: extra.summaryUsage ?? null,
      memoryPassUsage: extra.memoryPassUsage ?? null,
      // Persisted tool-use/tool-result timeline so the UI can replay it on
      // reload (previously only available during the live SSE stream).
      activities: extra.activities ?? null,
    },
  });

  if (execResult.remoteSessionId && execResult.provider === 'claude') {
    // Re-read from DB so we don't clobber fields (e.g. `summary`) that were
    // written DURING this turn by prepareSessionRun → refreshConversationSummary.
    const latest = sessionById(db, session.id);
    const latestContext = parseJson<Record<string, unknown>>(latest?.context_json || null, {});
    const freshContext: SessionContext = {
      ...(latestContext as SessionContext),
      ...baseContext,
      ...latestContext, // keep any nested fields (summary, etc.) not in baseContext
      provider,
      cwd,
      ...(model ? { model } : {}),
      claudeRemoteSessionId: execResult.remoteSessionId,
    };
    db.query('UPDATE agent_sessions SET context_json = ?, updated_at = ? WHERE id = ?').run(
      JSON.stringify(freshContext),
      nowSec(),
      session.id,
    );
  }

  let extractedMemories = 0;
  if (execResult.ok) {
    const defaultScope = project ? `project:${project.id}` : `session:${session.id}`;
    const extracted = extractMemoriesFromReply(assistantContent);
    for (const item of extracted) {
      const scope = item.scope
        ? item.scope === 'global'
          ? 'global'
          : item.scope === 'project' && project
            ? `project:${project.id}`
            : item.scope === 'session'
              ? `session:${session.id}`
              : defaultScope
        : defaultScope;

      createMemory(db, {
        scope,
        key: item.key,
        content: item.content,
        source: 'auto',
        relatedProjectId: project?.id || null,
        relatedSessionId: session.id,
      });
      extractedMemories += 1;
    }
  }

  return { assistantMessage, extractedMemories, assistantContent };
}

async function sendInSession(
  db: Database,
  settings: Settings,
  session: SessionRow,
  content: string,
  timeoutMs?: number,
  mode: AgentMode = 'chat',
): Promise<{
  result: AgentExecResult;
  userMessage: MessageRow;
  assistantMessage: MessageRow;
  injectedMemories: string[];
  extractedMemories: number;
}> {
  const { provider, cwd, model, project, context, snapshot, userMessage, prompt, summaryUsage } =
    await prepareSessionRun(db, settings, session, content, mode);

  const execResult = await execAgentCli({
    provider,
    prompt,
    cwd,
    model,
    timeoutMs,
    toolPolicy: AGENT_MODES[mode].toolPolicy,
    bashAllowlist: AGENT_MODES[mode].bashAllowlist,
    permissionMode: AGENT_MODES[mode].permissionMode,
  });

  const { assistantMessage, extractedMemories } = finalizeAssistantMessage(
    db,
    session,
    context,
    cwd,
    model,
    provider,
    execResult,
    project,
    { summaryUsage },
  );

  return {
    result: execResult,
    userMessage,
    assistantMessage,
    injectedMemories: [
      ...snapshot.memories.global.map((memory) => memory.key),
      ...snapshot.memories.project.map((memory) => memory.key),
      ...snapshot.memories.session.map((memory) => memory.key),
    ],
    extractedMemories,
  };
}

function buildQuickPrompt(
  db: Database,
  command: string,
  payload: z.infer<typeof QuickSchema>,
): QuickPromptResult {
  if (command === 'project-summary') {
    if (!payload.projectId) {
      throw new Error('missing_project_id');
    }

    const project = db
      .query(
        'SELECT id, name, path, type, description, health_score, last_commit_at, uncommitted, loc FROM projects WHERE id = ? LIMIT 1',
      )
      .get(payload.projectId) as {
      id: string;
      name: string;
      path: string;
      type: string;
      description: string | null;
      health_score: number;
      last_commit_at: number | null;
      uncommitted: number;
      loc: number | null;
    } | null;

    if (!project) {
      throw new Error('project_not_found');
    }

    const prompt = [
      `Fais un résumé opérationnel de ce projet: ${project.name}.`,
      `Type: ${project.type}`,
      `Description: ${project.description || 'n/a'}`,
      `Health score: ${project.health_score}/100`,
      `Dernier commit (unix): ${project.last_commit_at || 0}`,
      `Fichiers modifiés localement: ${project.uncommitted}`,
      `LoC: ${project.loc || 0}`,
      '',
      'Rends 4 sections concises:',
      '1) Problème résolu',
      '2) Etat actuel',
      '3) Risques et blocages',
      "4) Next best action unique pour aujourd'hui",
    ].join('\n');

    return {
      title: `Project summary: ${project.name}`,
      prompt,
      cwd: project.path,
    };
  }

  if (command === 'project-critique') {
    if (!payload.projectId) {
      throw new Error('missing_project_id');
    }

    const project = db
      .query(
        'SELECT id, name, path, type, description, health_score, uncommitted FROM projects WHERE id = ? LIMIT 1',
      )
      .get(payload.projectId) as {
      id: string;
      name: string;
      path: string;
      type: string;
      description: string | null;
      health_score: number;
      uncommitted: number;
    } | null;

    if (!project) {
      throw new Error('project_not_found');
    }

    const prompt = [
      `Critique technique de ${project.name}.`,
      `Type: ${project.type}`,
      `Description: ${project.description || 'n/a'}`,
      `Health score: ${project.health_score}/100`,
      `Dirty files: ${project.uncommitted}`,
      '',
      'Réponds court avec:',
      '- 3 faiblesses critiques',
      '- 3 améliorations à fort impact',
      '- 1 plan exécutable sur 2 jours',
    ].join('\n');

    return {
      title: `Project critique: ${project.name}`,
      prompt,
      cwd: project.path,
    };
  }

  if (command === 'usage-weekly') {
    const rows = db
      .query(
        `SELECT date, input_tokens, output_tokens, cost_usd
         FROM usage_daily
         ORDER BY date DESC
         LIMIT 14`,
      )
      .all() as Array<{
      date: string;
      input_tokens: number;
      output_tokens: number;
      cost_usd: number;
    }>;

    const ordered = [...rows].sort((a, b) => a.date.localeCompare(b.date));

    const prompt = [
      'Analyse cette série usage LLM des 14 derniers jours.',
      JSON.stringify(ordered, null, 2),
      '',
      'Donne:',
      '1) tendances clés (tokens/coût)',
      '2) anomalies potentielles',
      '3) 3 actions de réduction de coût sans perte de vélocité',
    ].join('\n');

    return {
      title: 'Usage weekly analysis',
      prompt,
    };
  }

  if (command === 'vault-orphans') {
    const rows = db
      .query(
        `SELECT path, title, modified
         FROM obsidian_notes n
         LEFT JOIN obsidian_links l ON l.dst = n.path
         GROUP BY n.path
         HAVING COUNT(l.src) = 0
         ORDER BY n.modified DESC
         LIMIT 30`,
      )
      .all() as Array<{ path: string; title: string; modified: number }>;

    const prompt = [
      'Tu analyses des notes Obsidian orphelines (sans backlinks).',
      JSON.stringify(rows, null, 2),
      '',
      'Propose 10 connexions pertinentes à créer:',
      '- pour chaque note, suggère 1 ou 2 liens entrants possibles',
      '- justifie chaque lien en une phrase',
      '- priorise impact cognitif élevé',
    ].join('\n');

    return {
      title: 'Vault orphans linking',
      prompt,
    };
  }

  throw new Error('unknown_quick_command');
}

const MemoryCreateSchema = z.object({
  scope: z.string().regex(/^(global|project:[\w-]+|session:[\w-]+)$/),
  key: z.string().min(1).max(120),
  content: z.string().min(1),
  source: z.enum(['manual', 'auto', 'persona']).default('manual'),
  relatedProjectId: z.string().optional().nullable(),
  relatedSessionId: z.string().optional().nullable(),
  tags: z.array(z.string()).optional(),
  pinned: z.boolean().optional(),
});

const MemoryUpdateSchema = z.object({
  content: z.string().optional(),
  key: z.string().optional(),
  pinned: z.boolean().optional(),
  tags: z.array(z.string()).optional(),
});

const ContextPreviewSchema = z.object({
  sessionId: z.string().optional(),
  projectId: z.string().optional(),
  cwd: z.string().optional(),
  userMessage: z.string().default(''),
});

export function registerAgentRoutes(app: Hono): void {
  app.get('/api/agent/providers', (c) => {
    return c.json({
      mode: 'cli',
      providers: PROVIDERS,
    });
  });

  app.post('/api/agent/context', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = ContextPreviewSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid_payload', details: parsed.error.flatten() }, 400);
    }

    const db = getDb();
    const settings = await loadSettings();

    let projectId = parsed.data.projectId || null;
    let projectName: string | null = null;
    let projectPath: string | null = null;

    if (projectId) {
      const row = db
        .query<{ id: string; name: string; path: string }, [string]>(
          'SELECT id, name, path FROM projects WHERE id = ? LIMIT 1',
        )
        .get(projectId);
      if (row) {
        projectName = row.name;
        projectPath = row.path;
      } else {
        projectId = null;
      }
    }

    if (!projectId && parsed.data.cwd) {
      try {
        const cwd = normalizeAllowedCwd(settings, parsed.data.cwd);
        const resolved = resolveProjectForCwd(db, cwd);
        if (resolved) {
          projectId = resolved.id;
          projectName = resolved.name;
          projectPath = resolved.path;
        } else {
          projectPath = cwd;
        }
      } catch {
        // ignore
      }
    }

    if (!projectId && parsed.data.sessionId) {
      const session = sessionById(db, parsed.data.sessionId);
      if (session?.context_json) {
        try {
          const context = JSON.parse(session.context_json) as { cwd?: string };
          if (context.cwd) {
            const resolved = resolveProjectForCwd(db, context.cwd);
            if (resolved) {
              projectId = resolved.id;
              projectName = resolved.name;
              projectPath = resolved.path;
            } else {
              projectPath = context.cwd;
            }
          }
        } catch {
          // ignore
        }
      }
    }

    // When the composer is empty, fall back to the last user message of the
    // session so the Vault RAG preview still shows relevant notes instead of
    // the "0/5 · tape ton prompt" placeholder.
    let queryText = parsed.data.userMessage.trim();
    let queryFallback: 'prompt' | 'last_user' | 'session_title' | 'none' = 'prompt';
    if (queryText.length === 0 && parsed.data.sessionId) {
      const lastUser = db
        .query<{ content: string | null }, [string]>(
          `SELECT content FROM agent_messages
           WHERE session_id = ? AND role = 'user'
           ORDER BY ts DESC LIMIT 1`,
        )
        .get(parsed.data.sessionId);
      if (lastUser?.content) {
        queryText = lastUser.content.trim();
        queryFallback = 'last_user';
      }
    }
    if (queryText.length === 0 && parsed.data.sessionId) {
      const session = sessionById(db, parsed.data.sessionId);
      if (session?.title) {
        queryText = session.title;
        queryFallback = 'session_title';
      }
    }
    if (queryText.length === 0) {
      queryFallback = 'none';
    }

    const snapshot = await buildContextSnapshot({
      db,
      settings,
      projectId,
      projectName,
      projectPath,
      sessionId: parsed.data.sessionId || null,
      userMessage: queryText,
    });

    return c.json({ ...snapshot, queryFallback, queryPreview: queryText.slice(0, 120) });
  });

  app.get('/api/agent/memories', (c) => {
    const db = getDb();
    const scope = c.req.query('scope');
    if (!scope) {
      return c.json({ error: 'missing_scope' }, 400);
    }
    const limit = Math.min(Number.parseInt(c.req.query('limit') || '50', 10), 200);
    const rows = listMemories(db, scope, limit);
    return c.json(rows);
  });

  app.post('/api/agent/memories', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = MemoryCreateSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid_payload', details: parsed.error.flatten() }, 400);
    }

    const db = getDb();
    const row = createMemory(db, {
      scope: parsed.data.scope,
      key: parsed.data.key,
      content: parsed.data.content,
      source: parsed.data.source,
      relatedProjectId: parsed.data.relatedProjectId || null,
      relatedSessionId: parsed.data.relatedSessionId || null,
      tags: parsed.data.tags,
      pinned: parsed.data.pinned,
    });

    // Mirror to vault markdown (best-effort).
    try {
      const settings = await loadSettings();
      await syncMemoriesToVault({ settings, db, memories: [row] });
    } catch {
      /* ignore */
    }

    return c.json(row);
  });

  app.put('/api/agent/memories/:id', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = MemoryUpdateSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid_payload', details: parsed.error.flatten() }, 400);
    }
    const db = getDb();
    const row = updateMemory(db, c.req.param('id'), parsed.data);
    if (!row) {
      return c.json({ error: 'memory_not_found' }, 404);
    }
    return c.json(row);
  });

  app.delete('/api/agent/memories/:id', (c) => {
    const db = getDb();
    const ok = deleteMemory(db, c.req.param('id'));
    if (!ok) {
      return c.json({ error: 'memory_not_found' }, 404);
    }
    return c.json({ ok: true });
  });

  app.post('/api/agent/exec', async (c) => {
    const body = await c.req.json();
    const parsed = ExecSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid_payload', details: parsed.error.flatten() }, 400);
    }

    try {
      const settings = await loadSettings();
      const cwd = normalizeAllowedCwd(settings, parsed.data.cwd);

      const result = await execAgentCli({
        provider: parsed.data.provider,
        prompt: parsed.data.prompt,
        cwd,
        model: parsed.data.model,
        timeoutMs: parsed.data.timeoutMs,
      });

      return c.json(result, result.ok ? 200 : 500);
    } catch (error) {
      if (String(error).includes('cwd_not_allowed')) {
        return c.json(
          {
            error: 'cwd_not_allowed',
            details: 'cwd must be inside one of settings.paths.projectsRoots or vaultPath',
          },
          400,
        );
      }

      return c.json(
        {
          ok: false,
          error: 'agent_exec_failed',
          details: String(error),
        },
        500,
      );
    }
  });

  app.get('/api/agent/sessions', (c) => {
    const db = getDb();
    const limit = Math.min(Number.parseInt(c.req.query('limit') || '50', 10), 200);
    const rows = sessionSummaryQuery(db, limit).map(toSessionResponse);
    return c.json(rows);
  });

  app.post('/api/agent/sessions', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = SessionCreateSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid_payload', details: parsed.error.flatten() }, 400);
    }

    try {
      const settings = await loadSettings();
      const db = getDb();

      const cwd = normalizeAllowedCwd(settings, parsed.data.cwd);

      const session = insertSession(db, {
        provider: parsed.data.provider,
        cwd,
        model: parsed.data.model,
        title: parsed.data.title,
        context: parsed.data.context,
      });

      return c.json(toSessionResponse(session));
    } catch (error) {
      if (String(error).includes('cwd_not_allowed')) {
        return c.json({ error: 'cwd_not_allowed' }, 400);
      }

      return c.json({ error: 'session_create_failed', details: String(error) }, 500);
    }
  });

  app.get('/api/agent/sessions/:id', (c) => {
    const db = getDb();
    const id = c.req.param('id');

    const session = sessionById(db, id);
    if (!session || session.archived) {
      return c.json({ error: 'session_not_found' }, 404);
    }

    const messages = messagesBySession(db, id, 500);

    return c.json({
      session: toSessionResponse(session),
      messages,
    });
  });

  app.post('/api/agent/sessions/:id/send', async (c) => {
    const db = getDb();
    const id = c.req.param('id');

    const body = await c.req.json();
    const parsed = SessionSendSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid_payload', details: parsed.error.flatten() }, 400);
    }

    const session = sessionById(db, id);
    if (!session || session.archived) {
      return c.json({ error: 'session_not_found' }, 404);
    }

    // Serialize sends per session: two parallel POSTs would otherwise race on
    // context_json (summary, claudeRemoteSessionId) and message ordering.
    return withLock(`session:${id}`, async () => {
      try {
        const settings = await loadSettings();
        const run = await sendInSession(
          db,
          settings,
          session,
          parsed.data.content,
          parsed.data.timeoutMs,
          parsed.data.mode,
        );

        return c.json({
          ok: run.result.ok,
          sessionId: id,
          userMessage: run.userMessage,
          assistantMessage: run.assistantMessage,
          result: run.result,
          injectedMemories: run.injectedMemories,
          extractedMemories: run.extractedMemories,
        });
      } catch (error) {
        if (String(error).includes('cwd_not_allowed')) {
          return c.json({ error: 'cwd_not_allowed' }, 400);
        }

        return c.json({ error: 'session_send_failed', details: String(error) }, 500);
      }
    });
  });

  app.post('/api/agent/sessions/:id/stream', async (c) => {
    const db = getDb();
    const id = c.req.param('id');

    const body = await c.req.json().catch(() => ({}));
    const parsed = SessionSendSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid_payload', details: parsed.error.flatten() }, 400);
    }

    const session = sessionById(db, id);
    if (!session || session.archived) {
      return c.json({ error: 'session_not_found' }, 404);
    }

    // Acquire per-session lock. Serialises prepareSessionRun + stream +
    // finalize. The lock is held until the stream finishes (see release() in
    // the stream's finally). Concurrent POSTs to the same session queue FIFO.
    const releaseSessionLock = await acquireLock(`session:${id}`);

    let settings: Settings;
    try {
      settings = await loadSettings();
    } catch (error) {
      releaseSessionLock();
      return c.json({ error: 'settings_load_failed', details: String(error) }, 500);
    }

    // Route-level AbortController first so prepareSessionRun (which may do a
    // long CLI call for conversation summary) respects client disconnects.
    // Route-level AbortController: wired both to client disconnect and to a
    // hard ceiling (ROUTE_HARD_CEILING_MS). Even if the CLI ignores SIGKILL
    // because sub-agent processes hold the pipe, the stream will be force-closed
    // and the reader inside execAgentCliStream cancelled — no 9-minute hang.
    const ROUTE_HARD_CEILING_MS = 4 * 60 * 1000;
    const routeAbort = new AbortController();
    const clientSignal = c.req.raw.signal;
    if (clientSignal.aborted) {
      routeAbort.abort();
    } else {
      clientSignal.addEventListener('abort', () => routeAbort.abort(), { once: true });
    }
    const hardCeiling = setTimeout(() => {
      if (!routeAbort.signal.aborted) {
        routeAbort.abort();
      }
    }, ROUTE_HARD_CEILING_MS);

    let preparation: Awaited<ReturnType<typeof prepareSessionRun>>;
    try {
      preparation = await prepareSessionRun(
        db,
        settings,
        session,
        parsed.data.content,
        parsed.data.mode,
        routeAbort.signal,
      );
    } catch (error) {
      clearTimeout(hardCeiling);
      releaseSessionLock();
      if (String(error).includes('cwd_not_allowed')) {
        return c.json({ error: 'cwd_not_allowed' }, 400);
      }
      return c.json({ error: 'session_send_failed', details: String(error) }, 500);
    }

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        let closed = false;
        const safeEnqueue = (chunk: Uint8Array): boolean => {
          if (closed) return false;
          try {
            controller.enqueue(chunk);
            return true;
          } catch {
            closed = true;
            routeAbort.abort();
            return false;
          }
        };

        const write = (event: AgentStreamEvent) => {
          const line = `data: ${JSON.stringify(event)}\n\n`;
          safeEnqueue(encoder.encode(line));
        };

        // Heartbeat SSE comment every 2 s. When the client disconnects, the
        // next enqueue fails → we flip `closed` and trigger routeAbort, which
        // kills the CLI and cancels the reader. Bun/Hono do not always fire
        // Request.signal on raw socket close, so this is our reliable detector.
        const heartbeat = setInterval(() => {
          safeEnqueue(encoder.encode(': heartbeat\n\n'));
        }, 2_000);

        write({
          type: 'start',
          provider: preparation.provider,
          command: ['(preparing)'],
        });

        // Surface any summary-pass failure to the client. Does not block
        // the turn: we already fell back to the previous summary (if any).
        if (preparation.summaryError) {
          safeEnqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                type: 'summary_error',
                message: preparation.summaryError,
              })}\n\n`,
            ),
          );
        }

        let execResult: AgentExecResult | null = null;
        // Collect activities (tool_use, tool_result, thinking, task_start,
        // subagent) so we can persist them with the assistant message. This
        // allows the UI to replay the timeline after a reload.
        const collectedActivities: unknown[] = [];

        try {
          for await (const event of execAgentCliStream({
            provider: preparation.provider,
            prompt: preparation.prompt,
            cwd: preparation.cwd,
            model: preparation.model,
            timeoutMs: parsed.data.timeoutMs,
            toolPolicy: AGENT_MODES[preparation.mode].toolPolicy,
            bashAllowlist: AGENT_MODES[preparation.mode].bashAllowlist,
            permissionMode: AGENT_MODES[preparation.mode].permissionMode,
            abortSignal: routeAbort.signal,
          })) {
            write(event);
            if (
              event.type === 'tool_use' ||
              event.type === 'tool_result' ||
              event.type === 'thinking' ||
              event.type === 'subagent' ||
              event.type === 'task_start'
            ) {
              collectedActivities.push(event);
            }
            if (event.type === 'done') {
              execResult = event.result;
            }
          }
        } catch (error) {
          write({ type: 'error', message: String(error) });
        }

        if (execResult) {
          // Karpathy-style write-back pass: run BEFORE persisting the assistant
          // message so its usage can be stored alongside the turn (honest cost
          // tracking). If the client disconnected (routeAbort fired), skip.
          let memoryPassExtracted = 0;
          let memoryPassSkipped = 0;
          let memoryPassDurationMs = 0;
          let memoryPassUsage: AgentUsage | null = null;
          const memoryPassItems: Array<{ key: string; content: string; scope: string }> = [];
          const assistantContentPreview = assistantContentFromExec(execResult);

          if (
            execResult.ok &&
            assistantContentPreview.trim().length > 0 &&
            !routeAbort.signal.aborted &&
            !closed
          ) {
            safeEnqueue(
              encoder.encode(`data: ${JSON.stringify({ type: 'memory_pass_start' })}\n\n`),
            );
            try {
              const passResult = await runMemoryPass({
                db,
                settings,
                provider: preparation.provider,
                model: preparation.model,
                cwd: preparation.cwd,
                projectId: preparation.project?.id || null,
                sessionId: id,
                userMessage: parsed.data.content,
                assistantReply: assistantContentPreview,
                timeoutMs: 25_000,
                mode: preparation.mode,
                abortSignal: routeAbort.signal,
              });
              memoryPassExtracted = passResult.extracted;
              memoryPassSkipped = passResult.skippedDuplicates;
              memoryPassDurationMs = passResult.durationMs;
              memoryPassUsage = passResult.usage;
              memoryPassItems.push(...passResult.items);
            } catch {
              // swallow — pass is best-effort; the conversation still finalizes cleanly
            }
            safeEnqueue(
              encoder.encode(
                `data: ${JSON.stringify({
                  type: 'memory_pass_done',
                  extracted: memoryPassExtracted,
                  skippedDuplicates: memoryPassSkipped,
                  durationMs: memoryPassDurationMs,
                  items: memoryPassItems,
                })}\n\n`,
              ),
            );
          }

          const { assistantMessage, extractedMemories } = finalizeAssistantMessage(
            db,
            session,
            preparation.context,
            preparation.cwd,
            preparation.model,
            preparation.provider,
            execResult,
            preparation.project,
            {
              summaryUsage: preparation.summaryUsage,
              memoryPassUsage,
              activities: collectedActivities,
            },
          );

          const finalPayload = {
            type: 'finalized' as const,
            sessionId: id,
            userMessage: preparation.userMessage,
            assistantMessage,
            extractedMemories: extractedMemories + memoryPassExtracted,
            extractedFromReply: extractedMemories,
            extractedFromPass: memoryPassExtracted,
            passDurationMs: memoryPassDurationMs,
            injectedMemories: [
              ...preparation.snapshot.memories.global.map((memory) => memory.key),
              ...preparation.snapshot.memories.project.map((memory) => memory.key),
              ...preparation.snapshot.memories.session.map((memory) => memory.key),
            ],
          };
          safeEnqueue(encoder.encode(`data: ${JSON.stringify(finalPayload)}\n\n`));
        }

        clearInterval(heartbeat);
        clearTimeout(hardCeiling);
        closed = true;
        try {
          controller.close();
        } catch {
          /* already closed */
        }
        releaseSessionLock();
      },
      cancel() {
        clearTimeout(hardCeiling);
        routeAbort.abort();
        releaseSessionLock();
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      },
    });
  });

  app.delete('/api/agent/sessions/:id', (c) => {
    const db = getDb();
    const id = c.req.param('id');

    const session = sessionById(db, id);
    if (!session) {
      return c.json({ error: 'session_not_found' }, 404);
    }

    db.query('UPDATE agent_sessions SET archived = 1, updated_at = ? WHERE id = ?').run(
      nowSec(),
      id,
    );
    return c.json({ ok: true, id });
  });

  app.post('/api/agent/sessions/:id/archive-to-vault', async (c) => {
    const db = getDb();
    const id = c.req.param('id');

    const session = sessionById(db, id);
    if (!session) {
      return c.json({ error: 'session_not_found' }, 404);
    }

    const messages = messagesBySession(db, id, 500);
    if (messages.length === 0) {
      return c.json({ error: 'session_empty' }, 400);
    }

    const settings = await loadSettings();
    if (!settings.paths.vaultPath) {
      return c.json({ error: 'vault_not_configured' }, 400);
    }

    const context = parseJson<SessionContext>(session.context_json, {
      provider: 'claude',
      cwd: process.cwd(),
    });
    const project = typeof context.cwd === 'string' ? resolveProjectForCwd(db, context.cwd) : null;

    try {
      const result = await archiveSessionToVault({
        settings,
        db,
        session,
        messages,
        project,
      });
      return c.json({ ok: true, ...result });
    } catch (error) {
      const reason = String(error);
      if (reason.includes('vault_not_configured')) {
        return c.json({ error: 'vault_not_configured' }, 400);
      }
      return c.json({ error: 'archive_failed', details: reason }, 500);
    }
  });

  app.post('/api/agent/quick/:command', async (c) => {
    const command = c.req.param('command');
    const body = await c.req.json().catch(() => ({}));
    const parsed = QuickSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid_payload', details: parsed.error.flatten() }, 400);
    }

    const db = getDb();

    let quick: QuickPromptResult;
    try {
      quick = buildQuickPrompt(db, command, parsed.data);
    } catch (error) {
      const reason = String(error);
      if (reason.includes('unknown_quick_command')) {
        return c.json({ error: 'unknown_quick_command' }, 404);
      }
      if (reason.includes('missing_project_id')) {
        return c.json({ error: 'missing_project_id' }, 400);
      }
      if (reason.includes('project_not_found')) {
        return c.json({ error: 'project_not_found' }, 404);
      }
      return c.json({ error: 'quick_prompt_failed', details: reason }, 500);
    }

    try {
      const settings = await loadSettings();

      let session = parsed.data.sessionId ? sessionById(db, parsed.data.sessionId) : null;
      if (session?.archived) {
        session = null;
      }

      if (!session) {
        const provider: AgentProvider = parsed.data.provider || 'claude';
        const cwd = normalizeAllowedCwd(settings, quick.cwd || parsed.data.cwd);

        session = insertSession(db, {
          provider,
          cwd,
          model: parsed.data.model,
          title: quick.title,
        });
      }

      const run = await sendInSession(db, settings, session, quick.prompt, parsed.data.timeoutMs);
      const latestSession = sessionById(db, session.id);

      return c.json({
        ok: run.result.ok,
        command,
        sessionId: session.id,
        session: latestSession ? toSessionResponse(latestSession) : null,
        userMessage: run.userMessage,
        assistantMessage: run.assistantMessage,
        result: run.result,
        injectedMemories: run.injectedMemories,
        extractedMemories: run.extractedMemories,
      });
    } catch (error) {
      if (String(error).includes('cwd_not_allowed')) {
        return c.json({ error: 'cwd_not_allowed' }, 400);
      }

      return c.json({ error: 'quick_command_failed', details: String(error) }, 500);
    }
  });
}
