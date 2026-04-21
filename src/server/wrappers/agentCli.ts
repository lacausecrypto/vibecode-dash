import { currentLocale, t as serverT } from '../lib/i18n';

export type AgentProvider = 'claude' | 'codex';

export type AgentExecInput = {
  provider: AgentProvider;
  prompt: string;
  cwd?: string;
  model?: string;
  timeoutMs?: number;
  resumeRemoteSessionId?: string;
  /**
   * Tool policy for the Claude CLI:
   *   - 'all'       → default, no flag, every built-in available
   *   - 'read-only' → Read, Glob, Grep, WebFetch, WebSearch (no Edit/Write/Task)
   *   - 'none'      → --tools "", pure reasoning from injected context
   * If omitted, defaults to 'all'. Codex does not support this flag — ignored.
   */
  toolPolicy?: 'all' | 'read-only' | 'none';
  /**
   * Optional Bash allowlist patterns. Only meaningful for Claude when
   * toolPolicy === 'all'. Patterns are passed verbatim to --allowedTools
   * alongside the non-Bash tool names, constraining which shell commands
   * the model may invoke.
   */
  bashAllowlist?: readonly string[];
  /**
   * Explicit permission mode. Defaults to 'skip' (no approval prompt).
   * 'plan' restricts Claude to planning without executing edits.
   */
  permissionMode?: 'skip' | 'plan';
  /**
   * Optional AbortSignal. When it fires, the CLI process is killed and the stream
   * reader is cancelled so the generator terminates promptly. Critical for
   * respecting client disconnects / explicit Stop clicks when the CLI is stuck
   * in a tool-call loop.
   */
  abortSignal?: AbortSignal;
};

export type AgentStreamEvent =
  | { type: 'start'; provider: AgentProvider; command: string[] }
  | { type: 'delta'; text: string }
  | { type: 'stalled'; sinceMs: number; reason: 'no_output' | 'tool_loop' }
  | { type: 'usage'; usage: AgentUsage; costUsd?: number | null }
  | { type: 'thinking'; text: string }
  | {
      type: 'subagent';
      text: string;
      parentToolUseId: string;
    }
  | {
      type: 'tool_use';
      toolUseId: string;
      name: string;
      input: unknown;
      parentToolUseId: string | null;
    }
  | {
      type: 'tool_result';
      toolUseId: string;
      content: string;
      isError: boolean;
      truncated: boolean;
    }
  | {
      type: 'task_start';
      taskId: string;
      toolUseId: string;
      description: string;
    }
  | { type: 'model'; model: string }
  | { type: 'session'; remoteSessionId: string }
  | { type: 'stderr'; text: string }
  | {
      type: 'done';
      result: AgentExecResult;
    }
  | { type: 'error'; message: string };

export type AgentUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheCreateTokens: number;
  cacheReadTokens: number;
  reasoningTokens?: number;
};

export type AgentExecResult = {
  ok: boolean;
  provider: AgentProvider;
  command: string[];
  exitCode: number;
  text: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  model: string | null;
  usage: AgentUsage | null;
  costUsd: number | null;
  remoteSessionId: string | null;
  rawStdout?: string;
};

const MAX_ARGV_PROMPT_BYTES = 128 * 1024;
const DEFAULT_TIMEOUT_MS = 180_000;
const KILL_GRACE_MS = 3_000;

const READ_ONLY_TOOLS = ['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch'];
const ALL_NON_BASH_TOOLS = [
  'Read',
  'Glob',
  'Grep',
  'WebFetch',
  'WebSearch',
  'Edit',
  'Write',
  'Task',
  'TodoWrite',
  'NotebookEdit',
];

