import type { Database } from 'bun:sqlite';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Merged Codex/Claude model catalog.
 *
 * The agent page's model selector used to show only a hardcoded 2-entry
 * list for Codex (gpt-5.4 / gpt-5.3-codex). Reality is richer:
 *   - new model IDs ship faster than we can bump the constant
 *   - the user's own CLI config may already point to an ID we don't know
 *     about (e.g. `model = "gpt-5.5"` in ~/.codex/config.toml)
 *   - the JSONL history shows which models the user actually runs
 *
 * This helper merges three sources, in priority order for display:
 *   1. Static base catalog — known-good model IDs we always want to surface
 *   2. User CLI config — whatever the user set as default (so the dropdown
 *      reflects their actual env, not our opinion)
 *   3. Recent history (60 d) — models seen in usage_daily_by_project.models_json
 *
 * Each entry carries a `source` tag so the UI can render a subtle hint
 * (e.g. "· from your config", "· seen in history") when useful.
 */

export type ProviderId = 'claude' | 'codex';
export type ModelSource = 'catalog' | 'config' | 'history';

export type MergedModel = {
  id: string;
  label: string;
  hintKey: string | null;
  source: ModelSource;
  /** distinct days seen in last-60-day JSONL history, if available */
  recentDays?: number;
  /** approximate calls in the last 60 days (best-effort from models_json) */
  recentCalls?: number;
};

type StaticEntry = { id: string; label: string; hintKey: string | null };

/**
 * Kept intentionally liberal — the CLIs accept arbitrary `--model <STRING>`,
 * so showing too many options is harmless (the agent simply forwards the
 * string). Better to expose known variants up-front than force the user
 * to remember IDs. Order matters: most-current / most-recommended first.
 */
