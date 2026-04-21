import type { Database } from 'bun:sqlite';
import { type AgentProvider, execAgentCli } from '../wrappers/agentCli';

/**
 * Rolling summary of the older turns of a long conversation. When history
 * grows beyond RECENT_TURNS, we summarise everything except the last
 * RECENT_TURNS into a running brief, then prepend that brief to the context.
 *
 * The summary is cached on the session row (context_json.summary) and
 * regenerated lazily when enough new turns have accumulated since the last
 * summary (SUMMARY_STALE_TURNS).
 *
 * Storage (stored inside session.context_json so no schema change):
 *   {
 *     summary: { text, turnsCovered, generatedAt, coveredMessageId }
 *     ... // existing context fields
 *   }
 */

export const RECENT_TURNS = 20;
export const SUMMARY_TRIGGER_TURNS = 26; // only summarise when we can trim meaningfully
export const SUMMARY_STALE_TURNS = 10; // regenerate after this many new turns

const SUMMARY_PROMPT_TEMPLATE = `You are a conversation compressor. Given the transcript below, produce a dense summary of what happened so the assistant can continue the conversation WITHOUT reading every old turn.

Include:
- Key decisions made, with their rationale
- Facts the user stated about themselves, their project, or their preferences
- Open questions or commitments that weren't yet resolved
- Specific names, paths, numbers, or identifiers mentioned

Exclude:
- Pleasantries, small talk, or chit-chat
- Restatements of obvious context
- Anything already captured in agent memories (listed below, don't repeat)

{existingSummary}

<existing-memories>
{existingMemories}
</existing-memories>

<transcript>
{transcript}
</transcript>

Output format — STRICT:
- 10 to 20 short bullet points, each one atomic fact or decision
- Plain markdown, no preamble, no closing note
- No "The user said X", just state X
- If nothing substantive to summarise, output exactly: NONE`;

export type SummaryRecord = {
  text: string;
  turnsCovered: number;
  generatedAt: number; // unix seconds
  coveredThroughTs: number; // ts of the last message included in the summary
};

export type ConversationSummaryDecision =
  | { kind: 'skip'; reason: 'short_conversation' | 'up_to_date' }
  | { kind: 'refresh'; coverableMessages: number; sinceLast: number };

export function decideSummary(
  totalMessages: number,
  lastCoveredTs: number | null,
  recentUpdatedTs: number,
  turnsCoveredBefore: number,
): ConversationSummaryDecision {
  if (totalMessages < SUMMARY_TRIGGER_TURNS) {
    return { kind: 'skip', reason: 'short_conversation' };
  }
  const coverableMessages = totalMessages - RECENT_TURNS;
  if (coverableMessages <= 0) {
    return { kind: 'skip', reason: 'short_conversation' };
  }
  const sinceLast = coverableMessages - turnsCoveredBefore;
  if (lastCoveredTs !== null && sinceLast < SUMMARY_STALE_TURNS) {
    // Summary still fresh enough — but flag if it's behind the tail.
    if (recentUpdatedTs <= lastCoveredTs) {
      return { kind: 'skip', reason: 'up_to_date' };
    }
    if (sinceLast <= 0) {
      return { kind: 'skip', reason: 'up_to_date' };
    }
  }
  return { kind: 'refresh', coverableMessages, sinceLast };
}

export function readSummaryFromContext(contextJson: string | null): SummaryRecord | null {
  if (!contextJson) return null;
  try {
    const parsed = JSON.parse(contextJson) as { summary?: unknown };
    if (!parsed.summary || typeof parsed.summary !== 'object') return null;
    const rec = parsed.summary as Partial<SummaryRecord>;
    if (
      typeof rec.text !== 'string' ||
      typeof rec.turnsCovered !== 'number' ||
      typeof rec.generatedAt !== 'number' ||
      typeof rec.coveredThroughTs !== 'number'
    ) {
      return null;
    }
    return rec as SummaryRecord;
  } catch {
    return null;
  }
}

export function writeSummaryToContext(contextJson: string | null, summary: SummaryRecord): string {
  let base: Record<string, unknown> = {};
  if (contextJson) {
    try {
      base = JSON.parse(contextJson) as Record<string, unknown>;
    } catch {
      base = {};
    }
  }
  return JSON.stringify({ ...base, summary });
}

function renderTranscript(
  messages: Array<{ role: string; content: string | null; ts: number }>,
): string {
  return messages
    .map((message) => {
      const role =
        message.role === 'assistant' ? 'ASSISTANT' : message.role === 'tool' ? 'TOOL' : 'USER';
      const content = (message.content || '').trim();
      return `${role}:\n${content}`;
    })
    .join('\n\n');
}

export type SummaryRefreshInput = {
  db: Database;
  provider: AgentProvider;
  model?: string;
  cwd: string;
  /** Raw oldest→newest messages that need to be summarised (already sliced). */
  messagesToSummarise: Array<{ role: string; content: string | null; ts: number }>;
  /** Existing summary text (if any) to carry forward. */
  previousSummary: string | null;
  /** Formatted existing memories block to avoid redundancy. */
  existingMemoriesBlock: string;
  timeoutMs?: number;
  abortSignal?: AbortSignal;
};

export async function refreshConversationSummary(input: SummaryRefreshInput): Promise<{
  ok: boolean;
  text: string | null;
  durationMs: number;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheCreateTokens: number;
    cacheReadTokens: number;
  } | null;
  error?: string;
}> {
  const transcript = renderTranscript(input.messagesToSummarise);
  if (transcript.trim().length === 0) {
    return { ok: true, text: null, durationMs: 0, usage: null };
  }

  const prompt = SUMMARY_PROMPT_TEMPLATE.replace(
    '{existingSummary}',
    input.previousSummary
      ? `<previous-summary>\n${input.previousSummary.trim()}\n</previous-summary>\n`
      : '',
  )
    .replace('{existingMemories}', input.existingMemoriesBlock || '(none)')
    .replace('{transcript}', transcript);

  if (input.abortSignal?.aborted) {
    return { ok: false, text: null, durationMs: 0, usage: null, error: 'aborted' };
  }

  const result = await execAgentCli({
    provider: input.provider,
    prompt,
    cwd: input.cwd,
    model: input.model,
    timeoutMs: input.timeoutMs ?? 30_000,
    toolPolicy: 'none',
    abortSignal: input.abortSignal,
  });

  const text = (result.text || '').trim();
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
      text: null,
      durationMs: result.durationMs,
      usage,
      error: result.timedOut ? 'timeout' : result.stderr.slice(0, 200) || 'cli_failed',
    };
  }
  if (text.length === 0 || text === 'NONE') {
    return { ok: true, text: null, durationMs: result.durationMs, usage };
  }
  return { ok: true, text, durationMs: result.durationMs, usage };
}