function buildClaudeArgs(opts: {
  model?: string;
  resumeRemoteSessionId?: string;
  streaming?: boolean;
  toolPolicy?: 'all' | 'read-only' | 'none';
  bashAllowlist?: readonly string[];
  permissionMode?: 'skip' | 'plan';
}): string[] {
  const args = ['claude', '-p'];
  const toolPolicy = opts.toolPolicy ?? 'all';
  const permissionMode = opts.permissionMode ?? 'skip';

  if (toolPolicy === 'none') {
    args.push('--tools', '');
  } else if (toolPolicy === 'read-only') {
    args.push('--tools', READ_ONLY_TOOLS.join(','));
  } else if (opts.bashAllowlist && opts.bashAllowlist.length > 0) {
    // Combine base non-Bash tools with the explicit Bash patterns. Claude CLI
    // uses space-separated patterns for --allowedTools.
    const parts = [...ALL_NON_BASH_TOOLS, ...opts.bashAllowlist];
    args.push('--allowedTools', parts.join(' '));
  }
  // Permission mode — explicit per call site so a change in toolPolicy doesn't
  // silently flip tool-approval semantics.
  if (toolPolicy !== 'none') {
    if (permissionMode === 'plan') {
      args.push('--permission-mode', 'plan');
    } else {
      // skip: run without prompting. Required for -p mode to work with Bash.
      args.push('--dangerously-skip-permissions');
    }
  }
  if (opts.streaming) {
    args.push('--output-format', 'stream-json', '--verbose');
  } else {
    args.push('--output-format', 'json');
  }
  if (opts.model) {
    args.push('--model', opts.model);
  }
  if (opts.resumeRemoteSessionId) {
    args.push('--resume', opts.resumeRemoteSessionId);
  }
  return args;
}

function buildCodexArgs(
  prompt: string,
  model?: string,
  cwd?: string,
  toolPolicy: 'all' | 'read-only' | 'none' = 'all',
): string[] {
  const args = ['codex', 'exec', '--json', '--skip-git-repo-check'];

  // Sandbox policy: Codex doesn't expose a "disable all tools" flag, so we map:
  //   none      → read-only (plus prompt tells the model not to run commands)
  //   read-only → read-only
  //   all       → --dangerously-bypass-approvals-and-sandbox (full automation,
  //               equivalent to Claude's --dangerously-skip-permissions; safe
  //               because we run on localhost for a single trusted user)
  if (toolPolicy === 'all') {
    args.push('--dangerously-bypass-approvals-and-sandbox');
  } else {
    args.push('--sandbox', 'read-only');
  }

  if (cwd) {
    args.push('--cd', cwd);
  }
  if (model) {
    args.push('--model', model);
  }
  args.push('--', prompt);
  return args;
}

async function readStream(stream: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!stream) {
    return '';
  }
  return new Response(stream).text();
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asNumber(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  return 0;
}

/**
 * Claude CLI with --output-format json emits a single JSON object on stdout
 * with shape similar to:
 * {
 *   "type": "result",
 *   "subtype": "success" | "error_during_execution",
 *   "is_error": false,
 *   "result": "<assistant text>",
 *   "session_id": "uuid",
 *   "duration_ms": 4000,
 *   "total_cost_usd": 0.00123,
 *   "usage": {
 *     "input_tokens": 123,
 *     "output_tokens": 456,
 *     "cache_creation_input_tokens": 0,
 *     "cache_read_input_tokens": 0
 *   }
 * }
 */
function parseClaudeJson(stdout: string): {
  text: string;
  model: string | null;
  usage: AgentUsage | null;
  costUsd: number | null;
  remoteSessionId: string | null;
  parsed: boolean;
} {
  const trimmed = stdout.trim();
  if (!trimmed.startsWith('{')) {
    return {
      text: trimmed,
      model: null,
      usage: null,
      costUsd: null,
      remoteSessionId: null,
      parsed: false,
    };
  }

  let payload: Record<string, unknown> | null = null;
  try {
    payload = asRecord(JSON.parse(trimmed));
  } catch {
    return {
      text: trimmed,
      model: null,
      usage: null,
      costUsd: null,
      remoteSessionId: null,
      parsed: false,
    };
  }

  if (!payload) {
    return {
      text: trimmed,
      model: null,
      usage: null,
      costUsd: null,
      remoteSessionId: null,
      parsed: false,
    };
  }

  const usage = asRecord(payload.usage);
  const normalizedUsage: AgentUsage | null = usage
    ? {
        inputTokens: asNumber(usage.input_tokens),
        outputTokens: asNumber(usage.output_tokens),
        cacheCreateTokens: asNumber(usage.cache_creation_input_tokens),
        cacheReadTokens: asNumber(usage.cache_read_input_tokens),
      }
    : null;

  const text =
    asString(payload.result) ||
    asString(payload.message) ||
    asString((asRecord(payload.message) as Record<string, unknown> | null)?.content) ||
    '';

  return {
    text,
    model: asString(payload.model) || null,
    usage: normalizedUsage,
    costUsd:
      typeof payload.total_cost_usd === 'number'
        ? (payload.total_cost_usd as number)
        : typeof payload.cost_usd === 'number'
          ? (payload.cost_usd as number)
          : null,
    remoteSessionId: asString(payload.session_id) || null,
    parsed: true,
  };
}