const STATIC_CATALOG: Record<ProviderId, StaticEntry[]> = {
  claude: [
    { id: 'claude-opus-4-7', label: 'Opus 4.7', hintKey: 'agent.models.opus47' },
    { id: 'claude-opus-4-6', label: 'Opus 4.6', hintKey: 'agent.models.opus46' },
    { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6', hintKey: 'agent.models.sonnet46' },
    { id: 'claude-sonnet-4-5', label: 'Sonnet 4.5', hintKey: null },
    { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5', hintKey: 'agent.models.haiku45' },
    // Generic aliases the CLI resolves server-side to "latest of kind".
    // Useful when you want Anthropic's current best without pinning a date.
    { id: 'opus', label: 'Opus (latest)', hintKey: null },
    { id: 'sonnet', label: 'Sonnet (latest)', hintKey: null },
    { id: 'haiku', label: 'Haiku (latest)', hintKey: null },
  ],
  codex: [
    // OpenAI dotted versioning — current generation. Listed in descending
    // recency so the selector defaults to "newest first".
    { id: 'gpt-5.5', label: 'GPT-5.5', hintKey: null },
    { id: 'gpt-5.4', label: 'GPT-5.4', hintKey: 'agent.models.gpt54' },
    { id: 'gpt-5.3-codex', label: 'GPT-5.3 Codex', hintKey: 'agent.models.gpt53codex' },
    { id: 'gpt-5.3', label: 'GPT-5.3', hintKey: null },
    { id: 'gpt-5.2', label: 'GPT-5.2', hintKey: null },
    { id: 'gpt-5.1', label: 'GPT-5.1', hintKey: null },
    // Dashed aliases (OpenAI's API-style naming) — separately bill-tiered
    // in pricing.ts, so tracking them is worthwhile even if some users
    // overlap with the dotted IDs above.
    { id: 'gpt-5', label: 'GPT-5', hintKey: null },
    { id: 'gpt-5-codex', label: 'GPT-5 Codex', hintKey: null },
    { id: 'gpt-5-mini', label: 'GPT-5 Mini', hintKey: null },
    { id: 'gpt-5-nano', label: 'GPT-5 Nano', hintKey: null },
    // Reasoning-first family — cheaper per token but slower; good for
    // agentic runs where latency is secondary.
    { id: 'o4', label: 'o4', hintKey: null },
    { id: 'o4-mini', label: 'o4 Mini', hintKey: null },
    { id: 'o3', label: 'o3', hintKey: null },
    { id: 'o3-mini', label: 'o3 Mini', hintKey: null },
    // Legacy 4o: kept so long-running session projects still find their
    // pinned model. Pricing stays known via pricing.ts.
    { id: 'gpt-4o', label: 'GPT-4o', hintKey: null },
    { id: 'gpt-4o-mini', label: 'GPT-4o Mini', hintKey: null },
  ],
};

/**
 * Best-effort pretty-label for a model ID we don't have a static entry for.
 * Preserves the original ID's case where meaningful and folds common prefixes.
 * Not i18n'd — this is a fallback label that only surfaces when the model
 * wasn't in the curated catalog.
 */
function prettifyLabel(id: string): string {
  if (!id) return id;
  if (id.startsWith('gpt-')) {
    // gpt-5.5 → "GPT-5.5", gpt-5.3-codex → "GPT-5.3 Codex"
    const tail = id.slice(4);
    const segments = tail.split('-');
    return `GPT-${segments[0]}${segments.length > 1 ? ` ${segments.slice(1).map(cap).join(' ')}` : ''}`;
  }
  if (id.startsWith('claude-')) {
    return id.slice(7).split('-').map(cap).join(' ');
  }
  return id;
}

function cap(s: string): string {
  return s.length > 0 ? s[0].toUpperCase() + s.slice(1) : s;
}

/**
 * Read the `model = "xxx"` field out of ~/.codex/config.toml. We don't pull
 * a full TOML parser in just for this — the canonical form Codex writes is
 * a top-level `model = "..."` line, so a small regex suffices and we fail
 * open if the shape surprises us.
 */
async function readCodexConfigModel(): Promise<string | null> {
  try {
    const raw = await readFile(join(homedir(), '.codex', 'config.toml'), 'utf8');
    // Match the first top-level `model = "..."` line, ignoring occurrences
    // inside nested tables by requiring it to appear before the first `[`.
    const head = raw.split(/\n\[/)[0];
    const m = head.match(/^\s*model\s*=\s*"([^"]+)"/m);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/**
 * Read the default model out of ~/.claude/settings.json if the user has
 * explicitly configured one. Claude Code picks a model server-side by
 * default, so this is usually null — but we still check so users who
 * override locally get their pick surfaced.
 */
async function readClaudeConfigModel(): Promise<string | null> {
  try {
    const raw = await readFile(join(homedir(), '.claude', 'settings.json'), 'utf8');
    const parsed = JSON.parse(raw);
    const candidate = parsed?.model ?? parsed?.defaultModel ?? null;
    return typeof candidate === 'string' && candidate.length > 0 ? candidate : null;
  } catch {
    return null;
  }
}

type RecentModel = { id: string; days: number; calls: number };

/**
 * Pull distinct model IDs seen in the last `windowDays` days from
 * `usage_daily_by_project.models_json`. Format of the column is
 * `[{model: string, tokens: number, messages?: number}, ...]`.
 * We aggregate across (date, project) rows to get:
 *   - distinct days the model appeared in
 *   - approximate call count (sum of `messages`; falls back to "≥1 per row")
 */
function readRecentModelsFromDb(
  db: Database,
  provider: ProviderId,
  windowDays: number,
): RecentModel[] {
  const cutoff = new Date(Date.now() - windowDays * 86_400_000).toISOString().slice(0, 10);
  const rows = db
    .query<{ date: string; models_json: string | null }, [string, string]>(
      `SELECT date, models_json
       FROM usage_daily_by_project
       WHERE source = ? AND date >= ?`,
    )
    .all(provider, cutoff);

  const perModel = new Map<string, { daySet: Set<string>; calls: number }>();
  for (const row of rows) {
    if (!row.models_json) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.models_json);
    } catch {
      continue;
    }
    if (!Array.isArray(parsed)) continue;
    for (const entry of parsed) {
      if (!entry || typeof entry !== 'object') continue;
      const rec = entry as Record<string, unknown>;
      const id = typeof rec.model === 'string' ? rec.model : null;
      // Skip synthetic markers Claude JSONL uses for internal summaries
      // (`<synthetic>`, angle-bracketed pseudo-IDs). They're not callable
      // model IDs and don't belong in a user-facing selector.
      if (!id || id.startsWith('<') || id === 'unknown') continue;
      const msgs = Number(rec.messages || 0);
      let slot = perModel.get(id);
      if (!slot) {
        slot = { daySet: new Set(), calls: 0 };
        perModel.set(id, slot);
      }
      slot.daySet.add(row.date);
      slot.calls += msgs > 0 ? msgs : 1;
    }
  }

  return [...perModel.entries()].map(([id, s]) => ({
    id,
    days: s.daySet.size,
    calls: s.calls,
  }));
}

/**
 * Build the merged, display-ordered list of models for a provider.
 * Sort order:
 *   1. static catalog (in declared order) — canonical, always first
 *   2. config model — user's own default, high signal
 *   3. history models — by recentCalls desc, then recentDays desc
 */
export async function getMergedAgentModels(
  db: Database,
  provider: ProviderId,
  windowDays = 60,
): Promise<MergedModel[]> {
  const byId = new Map<string, MergedModel>();
  const order: string[] = [];

  for (const entry of STATIC_CATALOG[provider]) {
    byId.set(entry.id, {
      id: entry.id,
      label: entry.label,
      hintKey: entry.hintKey,
      source: 'catalog',
    });
    order.push(entry.id);
  }

  const cfgModel =
    provider === 'codex' ? await readCodexConfigModel() : await readClaudeConfigModel();
  if (cfgModel && !byId.has(cfgModel)) {
    byId.set(cfgModel, {
      id: cfgModel,
      label: prettifyLabel(cfgModel),
      hintKey: null,
      source: 'config',
    });
    order.push(cfgModel);
  }

  const recent = readRecentModelsFromDb(db, provider, windowDays);
  const historyOnly: MergedModel[] = [];
  for (const r of recent) {
    const existing = byId.get(r.id);
    if (existing) {
      existing.recentDays = r.days;
      existing.recentCalls = r.calls;
    } else {
      historyOnly.push({
        id: r.id,
        label: prettifyLabel(r.id),
        hintKey: null,
        source: 'history',
        recentDays: r.days,
        recentCalls: r.calls,
      });
    }
  }
  historyOnly.sort(
    (a, b) =>
      (b.recentCalls ?? 0) - (a.recentCalls ?? 0) || (b.recentDays ?? 0) - (a.recentDays ?? 0),
  );
  for (const m of historyOnly) {
    byId.set(m.id, m);
    order.push(m.id);
  }

  const out: MergedModel[] = [];
  for (const id of order) {
    const entry = byId.get(id);
    if (entry) out.push(entry);
  }
  return out;
}