/**
 * Codex CLI 0.121+ with `exec --json` emits NDJSON events of the form:
 *
 *   {"type":"thread.started","thread_id":"…"}
 *   {"type":"turn.started"}
 *   {"type":"item.started","item":{"id":"item_1","type":"command_execution","command":"…"}}
 *   {"type":"item.completed","item":{"id":"item_1","type":"command_execution","aggregated_output":"…","exit_code":0,"status":"completed"}}
 *   {"type":"item.completed","item":{"id":"item_2","type":"agent_message","text":"…"}}
 *   {"type":"turn.completed","usage":{"input_tokens":…,"cached_input_tokens":…,"output_tokens":…}}
 *
 * We concatenate all `agent_message` texts in order, take the last usage, and
 * extract the thread_id as the remote session id.
 */
function parseCodexNdjson(stdout: string): {
  text: string;
  model: string | null;
  usage: AgentUsage | null;
  remoteSessionId: string | null;
  parsed: boolean;
} {
  const lines = stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (lines.length === 0) {
    return { text: '', model: null, usage: null, remoteSessionId: null, parsed: false };
  }

  const agentTexts: string[] = [];
  const model: string | null = null; // Codex doesn't echo the model in events
  let lastUsage: AgentUsage | null = null;
  let remoteSessionId: string | null = null;
  let parsedCount = 0;

  for (const line of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const row = asRecord(parsed);
    if (!row) {
      continue;
    }
    parsedCount += 1;

    const type = asString(row.type);

    if (type === 'thread.started') {
      const threadId = asString(row.thread_id);
      if (threadId) {
        remoteSessionId = threadId;
      }
      continue;
    }

    if (type === 'item.completed') {
      const item = asRecord(row.item);
      if (!item) continue;
      const itemType = asString(item.type);
      if (itemType === 'agent_message') {
        const text = asString(item.text);
        if (text) agentTexts.push(text);
      }
      continue;
    }

    if (type === 'turn.completed') {
      const usage = asRecord(row.usage);
      if (usage) {
        lastUsage = {
          inputTokens: asNumber(usage.input_tokens),
          outputTokens: asNumber(usage.output_tokens),
          cacheCreateTokens: 0,
          cacheReadTokens: asNumber(usage.cached_input_tokens),
          reasoningTokens: asNumber(usage.reasoning_output_tokens),
        };
      }
    }
  }

  return {
    text: agentTexts.join('\n\n'),
    model,
    usage: lastUsage,
    remoteSessionId,
    parsed: parsedCount > 0,
  };
}

/**
 * Scrub absolute filesystem paths and other potentially-sensitive strings from
 * CLI stderr before handing it back to the HTTP client. The CLI is run in the
 * user's `$HOME`; raw tracebacks leak stuff like `/Users/alice/.claude/...`
 * which is noise at best and PII at worst once the UI ever ships elsewhere.
 * Keep the basename (filename + optional parent) as context — that's enough
 * to diagnose a broken script without revealing the full layout.
 */
export function sanitizeStderr(input: string): string {
  if (!input) return input;
  let out = input;
  // Absolute POSIX paths with >= 2 segments. Keep the last one.
  out = out.replace(/(?:\/[A-Za-z0-9._@-]+){2,}/g, (match) => {
    const parts = match.split('/').filter(Boolean);
    return `…/${parts[parts.length - 1]}`;
  });
  // Tilde-prefixed paths.
  out = out.replace(/~\/[A-Za-z0-9._/@-]+/g, (match) => {
    const parts = match.split('/').filter(Boolean);
    return `~/…/${parts[parts.length - 1]}`;
  });
  // Env-looking tokens that sometimes appear in stderr (CI, OAuth fallbacks…).
  out = out.replace(/\b[A-Z][A-Z0-9_]{4,}=\S+/g, (match) => {
    const eq = match.indexOf('=');
    return `${match.slice(0, eq + 1)}[redacted]`;
  });
  return out;
}

function errorFallbackText(
  stderr: string,
  stdout: string,
  exitCode: number,
  locale: 'fr' | 'en' | 'es',
): string {
  const parts: string[] = [serverT(locale, 'agent.execFailed', { exitCode })];
  if (stderr) {
    parts.push(`stderr:\n${sanitizeStderr(stderr)}`);
  }
  if (stdout) {
    parts.push(`stdout:\n${stdout}`);
  }
  return parts.join('\n\n').trim();
}

/**
 * Streaming variant. Yields AgentStreamEvent objects as the CLI produces output,
 * then a final `done` event with the aggregated AgentExecResult.
 *
 * Claude: uses `--output-format stream-json --verbose` which emits one JSON
 * object per line. We forward `text_delta` fragments progressively.
 *
 * Codex: `exec --json` already emits NDJSON. We forward `agent_message` as
 * `delta` (full replacement) + final token_count → usage.
 */
export async function* execAgentCliStream(
  input: AgentExecInput,
): AsyncGenerator<AgentStreamEvent, void, unknown> {
  const timeoutMs = input.timeoutMs || DEFAULT_TIMEOUT_MS;
  const locale = await currentLocale();
  const promptBytes = Buffer.byteLength(input.prompt, 'utf8');
  const useStdin = input.provider === 'claude' || promptBytes > MAX_ARGV_PROMPT_BYTES;

  if (input.provider === 'codex' && promptBytes > MAX_ARGV_PROMPT_BYTES) {
    yield {
      type: 'error',
      message: `prompt_too_large_for_argv (${promptBytes} bytes, max ${MAX_ARGV_PROMPT_BYTES})`,
    };
    return;
  }

  const command =
    input.provider === 'claude'
      ? buildClaudeArgs({
          model: input.model,
          resumeRemoteSessionId: input.resumeRemoteSessionId,
          streaming: true,
          toolPolicy: input.toolPolicy ?? 'all',
          bashAllowlist: input.bashAllowlist,
          permissionMode: input.permissionMode ?? 'skip',
        })
      : buildCodexArgs(input.prompt, input.model, input.cwd, input.toolPolicy ?? 'all');

  const start = Date.now();
  yield { type: 'start', provider: input.provider, command };

  const proc = Bun.spawn(command, {
    cwd: input.cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: useStdin ? new Response(input.prompt).body : 'ignore',
  });

  // Lift the stdout reader so timeout / abort handlers can cancel it directly —
  // otherwise reader.read() blocks indefinitely when the CLI spawns sub-agents
  // that keep the pipe open after we kill the parent process.
  const stdoutReader = proc.stdout ? (proc.stdout as ReadableStream<Uint8Array>).getReader() : null;

  let timedOut = false;
  let aborted = false;

  const softKill = setTimeout(() => {
    timedOut = true;
    try {
      proc.kill('SIGTERM');
    } catch {
      /* already exited */
    }
  }, timeoutMs);
  const hardKill = setTimeout(() => {
    try {
      proc.kill('SIGKILL');
    } catch {
      /* already exited */
    }
    // Critical: cancel the reader so the consuming loop unblocks even if
    // grandchildren (sub-agent processes) still hold the pipe open.
    try {
      void stdoutReader?.cancel('timeout');
    } catch {
      /* noop */
    }
  }, timeoutMs + KILL_GRACE_MS);

  const onAbort = () => {
    if (aborted) {
      return;
    }
    aborted = true;
    try {
      proc.kill('SIGKILL');
    } catch {
      /* already exited */
    }
    try {
      void stdoutReader?.cancel('aborted');
    } catch {
      /* noop */
    }
  };

  input.abortSignal?.addEventListener('abort', onAbort);

  let accumulatedText = '';
  let model: string | null = null;
  let remoteSessionId: string | null = null;
  let usage: AgentUsage | null = null;
  const costUsd: number | null = null;
  let stderrBuffer = '';
  const emittedTaskIds = new Set<string>();

  // Consume stderr in parallel so it doesn't block stdout
  const stderrPromise = (async () => {
    if (!proc.stderr) {
      return;
    }
    const reader = (proc.stderr as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      stderrBuffer += decoder.decode(value, { stream: true });
    }
  })();

  if (stdoutReader) {
    const reader = stdoutReader;
    const decoder = new TextDecoder();
    let buffer = '';

    const handleEvent = function* (event: AgentStreamEvent): Generator<AgentStreamEvent> {
      if (event.type === 'delta') {
        accumulatedText += event.text;
        if (event.text.length > 0) {
          yield event;
        }
        return;
      }
      if (event.type === 'model') {
        if (model === event.model) {
          return;
        }
        model = event.model;
        yield event;
        return;
      }
      if (event.type === 'session') {
        if (remoteSessionId === event.remoteSessionId) {
          return;
        }
        remoteSessionId = event.remoteSessionId;
        yield event;
        return;
      }
      if (event.type === 'task_start') {
        if (emittedTaskIds.has(event.taskId)) {
          return;
        }
        emittedTaskIds.add(event.taskId);
        yield event;
        return;
      }
      if (event.type === 'usage') {
        // Claude emits the same assistant message multiple times while it grows,
        // carrying identical usage snapshots. Only forward if any count changed.
        const last = usage;
        const next = event.usage;
        if (
          last &&
          last.inputTokens === next.inputTokens &&
          last.outputTokens === next.outputTokens &&
          last.cacheCreateTokens === next.cacheCreateTokens &&
          last.cacheReadTokens === next.cacheReadTokens
        ) {
          return;
        }
        usage = next;
        yield event;
        return;
      }
      yield event;
    };

    streamLoop: while (true) {
      const { value, done } = await reader.read();
      if (done) {
        if (buffer.trim().length > 0) {
          for (const event of parseStreamLine(input.provider, buffer.trim())) {
            for (const emitted of handleEvent(event)) {
              yield emitted;
            }
          }
        }
        break;
      }

      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.length === 0) {
          continue;
        }
        for (const event of parseStreamLine(input.provider, trimmed)) {
          for (const emitted of handleEvent(event)) {
            yield emitted;
            if (emitted.type === 'error') {
              break streamLoop;
            }
          }
        }
      }
    }
  }

  clearTimeout(softKill);
  clearTimeout(hardKill);
  input.abortSignal?.removeEventListener('abort', onAbort);

  // Don't block forever on proc.exited — if sub-agents are still alive and
  // holding the pipe, the parent may not exit cleanly. Cap the wait.
  const exitCode = await Promise.race<number>([
    proc.exited,
    new Promise<number>((resolve) => setTimeout(() => resolve(-1), 2000)),
  ]);
  await Promise.race<unknown>([stderrPromise, new Promise((resolve) => setTimeout(resolve, 500))]);

  const durationMs = Date.now() - start;
  const ok = exitCode === 0 && !timedOut && !aborted;
  const trimmedStderr = stderrBuffer.trim();

  if (!ok) {
    const errorText = aborted
      ? serverT(locale, 'agent.abortedByUser')
      : timedOut
        ? serverT(locale, 'agent.timeout', { seconds: Math.round(timeoutMs / 1000) })
        : errorFallbackText(trimmedStderr, accumulatedText, exitCode, locale);
    yield { type: 'stderr', text: errorText };
  }

  const result: AgentExecResult = {
    ok,
    provider: input.provider,
    command,
    exitCode,
    text: ok
      ? accumulatedText.trim() || serverT(locale, 'agent.emptyResponse')
      : aborted
        ? accumulatedText.trim() || serverT(locale, 'agent.aborted')
        : timedOut
          ? accumulatedText.trim() ||
            serverT(locale, 'agent.timeoutLong', { seconds: Math.round(timeoutMs / 1000) })
          : errorFallbackText(trimmedStderr, accumulatedText, exitCode, locale),
    stderr: sanitizeStderr(trimmedStderr),
    durationMs,
    timedOut,
    model,
    usage,
    costUsd,
    remoteSessionId,
  };

  yield { type: 'done', result };
}

const TOOL_RESULT_MAX_CHARS = 1200;

function truncateToolResult(raw: string): { content: string; truncated: boolean } {
  if (raw.length <= TOOL_RESULT_MAX_CHARS) {
    return { content: raw, truncated: false };
  }
  return {
    content: `${raw.slice(0, TOOL_RESULT_MAX_CHARS)}…`,
    truncated: true,
  };
}

function parseStreamLine(provider: AgentProvider, line: string): AgentStreamEvent[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return [];
  }

  const row = asRecord(parsed);
  if (!row) {
    return [];
  }

  if (provider === 'claude') {
    return parseClaudeStreamEvent(row);
  }
  return parseCodexStreamEvent(row);
}

/**
 * Claude stream-json events:
 * - {type:"system", subtype:"init", session_id, tools, model, ...}
 * - {type:"system", subtype:"task_started", task_id, tool_use_id, description, prompt}
 * - {type:"rate_limit_event", ...}  (ignored)
 * - {type:"assistant", message:{role, model, content:[{type:"text"|"thinking"|"tool_use", ...}]}, parent_tool_use_id}
 * - {type:"user", message:{role, content:[{type:"tool_result", tool_use_id, content, is_error} | {type:"text", text}]}, parent_tool_use_id}
 * - {type:"result", subtype:"success"|"error_during_execution", result, usage, duration_ms}
 *
 * An `assistant` event may contain multiple content items. Each becomes a separate
 * AgentStreamEvent so the UI can render them in order (e.g. thinking → tool_use → text).
 *
 * Top-level final text (parent_tool_use_id == null) becomes `delta` — it is accumulated
 * and persisted as the assistant message.
 * Sub-agent text (parent_tool_use_id != null) becomes `subagent` — informational only,
 * not persisted.
 */
function parseClaudeStreamEvent(row: Record<string, unknown>): AgentStreamEvent[] {
  const events: AgentStreamEvent[] = [];
  const type = asString(row.type);

  if (type === 'system') {
    const subtype = asString(row.subtype);
    if (subtype === 'init') {
      const sid = asString(row.session_id);
      if (sid) {
        events.push({ type: 'session', remoteSessionId: sid });
      }
      const model = asString(row.model);
      if (model) {
        events.push({ type: 'model', model });
      }
      return events;
    }
    if (subtype === 'task_started') {
      const taskId = asString(row.task_id) || '';
      const toolUseId = asString(row.tool_use_id) || '';
      const description = asString(row.description) || 'Sub-agent task';
      events.push({ type: 'task_start', taskId, toolUseId, description });
      return events;
    }
    return events;
  }

  if (type === 'assistant') {
    const message = asRecord(row.message);
    if (!message) {
      return events;
    }
    const parentToolUseId = asString(row.parent_tool_use_id) || null;
    const contentArr = Array.isArray(message.content) ? (message.content as unknown[]) : [];

    for (const item of contentArr) {
      const rec = asRecord(item);
      if (!rec) {
        continue;
      }
      const itemType = asString(rec.type);

      if (itemType === 'text') {
        const text = asString(rec.text);
        if (!text) {
          continue;
        }
        if (parentToolUseId === null) {
          events.push({ type: 'delta', text });
        } else {
          events.push({ type: 'subagent', text, parentToolUseId });
        }
        continue;
      }

      if (itemType === 'thinking') {
        const text = asString(rec.text) || asString(rec.thinking);
        if (text) {
          events.push({ type: 'thinking', text });
        }
        continue;
      }

      if (itemType === 'tool_use') {
        const toolUseId = asString(rec.id) || '';
        const name = asString(rec.name) || 'tool';
        events.push({
          type: 'tool_use',
          toolUseId,
          name,
          input: rec.input ?? null,
          parentToolUseId,
        });
      }
    }

    // Emit usage snapshot if present on the message. Claude ships cumulative
    // counts on each assistant event during streaming, so the latest wins
    // client-side. Skip sub-agent usage (parent_tool_use_id != null) — those
    // are counted toward the parent's turn anyway.
    const usageRec = asRecord(message.usage);
    if (usageRec && parentToolUseId === null) {
      const usage: AgentUsage = {
        inputTokens: asNumber(usageRec.input_tokens),
        outputTokens: asNumber(usageRec.output_tokens),
        cacheCreateTokens: asNumber(usageRec.cache_creation_input_tokens),
        cacheReadTokens: asNumber(usageRec.cache_read_input_tokens),
      };
      const total =
        usage.inputTokens + usage.outputTokens + usage.cacheCreateTokens + usage.cacheReadTokens;
      if (total > 0) {
        events.push({ type: 'usage', usage });
      }
    }

    return events;
  }

  if (type === 'user') {
    const message = asRecord(row.message);
    if (!message) {
      return events;
    }
    const contentArr = Array.isArray(message.content) ? (message.content as unknown[]) : [];

    for (const item of contentArr) {
      const rec = asRecord(item);
      if (!rec) {
        continue;
      }
      const itemType = asString(rec.type);
      if (itemType !== 'tool_result') {
        continue;
      }
      const toolUseId = asString(rec.tool_use_id) || '';
      const rawContent =
        typeof rec.content === 'string'
          ? rec.content
          : Array.isArray(rec.content)
            ? (rec.content as unknown[])
                .map((c) => {
                  const r = asRecord(c);
                  if (!r) return '';
                  return asString(r.text) || '';
                })
                .filter(Boolean)
                .join('\n')
            : JSON.stringify(rec.content ?? '');
      const { content, truncated } = truncateToolResult(rawContent);
      const isError = rec.is_error === true;
      events.push({ type: 'tool_result', toolUseId, content, isError, truncated });
    }
    return events;
  }

  return events;
}

/**
 * Codex 0.121+ streaming event schema. See parseCodexNdjson JSDoc for layout.
 * We map to our AgentStreamEvent union:
 *   thread.started → session
 *   item.started (command_execution) → tool_use
 *   item.completed (agent_message) → delta
 *   item.completed (command_execution) → tool_result
 *   turn.completed.usage → usage
 * Item types we don't recognise are silently ignored so new Codex releases
 * don't crash the stream.
 */
function parseCodexStreamEvent(row: Record<string, unknown>): AgentStreamEvent[] {
  const events: AgentStreamEvent[] = [];
  const type = asString(row.type);

  if (type === 'thread.started') {
    const threadId = asString(row.thread_id);
    if (threadId) {
      events.push({ type: 'session', remoteSessionId: threadId });
    }
    return events;
  }

  if (type === 'item.started') {
    const item = asRecord(row.item);
    if (!item) return events;
    const itemType = asString(item.type);
    const itemId = asString(item.id) || '';
    if (itemType === 'command_execution') {
      const command = asString(item.command) || '';
      events.push({
        type: 'tool_use',
        toolUseId: itemId,
        name: 'Bash',
        input: { command },
        parentToolUseId: null,
      });
    } else if (itemType === 'web_search') {
      events.push({
        type: 'tool_use',
        toolUseId: itemId,
        name: 'WebSearch',
        input: { query: asString(item.query) || '' },
        parentToolUseId: null,
      });
    } else if (itemType === 'file_change') {
      events.push({
        type: 'tool_use',
        toolUseId: itemId,
        name: 'Edit',
        input: { path: asString(item.path) || '' },
        parentToolUseId: null,
      });
    } else if (itemType && itemType !== 'agent_message' && itemType !== 'reasoning') {
      // Forward unknown item types as generic tool_use so the UI shows them
      // instead of silently dropping. Newer Codex releases may introduce more.
      events.push({
        type: 'tool_use',
        toolUseId: itemId,
        name: itemType,
        input: item,
        parentToolUseId: null,
      });
    }
    return events;
  }

  if (type === 'item.completed') {
    const item = asRecord(row.item);
    if (!item) return events;
    const itemType = asString(item.type);
    const itemId = asString(item.id) || '';
    if (itemType === 'agent_message') {
      const text = asString(item.text);
      if (text) events.push({ type: 'delta', text });
    } else if (itemType === 'command_execution') {
      const rawOutput = asString(item.aggregated_output) ?? '';
      const exitCode = typeof item.exit_code === 'number' ? item.exit_code : 0;
      const truncated = rawOutput.length > 1200;
      const content = truncated ? `${rawOutput.slice(0, 1200)}…` : rawOutput;
      events.push({
        type: 'tool_result',
        toolUseId: itemId,
        content,
        isError: exitCode !== 0,
        truncated,
      });
    } else if (itemType === 'web_search' || itemType === 'file_change') {
      const summary = asString(item.result) || asString(item.summary) || asString(item.text) || '';
      events.push({
        type: 'tool_result',
        toolUseId: itemId,
        content: summary.slice(0, 1200),
        isError: false,
        truncated: summary.length > 1200,
      });
    } else if (itemType === 'reasoning') {
      const text = asString(item.text);
      if (text) events.push({ type: 'thinking', text });
    }
    return events;
  }

  if (type === 'turn.completed') {
    const usageRec = asRecord(row.usage);
    if (usageRec) {
      const usage: AgentUsage = {
        inputTokens: asNumber(usageRec.input_tokens),
        outputTokens: asNumber(usageRec.output_tokens),
        cacheCreateTokens: 0,
        cacheReadTokens: asNumber(usageRec.cached_input_tokens),
        reasoningTokens: asNumber(usageRec.reasoning_output_tokens),
      };
      events.push({ type: 'usage', usage });
    }
    return events;
  }

  return events;
}

export async function execAgentCli(input: AgentExecInput): Promise<AgentExecResult> {
  const timeoutMs = input.timeoutMs || DEFAULT_TIMEOUT_MS;
  const locale = await currentLocale();
  const promptBytes = Buffer.byteLength(input.prompt, 'utf8');
  const useStdin = input.provider === 'claude' || promptBytes > MAX_ARGV_PROMPT_BYTES;

  if (input.provider === 'codex' && promptBytes > MAX_ARGV_PROMPT_BYTES) {
    return {
      ok: false,
      provider: input.provider,
      command: ['codex', 'exec', '--json', `<prompt ${promptBytes} bytes>`],
      exitCode: -1,
      text: `prompt_too_large_for_argv (${promptBytes} bytes, max ${MAX_ARGV_PROMPT_BYTES})`,
      stderr: 'prompt_too_large_for_argv',
      durationMs: 0,
      timedOut: false,
      model: null,
      usage: null,
      costUsd: null,
      remoteSessionId: null,
    };
  }

  const command =
    input.provider === 'claude'
      ? buildClaudeArgs({
          model: input.model,
          resumeRemoteSessionId: input.resumeRemoteSessionId,
          streaming: false,
          toolPolicy: input.toolPolicy ?? 'all',
          bashAllowlist: input.bashAllowlist,
          permissionMode: input.permissionMode ?? 'skip',
        })
      : buildCodexArgs(input.prompt, input.model, input.cwd, input.toolPolicy ?? 'all');

  const start = Date.now();

  const proc = Bun.spawn(command, {
    cwd: input.cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: useStdin ? new Response(input.prompt).body : 'ignore',
  });

  let timedOut = false;
  const softKill = setTimeout(() => {
    timedOut = true;
    try {
      proc.kill('SIGTERM');
    } catch {
      /* already exited */
    }
  }, timeoutMs);
  const hardKill = setTimeout(() => {
    try {
      proc.kill('SIGKILL');
    } catch {
      /* already exited */
    }
  }, timeoutMs + KILL_GRACE_MS);

  const [stdout, stderr, exitCode] = await Promise.all([
    readStream(proc.stdout),
    readStream(proc.stderr),
    proc.exited,
  ]);

  clearTimeout(softKill);
  clearTimeout(hardKill);

  const durationMs = Date.now() - start;
  const ok = exitCode === 0 && !timedOut;

  const trimmedStdout = stdout.trim();
  const trimmedStderr = stderr.trim();

  if (!ok) {
    return {
      ok: false,
      provider: input.provider,
      command,
      exitCode,
      text: timedOut
        ? serverT(locale, 'agent.timeout', { seconds: Math.round(timeoutMs / 1000) })
        : errorFallbackText(trimmedStderr, trimmedStdout, exitCode, locale),
      stderr: sanitizeStderr(trimmedStderr),
      durationMs,
      timedOut,
      model: null,
      usage: null,
      costUsd: null,
      remoteSessionId: null,
      rawStdout: trimmedStdout,
    };
  }

  if (input.provider === 'claude') {
    const parsed = parseClaudeJson(trimmedStdout);
    return {
      ok: true,
      provider: 'claude',
      command,
      exitCode,
      text: parsed.text || serverT(locale, 'agent.emptyResponse'),
      stderr: sanitizeStderr(trimmedStderr),
      durationMs,
      timedOut: false,
      model: parsed.model,
      usage: parsed.usage,
      costUsd: parsed.costUsd,
      remoteSessionId: parsed.remoteSessionId,
      rawStdout: parsed.parsed ? undefined : trimmedStdout,
    };
  }

  // codex
  const parsed = parseCodexNdjson(trimmedStdout);
  return {
    ok: true,
    provider: 'codex',
    command,
    exitCode,
    text: parsed.text || serverT(locale, 'agent.emptyResponse'),
    stderr: sanitizeStderr(trimmedStderr),
    durationMs,
    timedOut: false,
    model: parsed.model,
    usage: parsed.usage,
    costUsd: null,
    remoteSessionId: parsed.remoteSessionId,
    rawStdout: parsed.parsed ? undefined : trimmedStdout,
  };
}
