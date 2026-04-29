import type { Database } from 'bun:sqlite';
import type { Hono } from 'hono';
import { expandHomePath, loadSettings } from '../config';
import { getDb } from '../db';
import { type DailyTokenRow, computeProjectAccrual, dailyRateOnDate } from '../lib/billing';
import { rateLimit } from '../lib/rateLimit';
import { type OauthUsageBar, getOauthUsage } from '../wrappers/anthropicOauth';
import {
  type CcusageDailyRow,
  type CodexCcusageDailyRow,
  ccusageDaily,
  ccusageMonthly,
  codexCcusageDaily,
  codexCcusageMonthly,
  codexCcusageSession,
} from '../wrappers/ccusage';
import { getCodexUsageSnapshot } from '../wrappers/codexJsonlParser';
import { getCodexLiveRateLimits } from '../wrappers/codexOauth';
import { type KnownProject, getClaudeUsageSnapshot } from '../wrappers/jsonlParser';

// Previous caps (64 files × 650 lines) dropped >99% of events for large projects.
// Bumped to capture full history; JSONL parsing is cached 20 s and typically fits memory.
// 20k+ Claude JSONL files exist over 90 days — this cap controls the top-K by mtime.
const JSONL_SCAN_MAX_FILES = 2000;
const JSONL_SCAN_MAX_TAIL_LINES = 200_000;
const CODEX_JSONL_MAX_FILES = 200;
const CODEX_SYNC_STALE_SECONDS = 30 * 60;

type ClaudeDailyNormalizedRow = {
  date: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreate: number;
  cacheRead: number;
  costUsd: number;
};

type CodexDailyNormalizedRow = {
  date: string;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
  costUsd: number;
  models: Record<string, unknown>;
  syncedAt: number;
};

type CombinedDailyRow = {
  date: string;
  claudeInputTokens: number;
  claudeOutputTokens: number;
  claudeCacheCreateTokens: number;
  claudeCacheReadTokens: number;
  claudeTokens: number;
  claudeCostUsd: number;
  claudeSubCostUsd: number;
  codexInputTokens: number;
  codexCachedInputTokens: number;
  codexOutputTokens: number;
  codexReasoningOutputTokens: number;
  codexTokens: number;
  codexCostUsd: number;
  codexSubCostUsd: number;
  totalTokens: number;
  totalCostUsd: number;
  totalSubCostUsd: number;
};

const codexSyncInflight = new Map<string, Promise<void>>();
// When a codex sync fails (ccusage-codex offline / broken / network),
// suppress re-tries until this timestamp to avoid hammering the CLI on every
// page load. 60s is long enough to debounce but short enough that a user who
// fixes the issue doesn't wait forever.
const codexSyncCooldownUntil = new Map<string, number>();
const CODEX_SYNC_COOLDOWN_SECONDS = 60;

function yyyymmdd(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

function isoDateFromTs(ts: number): string {
  return new Date(ts * 1000).toISOString().slice(0, 10);
}

function compactDateFromTs(ts: number): string {
  const date = new Date(ts * 1000);
  return yyyymmdd(date);
}

function parseDateStart(input: string | undefined): number | null {
  if (!input || input.trim().length === 0) {
    return null;
  }

  const raw = input.trim();
  const normalized = /^\d{8}$/.test(raw)
    ? `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`
    : raw;

  const parsed = Date.parse(`${normalized.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(parsed)) {
    return null;
  }

  return Math.floor(parsed / 1000);
}

function parseDateEnd(input: string | undefined): number | null {
  if (!input || input.trim().length === 0) {
    return null;
  }

  const raw = input.trim();
  const normalized = /^\d{8}$/.test(raw)
    ? `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`
    : raw;

  const parsed = Date.parse(`${normalized.slice(0, 10)}T23:59:59Z`);
  if (Number.isNaN(parsed)) {
    return null;
  }

  return Math.floor(parsed / 1000);
}

function defaultRange(days = 30): { fromTs: number; toTs: number } {
  const toTs = Math.floor(Date.now() / 1000);
  const fromTs = toTs - days * 86400;
  return { fromTs, toTs };
}

function parseRange(
  fromInput: string | undefined,
  toInput: string | undefined,
  fallbackDays = 30,
): { fromTs: number; toTs: number } {
  const fallback = defaultRange(fallbackDays);
  const fromTs = parseDateStart(fromInput) ?? fallback.fromTs;
  const toTs = parseDateEnd(toInput) ?? fallback.toTs;

  if (fromTs > toTs) {
    return { fromTs: fallback.fromTs, toTs: fallback.toTs };
  }

  return { fromTs, toTs };
}

function normalizeDailyRow(row: CcusageDailyRow): ClaudeDailyNormalizedRow {
  return {
    date: String(row.date || ''),
    inputTokens: Number(row.inputTokens || 0),
    outputTokens: Number(row.outputTokens || 0),
    cacheCreate: Number(row.cacheCreationTokens || 0),
    cacheRead: Number(row.cacheReadTokens || 0),
    costUsd: Number(row.totalCost || 0),
  };
}

function parseCodexDate(input: unknown): string {
  if (typeof input !== 'string' || input.trim().length === 0) {
    return '';
  }

  const value = input.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return value;
  }

  if (/^\d{8}$/.test(value)) {
    return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
  }

  const parsed = Date.parse(value);
  if (!Number.isNaN(parsed)) {
    return new Date(parsed).toISOString().slice(0, 10);
  }

  return '';
}

function normalizeCodexDailyRow(
  row: CodexCcusageDailyRow,
  syncedAt: number,
): CodexDailyNormalizedRow | null {
  const date = parseCodexDate(row.date);
  if (!date) {
    return null;
  }

  const inputTokens = Number(row.inputTokens || 0);
  const outputTokens = Number(row.outputTokens || 0);
  const totalTokens = Number(row.totalTokens || inputTokens + outputTokens);

  return {
    date,
    inputTokens,
    cachedInputTokens: Number(row.cachedInputTokens || 0),
    outputTokens,
    reasoningOutputTokens: Number(row.reasoningOutputTokens || 0),
    totalTokens,
    costUsd: Number(row.costUSD || 0),
    models:
      row.models && typeof row.models === 'object' ? (row.models as Record<string, unknown>) : {},
    syncedAt,
  };
}

function upsertDailyRows(db: Database, rows: ClaudeDailyNormalizedRow[]): void {
  const upsert = db.query(`
    INSERT INTO usage_daily (
      date, input_tokens, output_tokens, cache_create, cache_read,
      cost_usd, models_json, source, synced_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(date) DO UPDATE SET
      input_tokens = excluded.input_tokens,
      output_tokens = excluded.output_tokens,
      cache_create = excluded.cache_create,
      cache_read = excluded.cache_read,
      cost_usd = excluded.cost_usd,
      source = excluded.source,
      synced_at = excluded.synced_at
  `);

  const syncedAt = Math.floor(Date.now() / 1000);
  for (const row of rows) {
    upsert.run(
      row.date,
      row.inputTokens,
      row.outputTokens,
      row.cacheCreate,
      row.cacheRead,
      row.costUsd,
      '{}',
      // Aligned with usage_daily_by_project.source convention ('claude' not
      // 'claude-code'). Stale 'claude-code' rows get overwritten on next sync
      // via ON CONFLICT(date) DO UPDATE SET source = excluded.source.
      'claude',
      syncedAt,
    );
  }
}

function upsertCodexDailyRows(db: Database, rows: CodexDailyNormalizedRow[]): void {
  const upsert = db.query(`
    INSERT INTO usage_codex_daily (
      date, input_tokens, cached_input_tokens, output_tokens, reasoning_output_tokens,
      total_tokens, cost_usd, models_json, synced_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(date) DO UPDATE SET
      input_tokens = excluded.input_tokens,
      cached_input_tokens = excluded.cached_input_tokens,
      output_tokens = excluded.output_tokens,
      reasoning_output_tokens = excluded.reasoning_output_tokens,
      total_tokens = excluded.total_tokens,
      cost_usd = excluded.cost_usd,
      models_json = excluded.models_json,
      synced_at = excluded.synced_at
  `);

  for (const row of rows) {
    upsert.run(
      row.date,
      row.inputTokens,
      row.cachedInputTokens,
      row.outputTokens,
      row.reasoningOutputTokens,
      row.totalTokens,
      row.costUsd,
      JSON.stringify(row.models || {}),
      row.syncedAt,
    );
  }
}

function loadCachedDailyRows(
  db: Database,
  fromIso?: string,
  toIso?: string,
): ClaudeDailyNormalizedRow[] {
  let sql = `SELECT date,
                    input_tokens AS inputTokens,
                    output_tokens AS outputTokens,
                    cache_create AS cacheCreate,
                    cache_read AS cacheRead,
                    cost_usd AS costUsd
             FROM usage_daily`;

  const params: Array<string | number> = [];
  const clauses: string[] = [];

  if (fromIso) {
    clauses.push('date >= ?');
    params.push(fromIso);
  }

  if (toIso) {
    clauses.push('date <= ?');
    params.push(toIso);
  }

  if (clauses.length > 0) {
    sql += ` WHERE ${clauses.join(' AND ')}`;
  }

  sql += ' ORDER BY date ASC LIMIT 400';

  return db.query(sql).all(...params) as ClaudeDailyNormalizedRow[];
}

/**
 * Codex daily rows aggregated from `usage_daily_by_project` (the per-project
 * source-of-truth refreshed by the JSONL watcher on every project scan).
 *
 * Replaces a previous read from `usage_codex_daily` which is populated by the
 * external `ccusage-codex daily --json` CLI. That CLI:
 *   - buckets sessions using a different tz convention, shifting rows by
 *     1 day vs what actually happened locally;
 *   - occasionally drops dates entirely when no session ended cleanly;
 *   - only runs on the codex sync cadence, so today is frequently missing.
 *
 * Per-project schema maps Codex's native token categories as:
 *   input_tokens  = input_net (fresh input, already net of cached)
 *   output_tokens = output + reasoning
 *   cache_read    = cached_input
 *   total_tokens  = sum of all of the above
 * so we rebuild the normalized shape the rest of the pipeline expects.
 */
function loadCodexDailyFromPerProject(
  db: Database,
  fromIso?: string,
  toIso?: string,
): CodexDailyNormalizedRow[] {
  const clauses: string[] = ["source = 'codex'"];
  const params: Array<string | number> = [];
  if (fromIso) {
    clauses.push('date >= ?');
    params.push(fromIso);
  }
  if (toIso) {
    clauses.push('date <= ?');
    params.push(toIso);
  }
  const rows = db
    .query(
      `SELECT date,
              SUM(input_tokens) AS inputNet,
              SUM(cache_read)   AS cachedInput,
              SUM(output_tokens) AS outputPlusReasoning,
              SUM(total_tokens) AS totalTokens,
              SUM(cost_usd) AS costUsd,
              MAX(synced_at) AS syncedAt
       FROM usage_daily_by_project
       WHERE ${clauses.join(' AND ')}
       GROUP BY date
       ORDER BY date ASC
       LIMIT 500`,
    )
    .all(...params) as Array<{
    date: string;
    inputNet: number;
    cachedInput: number;
    outputPlusReasoning: number;
    totalTokens: number;
    costUsd: number;
    syncedAt: number;
  }>;

  // Reconstruct the CodexDailyNormalizedRow shape. input_tokens is stored as
  // input_net in per-project, but downstream consumers (client chart, exports)
  // expect the "ccusage convention" where input_tokens INCLUDES cached_input.
  // Re-add cached so the two representations stay interchangeable.
  return rows.map((r) => ({
    date: r.date,
    inputTokens: Number(r.inputNet || 0) + Number(r.cachedInput || 0),
    cachedInputTokens: Number(r.cachedInput || 0),
    outputTokens: Number(r.outputPlusReasoning || 0),
    // We stored output + reasoning together in output_tokens at ingest, so we
    // can't split them back apart here. Surface reasoning=0 and keep the full
    // work under outputTokens; the chart sums them anyway.
    reasoningOutputTokens: 0,
    totalTokens: Number(r.totalTokens || 0),
    costUsd: Number(r.costUsd || 0),
    models: {},
    syncedAt: Number(r.syncedAt || 0),
  }));
}

function loadCachedCodexDailyRows(
  db: Database,
  fromIso?: string,
  toIso?: string,
): CodexDailyNormalizedRow[] {
  let sql = `SELECT date,
                    input_tokens AS inputTokens,
                    cached_input_tokens AS cachedInputTokens,
                    output_tokens AS outputTokens,
                    reasoning_output_tokens AS reasoningOutputTokens,
                    total_tokens AS totalTokens,
                    cost_usd AS costUsd,
                    models_json AS modelsJson,
                    synced_at AS syncedAt
             FROM usage_codex_daily`;

  const params: Array<string | number> = [];
  const clauses: string[] = [];

  if (fromIso) {
    clauses.push('date >= ?');
    params.push(fromIso);
  }

  if (toIso) {
    clauses.push('date <= ?');
    params.push(toIso);
  }

  if (clauses.length > 0) {
    sql += ` WHERE ${clauses.join(' AND ')}`;
  }

  sql += ' ORDER BY date ASC LIMIT 500';

  const rows = db.query(sql).all(...params) as Array<{
    date: string;
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    reasoningOutputTokens: number;
    totalTokens: number;
    costUsd: number;
    modelsJson: string | null;
    syncedAt: number;
  }>;

  return rows.map((row) => {
    let models: Record<string, unknown> = {};
    if (row.modelsJson) {
      try {
        const parsed = JSON.parse(row.modelsJson) as Record<string, unknown>;
        models = parsed && typeof parsed === 'object' ? parsed : {};
      } catch {
        models = {};
      }
    }

    return {
      date: row.date,
      inputTokens: Number(row.inputTokens || 0),
      cachedInputTokens: Number(row.cachedInputTokens || 0),
      outputTokens: Number(row.outputTokens || 0),
      reasoningOutputTokens: Number(row.reasoningOutputTokens || 0),
      totalTokens: Number(row.totalTokens || 0),
      costUsd: Number(row.costUsd || 0),
      models,
      syncedAt: Number(row.syncedAt || 0),
    };
  });
}

function latestCodexSyncTs(db: Database): number {
  const row = db
    .query<{ synced_at: number | null }, []>(
      'SELECT MAX(synced_at) AS synced_at FROM usage_codex_daily',
    )
    .get();

  return Number(row?.synced_at || 0);
}

async function syncDailyFromCcusage(
  db: Database,
  from: string | undefined,
  to: string | undefined,
): Promise<ClaudeDailyNormalizedRow[]> {
  const now = new Date();
  const defaultFrom = new Date(now);
  defaultFrom.setUTCDate(defaultFrom.getUTCDate() - 30);

  const rows = await ccusageDaily(from || yyyymmdd(defaultFrom), to || yyyymmdd(now));
  const normalized = rows.map(normalizeDailyRow);
  upsertDailyRows(db, normalized);
  return normalized;
}

async function syncCodexDailyToDb(
  db: Database,
  sinceIso: string,
  untilIso: string,
): Promise<CodexDailyNormalizedRow[]> {
  const syncedAt = Math.floor(Date.now() / 1000);
  const raw = await codexCcusageDaily(sinceIso, untilIso);
  const rows = raw
    .map((row) => normalizeCodexDailyRow(row, syncedAt))
    .filter((row): row is CodexDailyNormalizedRow => Boolean(row));

  upsertCodexDailyRows(db, rows);
  return rows;
}

function scheduleCodexDailySync(db: Database, sinceIso: string, untilIso: string): void {
  const key = `${sinceIso}:${untilIso}`;
  if (codexSyncInflight.get(key)) {
    return;
  }
  const nowSec = Math.floor(Date.now() / 1000);
  const cooldownUntil = codexSyncCooldownUntil.get(key) ?? 0;
  if (nowSec < cooldownUntil) {
    return;
  }

  const promise = syncCodexDailyToDb(db, sinceIso, untilIso)
    .then(() => {
      codexSyncCooldownUntil.delete(key);
    })
    .catch(() => {
      codexSyncCooldownUntil.set(key, Math.floor(Date.now() / 1000) + CODEX_SYNC_COOLDOWN_SECONDS);
    })
    .finally(() => {
      codexSyncInflight.delete(key);
    });

  codexSyncInflight.set(key, promise);
}

function combineDailyRows(
  claudeRows: ClaudeDailyNormalizedRow[],
  codexRows: CodexDailyNormalizedRow[],
): CombinedDailyRow[] {
  const map = new Map<string, CombinedDailyRow>();

  for (const row of claudeRows) {
    if (!row.date) {
      continue;
    }

    const existing =
      map.get(row.date) ||
      ({
        date: row.date,
        claudeInputTokens: 0,
        claudeOutputTokens: 0,
        claudeCacheCreateTokens: 0,
        claudeCacheReadTokens: 0,
        claudeTokens: 0,
        claudeCostUsd: 0,
        claudeSubCostUsd: 0,
        codexInputTokens: 0,
        codexCachedInputTokens: 0,
        codexOutputTokens: 0,
        codexReasoningOutputTokens: 0,
        codexTokens: 0,
        codexCostUsd: 0,
        codexSubCostUsd: 0,
        totalTokens: 0,
        totalCostUsd: 0,
        totalSubCostUsd: 0,
      } satisfies CombinedDailyRow);

    existing.claudeInputTokens += row.inputTokens;
    existing.claudeOutputTokens += row.outputTokens;
    existing.claudeCacheCreateTokens += row.cacheCreate;
    existing.claudeCacheReadTokens += row.cacheRead;
    // Include cache tokens in the total so claudeTokens is comparable to
    // codexTokens (which already contains input + output + reasoning +
    // cached via row.totalTokens from usage_codex_daily). Previously
    // claudeTokens omitted cache, making the daily-combined chart mix two
    // different conventions.
    existing.claudeTokens += row.inputTokens + row.outputTokens + row.cacheCreate + row.cacheRead;
    existing.claudeCostUsd += row.costUsd;

    existing.totalTokens = existing.claudeTokens + existing.codexTokens;
    existing.totalCostUsd = existing.claudeCostUsd + existing.codexCostUsd;

    map.set(row.date, existing);
  }

  for (const row of codexRows) {
    if (!row.date) {
      continue;
    }

    const existing =
      map.get(row.date) ||
      ({
        date: row.date,
        claudeInputTokens: 0,
        claudeOutputTokens: 0,
        claudeCacheCreateTokens: 0,
        claudeCacheReadTokens: 0,
        claudeTokens: 0,
        claudeCostUsd: 0,
        claudeSubCostUsd: 0,
        codexInputTokens: 0,
        codexCachedInputTokens: 0,
        codexOutputTokens: 0,
        codexReasoningOutputTokens: 0,
        codexTokens: 0,
        codexCostUsd: 0,
        codexSubCostUsd: 0,
        totalTokens: 0,
        totalCostUsd: 0,
        totalSubCostUsd: 0,
      } satisfies CombinedDailyRow);

    existing.codexInputTokens += row.inputTokens;
    existing.codexCachedInputTokens += row.cachedInputTokens;
    existing.codexOutputTokens += row.outputTokens;
    existing.codexReasoningOutputTokens += row.reasoningOutputTokens;
    existing.codexTokens += row.totalTokens;
    existing.codexCostUsd += row.costUsd;

    existing.totalTokens = existing.claudeTokens + existing.codexTokens;
    existing.totalCostUsd = existing.claudeCostUsd + existing.codexCostUsd;

    map.set(row.date, existing);
  }

  return [...map.values()].sort((a, b) => a.date.localeCompare(b.date));
}

function knownProjectsFromDb(db: Database): KnownProject[] {
  return db
    .query('SELECT id, name, path FROM projects ORDER BY last_modified DESC')
    .all() as KnownProject[];
}

function usageMeta(snapshot: {
  generatedAt: number;
  fromTs: number;
  toTs: number;
  filesScanned: number;
  linesParsed: number;
  assistantMessages: number;
  userMessages: number;
}) {
  return {
    generatedAt: snapshot.generatedAt,
    fromTs: snapshot.fromTs,
    toTs: snapshot.toTs,
    filesScanned: snapshot.filesScanned,
    linesParsed: snapshot.linesParsed,
    assistantMessages: snapshot.assistantMessages,
    userMessages: snapshot.userMessages,
  };
}

export function registerUsageRoutes(app: Hono): void {
  app.get('/api/usage/daily', async (c) => {
    const from = c.req.query('from');
    const to = c.req.query('to');

    try {
      const db = getDb();
      const normalized = await syncDailyFromCcusage(db, from, to);
      return c.json(normalized);
    } catch (error) {
      const db = getDb();
      const range = parseRange(from, to, 90);
      const cached = loadCachedDailyRows(
        db,
        isoDateFromTs(range.fromTs),
        isoDateFromTs(range.toTs),
      );

      if (cached.length > 0) {
        return c.json({ source: 'cache', rows: cached, warning: String(error) });
      }

      return c.json({
        source: 'empty',
        rows: [],
        warning: `ccusage_failed: ${String(error)}`,
      });
    }
  });

  app.get('/api/usage/codex/daily', async (c) => {
    const db = getDb();
    const range = parseRange(c.req.query('from'), c.req.query('to'), 90);
    const sinceIso = isoDateFromTs(range.fromTs);
    const untilIso = isoDateFromTs(range.toTs);

    let warning: string | null = null;
    const rows = loadCachedCodexDailyRows(db, sinceIso, untilIso);

    const latestSync = latestCodexSyncTs(db);
    const now = Math.floor(Date.now() / 1000);
    const stale = latestSync <= 0 || now - latestSync > CODEX_SYNC_STALE_SECONDS;

    if (rows.length === 0 || stale) {
      scheduleCodexDailySync(db, sinceIso, untilIso);
      if (rows.length === 0) {
        warning = 'codex_usage_cache_empty_sync_scheduled';
      }
    }

    return c.json({ rows, warning });
  });

  app.get('/api/usage/daily-combined', async (c) => {
    const db = getDb();
    const range = parseRange(c.req.query('from'), c.req.query('to'), 90);
    const sinceIso = isoDateFromTs(range.fromTs);
    const untilIso = isoDateFromTs(range.toTs);

    const claudeRows = loadCachedDailyRows(db, sinceIso, untilIso);
    // Per-project table as source-of-truth for the daily-combined chart:
    // always fresh (updated by the project scanner) and matches local-tz
    // bucketing, unlike ccusage-codex which can lag 1 day or drop today.
    const codexRows = loadCodexDailyFromPerProject(db, sinceIso, untilIso);

    let claudeWarning: string | null = null;
    let codexWarning: string | null = null;

    if (claudeRows.length > 0) {
      void syncDailyFromCcusage(
        db,
        compactDateFromTs(range.fromTs),
        compactDateFromTs(range.toTs),
      ).catch(() => {});
    } else {
      claudeWarning = 'claude_usage_cache_empty';
      void syncDailyFromCcusage(
        db,
        compactDateFromTs(range.fromTs),
        compactDateFromTs(range.toTs),
      ).catch(() => {});
    }

    const latestSync = latestCodexSyncTs(db);
    const now = Math.floor(Date.now() / 1000);
    const stale = latestSync <= 0 || now - latestSync > CODEX_SYNC_STALE_SECONDS;

    if (codexRows.length === 0 || stale) {
      scheduleCodexDailySync(db, sinceIso, untilIso);
      if (codexRows.length === 0) {
        codexWarning = 'codex_usage_cache_empty_sync_scheduled';
      }
    }

    const rows = combineDailyRows(claudeRows, codexRows);

    // Overlay subscription cost per day. dailyRateOnDate returns EUR; chart
    // axis is USD so we convert via usdToEur. When billingHistory has no
    // charge covering a given date, the rate is 0 and the sub line dips.
    const settings = await loadSettings();
    const usdToEur = settings.subscriptions.usdToEur || 1;
    for (const row of rows) {
      const claudeEur = dailyRateOnDate(settings.billingHistory.claude, 'claude', row.date);
      const codexEur = dailyRateOnDate(settings.billingHistory.codex, 'codex', row.date);
      row.claudeSubCostUsd = claudeEur / usdToEur;
      row.codexSubCostUsd = codexEur / usdToEur;
      row.totalSubCostUsd = row.claudeSubCostUsd + row.codexSubCostUsd;
    }

    return c.json({
      rows,
      warnings: {
        claude: claudeWarning,
        codex: codexWarning,
      },
    });
  });

  // Both sync endpoints shell out to ccusage CLIs — bound to 3 per minute to
  // prevent button-mashing from stacking up concurrent CLI spawns.
  const usageSyncRl = rateLimit(3, 60_000);

  app.post('/api/usage/sync', async (c) => {
    const verdict = usageSyncRl.check('claude');
    if (!verdict.ok) {
      return c.json({ error: 'rate_limited', retryAfterMs: verdict.retryAfterMs }, 429, {
        'retry-after': String(Math.ceil(verdict.retryAfterMs / 1000)),
      });
    }
    const body = await c.req.json().catch(() => ({}));
    const from = typeof body.from === 'string' ? body.from : undefined;
    const to = typeof body.to === 'string' ? body.to : undefined;

    try {
      const db = getDb();
      const rows = await syncDailyFromCcusage(db, from, to);
      return c.json({ ok: true, rows: rows.length });
    } catch (error) {
      return c.json({ ok: false, error: 'usage_sync_failed', details: String(error) }, 500);
    }
  });

  app.post('/api/usage/codex/sync', async (c) => {
    const verdict = usageSyncRl.check('codex');
    if (!verdict.ok) {
      return c.json({ error: 'rate_limited', retryAfterMs: verdict.retryAfterMs }, 429, {
        'retry-after': String(Math.ceil(verdict.retryAfterMs / 1000)),
      });
    }
    const body = await c.req.json().catch(() => ({}));
    const range = parseRange(body.from, body.to, 90);
    const sinceIso = isoDateFromTs(range.fromTs);
    const untilIso = isoDateFromTs(range.toTs);

    try {
      const db = getDb();
      const rows = await syncCodexDailyToDb(db, sinceIso, untilIso);
      return c.json({ ok: true, rows: rows.length });
    } catch (error) {
      return c.json({ ok: false, error: 'codex_usage_sync_failed', details: String(error) }, 500);
    }
  });

  app.get('/api/usage/monthly', async (c) => {
    try {
      const monthly = await ccusageMonthly();
      return c.json(monthly);
    } catch (error) {
      return c.json({ error: 'ccusage_monthly_failed', details: String(error) }, 500);
    }
  });

  app.get('/api/usage/codex/monthly', async (c) => {
    try {
      const monthly = await codexCcusageMonthly();
      return c.json(monthly);
    } catch (error) {
      return c.json({ error: 'codex_ccusage_monthly_failed', details: String(error) }, 500);
    }
  });

  app.get('/api/usage/codex/session', async (c) => {
    const from = c.req.query('from');
    const to = c.req.query('to');

    try {
      const sessions = await codexCcusageSession(from, to);
      return c.json(sessions);
    } catch (error) {
      return c.json({ error: 'codex_ccusage_session_failed', details: String(error) }, 500);
    }
  });

  app.get('/api/usage/by-project', async (c) => {
    try {
      const db = getDb();
      const range = parseRange(c.req.query('from'), c.req.query('to'), 30);
      const limit = Math.min(Number.parseInt(c.req.query('limit') || '80', 10), 500);
      const projectId = c.req.query('projectId');
      const project = c.req.query('project');
      // This endpoint returns Claude-shaped rows (inputTokens / cacheCreate /
      // cacheRead / messageCount / etc.). A prior `source=codex` branch fell
      // back to `getClaudeUsageSnapshot` on empty DB, returning Claude data
      // labeled as Codex — silent corruption. For Codex use the dedicated
      // `/api/usage/codex/by-project` endpoint instead.
      const source = 'claude';

      const fromDate = isoDateFromTs(range.fromTs);
      const toDate = isoDateFromTs(range.toTs);

      const countRow = db
        .query<{ n: number }, [string, string, string]>(
          'SELECT COUNT(*) AS n FROM usage_daily_by_project WHERE source = ? AND date >= ? AND date <= ?',
        )
        .get(source, fromDate, toDate);

      // Fallback to live JSONL scan if aggregated DB has no data yet for this range.
      if (!countRow || countRow.n === 0) {
        const settings = await loadSettings();
        const knownProjects = knownProjectsFromDb(db);
        const snapshot = await getClaudeUsageSnapshot({
          claudeConfigDir: settings.paths.claudeConfigDir,
          projectRoots: settings.paths.projectsRoots.map((root) => expandHomePath(root)),
          knownProjects,
          fromTs: range.fromTs,
          toTs: range.toTs,
          maxFiles: JSONL_SCAN_MAX_FILES,
          maxTailLines: JSONL_SCAN_MAX_TAIL_LINES,
        });

        let rows = [...snapshot.byProject];
        if (projectId) {
          rows = rows.filter((row) => row.projectId === projectId);
        }
        if (project) {
          rows = rows.filter(
            (row) =>
              row.projectKey === project ||
              row.projectPath === project ||
              row.projectName === project,
          );
        }
        rows = rows.slice(0, limit);
        return c.json({ rows, meta: { ...usageMeta(snapshot), fallback: 'live_jsonl_scan' } });
      }

      const filters: string[] = ['source = ?', 'date >= ?', 'date <= ?'];
      const params: (string | number)[] = [source, fromDate, toDate];
      if (projectId) {
        filters.push('project_id = ?');
        params.push(projectId);
      }
      if (project) {
        filters.push('(project_key = ? OR project_path = ? OR project_name = ?)');
        params.push(project, project, project);
      }

      const rows = db
        .query(
          `SELECT
             project_key AS projectKey,
             MAX(project_path) AS projectPath,
             MAX(project_id) AS projectId,
             MAX(project_name) AS projectName,
             SUM(input_tokens) AS inputTokens,
             SUM(output_tokens) AS outputTokens,
             SUM(cache_create) AS cacheCreate,
             SUM(cache_read) AS cacheRead,
             SUM(total_tokens) AS totalTokens,
             SUM(messages) AS messageCount,
             SUM(messages) AS assistantMessages,
             0 AS userMessages,
             SUM(sessions) AS sessions,
             SUM(cost_usd) AS costUsd,
             MAX(synced_at) AS lastTs
           FROM usage_daily_by_project
           WHERE ${filters.join(' AND ')}
           GROUP BY project_key
           ORDER BY totalTokens DESC
           LIMIT ?`,
        )
        .all(...params, limit) as Array<{
        projectKey: string;
        projectPath: string | null;
        projectId: string | null;
        projectName: string | null;
        inputTokens: number;
        outputTokens: number;
        cacheCreate: number;
        cacheRead: number;
        totalTokens: number;
        messageCount: number;
        assistantMessages: number;
        userMessages: number;
        sessions: number;
        costUsd: number;
        lastTs: number | null;
      }>;

      // Time-weighted daily accrual: split each day's subscription rate across projects
      // active that day proportionally to their tokens. Projects created yesterday
      // only receive 1 day of accrual — NOT the full window's share.
      const settings = await loadSettings();
      // Attribution weight = fresh tokens = input + output (cache excluded).
      // `usage_daily_by_project` already normalises both providers: Claude's
      // input_tokens excludes cache_read (billed separately), and Codex's
      // input_tokens is stored as input_net (cached_input subtracted at
      // ingest — see buildCodexDailyByProject, output already includes
      // reasoning). So `input + output` is the apples-to-apples "fresh work"
      // figure across providers. Using `total_tokens` here (as before)
      // over-weighted projects with heavy cache_read, giving them a
      // disproportionate share of the subscription.
      const dailyRaw = db
        .query(
          'SELECT date, project_key AS projectKey, source, SUM(input_tokens + output_tokens) AS tokens FROM usage_daily_by_project WHERE source = ? AND date >= ? AND date <= ? GROUP BY date, project_key, source',
        )
        .all(source, fromDate, toDate) as Array<{
        date: string;
        projectKey: string;
        source: 'claude' | 'codex';
        tokens: number;
      }>;
      const dailyRows: DailyTokenRow[] = dailyRaw.map((r) => ({
        date: r.date,
        projectKey: r.projectKey,
        source: r.source,
        tokens: r.tokens,
      }));
      const accrual = computeProjectAccrual(
        dailyRows,
        settings.billingHistory,
        range.fromTs,
        range.toTs,
      );

      // Pull models/tools JSON per project: fetch raw daily rows with JSON blobs, aggregate.
      const modelsToolsRaw = db
        .query(
          `SELECT project_key AS projectKey, models_json AS modelsJson, tools_json AS toolsJson
           FROM usage_daily_by_project
           WHERE ${filters.join(' AND ')}`,
        )
        .all(...params) as Array<{
        projectKey: string;
        modelsJson: string | null;
        toolsJson: string | null;
      }>;

      const modelsByProject = new Map<string, Map<string, { tokens: number; messages: number }>>();
      const toolsByProject = new Map<string, Map<string, number>>();
      for (const row of modelsToolsRaw) {
        if (row.modelsJson) {
          try {
            const parsed = JSON.parse(row.modelsJson) as Array<{
              model: string;
              tokens: number;
              messages: number;
            }>;
            let modelMap = modelsByProject.get(row.projectKey);
            if (!modelMap) {
              modelMap = new Map();
              modelsByProject.set(row.projectKey, modelMap);
            }
            for (const m of parsed) {
              const existing = modelMap.get(m.model) || { tokens: 0, messages: 0 };
              existing.tokens += Number(m.tokens || 0);
              existing.messages += Number(m.messages || 0);
              modelMap.set(m.model, existing);
            }
          } catch {
            /* ignore malformed JSON */
          }
        }
        if (row.toolsJson) {
          try {
            const parsed = JSON.parse(row.toolsJson) as Array<{ name: string; count: number }>;
            let toolMap = toolsByProject.get(row.projectKey);
            if (!toolMap) {
              toolMap = new Map();
              toolsByProject.set(row.projectKey, toolMap);
            }
            for (const t of parsed) {
              toolMap.set(t.name, (toolMap.get(t.name) || 0) + Number(t.count || 0));
            }
          } catch {
            /* ignore */
          }
        }
      }

      const enriched = rows.map((row) => {
        const avgOutputTokens =
          row.assistantMessages > 0 ? row.outputTokens / row.assistantMessages : 0;
        const denom = row.inputTokens + row.cacheRead;
        const cacheReuseRatio = denom > 0 ? row.cacheRead / denom : 0;
        const a = accrual.get(row.projectKey);
        const modelMap = modelsByProject.get(row.projectKey);
        const toolMap = toolsByProject.get(row.projectKey);
        const models = modelMap
          ? [...modelMap.entries()]
              .map(([model, s]) => ({ model, tokens: s.tokens, messages: s.messages }))
              .sort((a, b) => b.tokens - a.tokens)
          : [];
        const tools = toolMap
          ? [...toolMap.entries()]
              .map(([name, count]) => ({ name, count }))
              .sort((a, b) => b.count - a.count)
          : [];
        return {
          ...row,
          avgOutputTokens,
          cacheReuseRatio,
          accruedEur: a?.accruedEur ?? 0,
          firstSeenTs: a?.firstSeenTs ?? null,
          lastSeenTs: a?.lastSeenTs ?? null,
          activeDays: a?.activeDays ?? 0,
          models,
          tools,
        };
      });

      const meta = db
        .query<{ filesScanned: number; minSyncedAt: number | null }, [string, string, string]>(
          'SELECT COUNT(*) AS filesScanned, MIN(synced_at) AS minSyncedAt FROM usage_daily_by_project WHERE source = ? AND date >= ? AND date <= ?',
        )
        .get(source, fromDate, toDate) || { filesScanned: 0, minSyncedAt: null };

      return c.json({
        rows: enriched,
        meta: {
          generatedAt: Math.floor(Date.now() / 1000),
          fromTs: range.fromTs,
          toTs: range.toTs,
          filesScanned: meta.filesScanned,
          linesParsed: 0,
          source: 'db_aggregated',
          oldestSyncedAt: meta.minSyncedAt,
        },
      });
    } catch (error) {
      return c.json({ error: 'usage_by_project_failed', details: String(error) }, 500);
    }
  });

  /**
   * Daily breakdown across ALL projects, both providers folded together
   * — feeds the usage page's cumul stacked-bars view (one segment per
   * project). Different from `/by-project/daily` which requires a single
   * project filter and returns a row per (date, source).
   *
   * Tokens (provider-normalised at ingest in `usage_daily_by_project`):
   *   - tokensActive = input + output                       (fresh work)
   *   - tokensAll    = active + cache_create + cache_read
   *
   * Cost = `realEur` = time-weighted subscription accrual in EUR.
   *   For each (date, source) we split that day's subscription daily rate
   *   across active projects proportionally to their fresh tokens. Same
   *   semantics as the project list's "ABO RÉEL" column — the user is
   *   already calibrated on this number, so the cumul cost view stacks
   *   the SAME quantity over time. Pure pay-as-you-go USD (cost_usd) was
   *   misleading because the dashboard primarily reports EUR sub cost.
   */
  app.get('/api/usage/by-project/stacked-daily', async (c) => {
    try {
      const db = getDb();
      const settings = await loadSettings();
      const range = parseRange(c.req.query('from'), c.req.query('to'), 365);
      const fromDate = isoDateFromTs(range.fromTs);
      const toDate = isoDateFromTs(range.toTs);

      // 1) Per (date, project_key, source): tokens (active + all) + raw
      //    key/name. Source is preserved so the client can split the
      //    Tokens view by claude vs codex within each project segment.
      //    Display name is derived in JS (see `displayName` below) — when
      //    no `project_name` is set we fall back to the BASENAME of the
      //    key, not the full path. Long absolute paths in the tooltip
      //    legend were wrapping/truncating ("/Volumes/nvme/projet claud…").
      const tokenRows = db
        .query(
          `SELECT
             date,
             project_key       AS projectKey,
             source,
             MAX(project_name) AS projectName,
             SUM(input_tokens + output_tokens) AS tokensActive,
             SUM(input_tokens + output_tokens + cache_create + cache_read) AS tokensAll
           FROM usage_daily_by_project
           WHERE date >= ? AND date <= ?
           GROUP BY date, project_key, source
           ORDER BY date ASC`,
        )
        .all(fromDate, toDate) as Array<{
        date: string;
        projectKey: string;
        source: 'claude' | 'codex';
        projectName: string | null;
        tokensActive: number;
        tokensAll: number;
      }>;

      const displayName = (projectName: string | null, projectKey: string): string => {
        const trimmed = projectName?.trim();
        if (trimmed && trimmed.length > 0) return trimmed;
        const parts = projectKey.split('/').filter(Boolean);
        return parts.length > 0 ? parts[parts.length - 1] : projectKey;
      };

      // 2) Per (date, project_key, source): fresh-token weight for the
      //    accrual split. Same query shape `computeProjectAccrual` uses,
      //    just kept day-resolution instead of being summed away.
      const weightRows = db
        .query(
          `SELECT date, project_key AS projectKey, source,
                  SUM(input_tokens + output_tokens) AS tokens
           FROM usage_daily_by_project
           WHERE date >= ? AND date <= ?
           GROUP BY date, project_key, source`,
        )
        .all(fromDate, toDate) as Array<{
        date: string;
        projectKey: string;
        source: 'claude' | 'codex';
        tokens: number;
      }>;

      // 3) Day×source totals → daily rate × project share = per-project EUR.
      type Bucket = { totalTokens: number; entries: Array<{ projectKey: string; tokens: number }> };
      const byDaySource = new Map<string, Bucket>();
      for (const r of weightRows) {
        if (r.tokens <= 0) continue;
        const key = `${r.date}::${r.source}`;
        const bucket = byDaySource.get(key) ?? { totalTokens: 0, entries: [] };
        bucket.totalTokens += r.tokens;
        bucket.entries.push({ projectKey: r.projectKey, tokens: r.tokens });
        byDaySource.set(key, bucket);
      }
      // Keyed by `${date}::${projectKey}::${source}` so the client can
      // line up each token row (which is now per (date, project, source))
      // with the matching accrual share without extra rebucketing.
      const accrualByDayProjectSource = new Map<string, number>();
      // Days where the subscription is active but NO project consumed tokens
      // — this slice of the abo is real cash but unattributable to a project.
      // Without it the cumul cost view systematically undercounts vs the
      // total cash paid (see kpis.idleWithDataEur in ProjectsUsageLLM).
      const idleByDate = new Map<string, number>(); // date → eur (sum across sources)

      const enumerateDays = (fromIso: string, toIso: string): string[] => {
        const out: string[] = [];
        const start = new Date(`${fromIso}T00:00:00Z`);
        const end = new Date(`${toIso}T00:00:00Z`);
        for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
          out.push(d.toISOString().slice(0, 10));
        }
        return out;
      };

      const claudeCharges = settings.billingHistory?.claude || [];
      const codexCharges = settings.billingHistory?.codex || [];
      for (const date of enumerateDays(fromDate, toDate)) {
        for (const source of ['claude', 'codex'] as const) {
          const charges = source === 'claude' ? claudeCharges : codexCharges;
          const rate = dailyRateOnDate(charges, source, date);
          if (rate <= 0) continue;
          const bucket = byDaySource.get(`${date}::${source}`);
          if (bucket && bucket.totalTokens > 0) {
            for (const e of bucket.entries) {
              const share = rate * (e.tokens / bucket.totalTokens);
              const k = `${date}::${e.projectKey}::${source}`;
              accrualByDayProjectSource.set(k, (accrualByDayProjectSource.get(k) ?? 0) + share);
            }
          } else {
            // Subscription active, no project active that day for this source
            // → bucket the daily rate into the synthetic "idle" series.
            idleByDate.set(date, (idleByDate.get(date) ?? 0) + rate);
          }
        }
      }

      // 4) Stitch token rows + accrual into the response shape.
      const rows: Array<{
        date: string;
        project: string;
        source: 'claude' | 'codex' | null;
        tokensActive: number;
        tokensAll: number;
        realEur: number;
      }> = tokenRows.map((r) => ({
        date: r.date,
        project: displayName(r.projectName, r.projectKey),
        source: r.source,
        tokensActive: Number(r.tokensActive ?? 0),
        tokensAll: Number(r.tokensAll ?? 0),
        realEur: accrualByDayProjectSource.get(`${r.date}::${r.projectKey}::${r.source}`) ?? 0,
      }));
      // Idle rows: source-less by design (the client folds idle across
      // sources into a single neutral segment, no per-source split).
      for (const [date, eur] of idleByDate.entries()) {
        if (eur <= 0) continue;
        rows.push({
          date,
          project: '__idle__',
          source: null,
          tokensActive: 0,
          tokensAll: 0,
          realEur: eur,
        });
      }

      return c.json({
        rows,
        meta: { fromTs: range.fromTs, toTs: range.toTs },
      });
    } catch (error) {
      return c.json(
        { error: 'usage_by_project_stacked_daily_failed', details: String(error) },
        500,
      );
    }
  });

  app.get('/api/usage/by-project/daily', async (c) => {
    try {
      const db = getDb();
      const range = parseRange(c.req.query('from'), c.req.query('to'), 365);
      const projectId = c.req.query('projectId');
      const project = c.req.query('project');

      if (!projectId && !project) {
        return c.json({ error: 'missing_project_filter' }, 400);
      }

      const fromDate = isoDateFromTs(range.fromTs);
      const toDate = isoDateFromTs(range.toTs);

      const filters: string[] = ['date >= ?', 'date <= ?'];
      const params: (string | number)[] = [fromDate, toDate];
      if (projectId) {
        filters.push('project_id = ?');
        params.push(projectId);
      }
      if (project) {
        filters.push('(project_key = ? OR project_path = ? OR project_name = ?)');
        params.push(project, project, project);
      }

      const rows = db
        .query(
          `SELECT
             date,
             source,
             SUM(input_tokens) AS inputTokens,
             SUM(output_tokens) AS outputTokens,
             SUM(cache_create) AS cacheCreate,
             SUM(cache_read) AS cacheRead,
             SUM(total_tokens) AS totalTokens,
             SUM(messages) AS messages,
             SUM(sessions) AS sessions,
             SUM(cost_usd) AS costUsd
           FROM usage_daily_by_project
           WHERE ${filters.join(' AND ')}
           GROUP BY date, source
           ORDER BY date ASC`,
        )
        .all(...params) as Array<{
        date: string;
        source: 'claude' | 'codex';
        inputTokens: number;
        outputTokens: number;
        cacheCreate: number;
        cacheRead: number;
        totalTokens: number;
        messages: number;
        sessions: number;
        costUsd: number;
      }>;

      return c.json({
        rows,
        meta: {
          fromTs: range.fromTs,
          toTs: range.toTs,
          projectId: projectId || null,
          project: project || null,
        },
      });
    } catch (error) {
      return c.json({ error: 'usage_by_project_daily_failed', details: String(error) }, 500);
    }
  });

  app.get('/api/usage/by-model', async (c) => {
    try {
      const db = getDb();
      const settings = await loadSettings();
      const range = parseRange(c.req.query('from'), c.req.query('to'), 30);

      const snapshot = await getClaudeUsageSnapshot({
        claudeConfigDir: settings.paths.claudeConfigDir,
        projectRoots: settings.paths.projectsRoots.map((root) => expandHomePath(root)),
        knownProjects: knownProjectsFromDb(db),
        fromTs: range.fromTs,
        toTs: range.toTs,
        maxFiles: JSONL_SCAN_MAX_FILES,
        maxTailLines: JSONL_SCAN_MAX_TAIL_LINES,
      });

      return c.json({
        rows: snapshot.byModel,
        meta: usageMeta(snapshot),
      });
    } catch (error) {
      return c.json({ error: 'usage_by_model_failed', details: String(error) }, 500);
    }
  });

  app.get('/api/usage/hour-distribution', async (c) => {
    try {
      const db = getDb();
      const settings = await loadSettings();
      const range = parseRange(c.req.query('from'), c.req.query('to'), 30);

      const snapshot = await getClaudeUsageSnapshot({
        claudeConfigDir: settings.paths.claudeConfigDir,
        projectRoots: settings.paths.projectsRoots.map((root) => expandHomePath(root)),
        knownProjects: knownProjectsFromDb(db),
        fromTs: range.fromTs,
        toTs: range.toTs,
        maxFiles: JSONL_SCAN_MAX_FILES,
        maxTailLines: JSONL_SCAN_MAX_TAIL_LINES,
      });

      return c.json({
        rows: snapshot.hourly,
        meta: usageMeta(snapshot),
      });
    } catch (error) {
      return c.json({ error: 'usage_hour_distribution_failed', details: String(error) }, 500);
    }
  });

  app.get('/api/usage/tool-usage', async (c) => {
    try {
      const db = getDb();
      const settings = await loadSettings();
      const range = parseRange(c.req.query('from'), c.req.query('to'), 30);
      const projectId = c.req.query('projectId');
      const project = c.req.query('project');

      const snapshot = await getClaudeUsageSnapshot({
        claudeConfigDir: settings.paths.claudeConfigDir,
        projectRoots: settings.paths.projectsRoots.map((root) => expandHomePath(root)),
        knownProjects: knownProjectsFromDb(db),
        fromTs: range.fromTs,
        toTs: range.toTs,
        maxFiles: JSONL_SCAN_MAX_FILES,
        maxTailLines: JSONL_SCAN_MAX_TAIL_LINES,
      });

      let selected = null as (typeof snapshot.byProject)[number] | null;
      if (projectId) {
        selected = snapshot.byProject.find((row) => row.projectId === projectId) || null;
      } else if (project) {
        selected =
          snapshot.byProject.find(
            (row) =>
              row.projectKey === project ||
              row.projectPath === project ||
              row.projectName === project,
          ) || null;
      }

      if (selected) {
        return c.json({
          rows: selected.tools,
          project: {
            projectKey: selected.projectKey,
            projectPath: selected.projectPath,
            projectId: selected.projectId,
            projectName: selected.projectName,
          },
          meta: usageMeta(snapshot),
        });
      }

      return c.json({
        rows: snapshot.tools,
        project: null,
        meta: usageMeta(snapshot),
      });
    } catch (error) {
      return c.json({ error: 'usage_tool_usage_failed', details: String(error) }, 500);
    }
  });

  app.get('/api/usage/codex/by-project', async (c) => {
    try {
      const db = getDb();
      const range = parseRange(c.req.query('from'), c.req.query('to'), 30);
      const limit = Math.min(Number.parseInt(c.req.query('limit') || '80', 10), 500);
      const projectId = c.req.query('projectId');
      const project = c.req.query('project');

      const fromDate = isoDateFromTs(range.fromTs);
      const toDate = isoDateFromTs(range.toTs);

      const countRow = db
        .query<{ n: number }, [string, string]>(
          "SELECT COUNT(*) AS n FROM usage_daily_by_project WHERE source = 'codex' AND date >= ? AND date <= ?",
        )
        .get(fromDate, toDate);

      if (!countRow || countRow.n === 0) {
        const settings = await loadSettings();
        const snapshot = await getCodexUsageSnapshot({
          projectRoots: settings.paths.projectsRoots.map((root) => expandHomePath(root)),
          knownProjects: knownProjectsFromDb(db),
          fromTs: range.fromTs,
          toTs: range.toTs,
          maxFiles: CODEX_JSONL_MAX_FILES,
        });
        let rows = [...snapshot.byProject];
        if (projectId) {
          rows = rows.filter((row) => row.projectId === projectId);
        }
        if (project) {
          rows = rows.filter(
            (row) =>
              row.projectKey === project ||
              row.projectPath === project ||
              row.projectName === project,
          );
        }
        rows = rows.slice(0, limit);
        return c.json({ rows, meta: { ...codexUsageMeta(snapshot), fallback: 'live_jsonl_scan' } });
      }

      const filters: string[] = ["source = 'codex'", 'date >= ?', 'date <= ?'];
      const params: (string | number)[] = [fromDate, toDate];
      if (projectId) {
        filters.push('project_id = ?');
        params.push(projectId);
      }
      if (project) {
        filters.push('(project_key = ? OR project_path = ? OR project_name = ?)');
        params.push(project, project, project);
      }

      const rows = db
        .query(
          `SELECT
             project_key AS projectKey,
             MAX(project_path) AS projectPath,
             MAX(project_id) AS projectId,
             MAX(project_name) AS projectName,
             SUM(input_tokens) AS inputTokens,
             SUM(cache_read) AS cachedInputTokens,
             SUM(output_tokens) AS outputTokens,
             0 AS reasoningOutputTokens,
             SUM(total_tokens) AS totalTokens,
             SUM(messages) AS turns,
             SUM(sessions) AS sessions,
             SUM(cost_usd) AS costUsd,
             MAX(synced_at) AS lastTs
           FROM usage_daily_by_project
           WHERE ${filters.join(' AND ')}
           GROUP BY project_key
           ORDER BY totalTokens DESC
           LIMIT ?`,
        )
        .all(...params, limit) as Array<{
        projectKey: string;
        projectPath: string | null;
        projectId: string | null;
        projectName: string | null;
        inputTokens: number;
        cachedInputTokens: number;
        outputTokens: number;
        reasoningOutputTokens: number;
        totalTokens: number;
        turns: number;
        sessions: number;
        costUsd: number;
        lastTs: number | null;
      }>;

      const settings = await loadSettings();
      const dailyRaw = db
        .query(
          "SELECT date, project_key AS projectKey, source, SUM(input_tokens + output_tokens) AS tokens FROM usage_daily_by_project WHERE source = 'codex' AND date >= ? AND date <= ? GROUP BY date, project_key, source",
        )
        .all(fromDate, toDate) as Array<{
        date: string;
        projectKey: string;
        source: 'claude' | 'codex';
        tokens: number;
      }>;
      const accrual = computeProjectAccrual(
        dailyRaw as DailyTokenRow[],
        settings.billingHistory,
        range.fromTs,
        range.toTs,
      );

      // Pull models/tools JSON per project (codex source)
      const modelsToolsRaw = db
        .query(
          `SELECT project_key AS projectKey, models_json AS modelsJson, tools_json AS toolsJson
           FROM usage_daily_by_project
           WHERE ${filters.join(' AND ')}`,
        )
        .all(...params) as Array<{
        projectKey: string;
        modelsJson: string | null;
        toolsJson: string | null;
      }>;
      const modelsByProject = new Map<string, Map<string, { tokens: number; turns: number }>>();
      const toolsByProject = new Map<string, Map<string, number>>();
      for (const row of modelsToolsRaw) {
        if (row.modelsJson) {
          try {
            const parsed = JSON.parse(row.modelsJson) as Array<{
              model: string;
              tokens: number;
              messages: number;
            }>;
            let modelMap = modelsByProject.get(row.projectKey);
            if (!modelMap) {
              modelMap = new Map();
              modelsByProject.set(row.projectKey, modelMap);
            }
            for (const m of parsed) {
              const existing = modelMap.get(m.model) || { tokens: 0, turns: 0 };
              existing.tokens += Number(m.tokens || 0);
              existing.turns += Number(m.messages || 0);
              modelMap.set(m.model, existing);
            }
          } catch {
            /* ignore */
          }
        }
        if (row.toolsJson) {
          try {
            const parsed = JSON.parse(row.toolsJson) as Array<{ name: string; count: number }>;
            let toolMap = toolsByProject.get(row.projectKey);
            if (!toolMap) {
              toolMap = new Map();
              toolsByProject.set(row.projectKey, toolMap);
            }
            for (const t of parsed) {
              toolMap.set(t.name, (toolMap.get(t.name) || 0) + Number(t.count || 0));
            }
          } catch {
            /* ignore */
          }
        }
      }

      const enriched = rows.map((row) => {
        const denom = row.inputTokens + row.cachedInputTokens;
        const cacheHitRatio = denom > 0 ? row.cachedInputTokens / denom : 0;
        const a = accrual.get(row.projectKey);
        const modelMap = modelsByProject.get(row.projectKey);
        const toolMap = toolsByProject.get(row.projectKey);
        const models = modelMap
          ? [...modelMap.entries()]
              .map(([model, s]) => ({ model, tokens: s.tokens, turns: s.turns }))
              .sort((a, b) => b.tokens - a.tokens)
          : [];
        const tools = toolMap
          ? [...toolMap.entries()]
              .map(([name, count]) => ({ name, count }))
              .sort((a, b) => b.count - a.count)
          : [];
        return {
          ...row,
          cacheHitRatio,
          accruedEur: a?.accruedEur ?? 0,
          firstSeenTs: a?.firstSeenTs ?? null,
          lastSeenTs: a?.lastSeenTs ?? null,
          activeDays: a?.activeDays ?? 0,
          models,
          tools,
        };
      });

      // Meta reflects the aggregated DB content, not a fresh JSONL scan.
      // filesScanned/linesParsed are N/A on this path so we report -1 to
      // signal "unavailable from this path" to the client; turns/sessions
      // come from the already-aggregated rows so the header doesn't render
      // NaN.
      const metaTotals = rows.reduce(
        (acc, r) => {
          acc.turns += Number(r.turns || 0);
          acc.sessions += Number(r.sessions || 0);
          return acc;
        },
        { turns: 0, sessions: 0 },
      );
      return c.json({
        rows: enriched,
        meta: {
          generatedAt: Math.floor(Date.now() / 1000),
          fromTs: range.fromTs,
          toTs: range.toTs,
          filesScanned: -1,
          linesParsed: -1,
          turns: metaTotals.turns,
          sessions: metaTotals.sessions,
          source: 'db_aggregated',
        },
      });
    } catch (error) {
      return c.json({ error: 'codex_usage_by_project_failed', details: String(error) }, 500);
    }
  });

  app.get('/api/usage/codex/by-model', async (c) => {
    try {
      const db = getDb();
      const settings = await loadSettings();
      const range = parseRange(c.req.query('from'), c.req.query('to'), 30);

      const snapshot = await getCodexUsageSnapshot({
        projectRoots: settings.paths.projectsRoots.map((root) => expandHomePath(root)),
        knownProjects: knownProjectsFromDb(db),
        fromTs: range.fromTs,
        toTs: range.toTs,
        maxFiles: CODEX_JSONL_MAX_FILES,
      });

      return c.json({
        rows: snapshot.byModel,
        meta: codexUsageMeta(snapshot),
      });
    } catch (error) {
      return c.json({ error: 'codex_usage_by_model_failed', details: String(error) }, 500);
    }
  });

  app.get('/api/usage/codex/hour-distribution', async (c) => {
    try {
      const db = getDb();
      const settings = await loadSettings();
      const range = parseRange(c.req.query('from'), c.req.query('to'), 30);

      const snapshot = await getCodexUsageSnapshot({
        projectRoots: settings.paths.projectsRoots.map((root) => expandHomePath(root)),
        knownProjects: knownProjectsFromDb(db),
        fromTs: range.fromTs,
        toTs: range.toTs,
        maxFiles: CODEX_JSONL_MAX_FILES,
      });

      return c.json({
        rows: snapshot.hourly,
        meta: codexUsageMeta(snapshot),
      });
    } catch (error) {
      return c.json({ error: 'codex_usage_hour_distribution_failed', details: String(error) }, 500);
    }
  });

  app.get('/api/usage/codex/tool-usage', async (c) => {
    try {
      const db = getDb();
      const settings = await loadSettings();
      const range = parseRange(c.req.query('from'), c.req.query('to'), 30);
      const projectId = c.req.query('projectId');
      const project = c.req.query('project');

      const snapshot = await getCodexUsageSnapshot({
        projectRoots: settings.paths.projectsRoots.map((root) => expandHomePath(root)),
        knownProjects: knownProjectsFromDb(db),
        fromTs: range.fromTs,
        toTs: range.toTs,
        maxFiles: CODEX_JSONL_MAX_FILES,
      });

      let selected = null as (typeof snapshot.byProject)[number] | null;
      if (projectId) {
        selected = snapshot.byProject.find((row) => row.projectId === projectId) || null;
      } else if (project) {
        selected =
          snapshot.byProject.find(
            (row) =>
              row.projectKey === project ||
              row.projectPath === project ||
              row.projectName === project,
          ) || null;
      }

      if (selected) {
        return c.json({
          rows: selected.tools,
          project: {
            projectKey: selected.projectKey,
            projectPath: selected.projectPath,
            projectId: selected.projectId,
            projectName: selected.projectName,
          },
          meta: codexUsageMeta(snapshot),
        });
      }

      return c.json({
        rows: snapshot.tools,
        project: null,
        meta: codexUsageMeta(snapshot),
      });
    } catch (error) {
      return c.json({ error: 'codex_usage_tool_usage_failed', details: String(error) }, 500);
    }
  });

  // Claude rate-limits: real Anthropic quotas pulled from `/api/oauth/usage`
  // (same endpoint the CLI `/status` panel uses) via the OAuth token in the
  // macOS keychain. Three bars exposed: 5h session, 7d all-models, 7d Sonnet.
  // Shape mirrors the Codex `rateLimits` convention so the UI reuses RateLimitRow.
  app.get('/api/usage/claude/rate-limits', async (c) => {
    try {
      // `?force=1` (used by the manual refresh button) bypasses the TTL
      // cache but still respects the 429 backoff window — we don't let the
      // user tap Anthropic raw.
      const force = c.req.query('force') === '1';
      const usage = await getOauthUsage({ force });
      if (!usage) {
        return c.json({ rateLimits: null });
      }

      const nowSec = Math.floor(Date.now() / 1000);
      const toBar = (bar: OauthUsageBar, windowMinutes: number) => {
        if (!bar) {
          return null;
        }
        const resetsAt = bar.resets_at ? Math.floor(new Date(bar.resets_at).getTime() / 1000) : 0;
        return {
          usedPercent: bar.utilization,
          windowMinutes,
          resetsAt,
        };
      };

      const rateLimits = {
        primary: toBar(usage.five_hour, 5 * 60),
        secondary: toBar(usage.seven_day, 7 * 24 * 60),
        tertiary: toBar(usage.seven_day_sonnet, 7 * 24 * 60),
        planType: 'claude (oauth)',
        observedAt: nowSec,
      };
      return c.json({ rateLimits });
    } catch (error) {
      console.warn('[claude/rate-limits] oauth usage failed', error);
      return c.json({ rateLimits: null });
    }
  });

  app.get('/api/usage/codex/rate-limits', async (c) => {
    try {
      const db = getDb();
      const settings = await loadSettings();
      const range = parseRange(c.req.query('from'), c.req.query('to'), 30);

      // Try the live OAuth endpoint first: gives real-time values even when
      // the user hasn't run Codex today (JSONL snapshots are stale by
      // definition until the next `token_count` event).
      const force = c.req.query('force') === '1';
      const live = await getCodexLiveRateLimits({ force });
      if (live.value) {
        // Minimal meta so UI doesn't crash on undefined fields. We skip the
        // JSONL scan entirely on the live path — paying that cost would
        // defeat the "fast live refresh" purpose.
        const nowSec = Math.floor(Date.now() / 1000);
        return c.json({
          rateLimits: live.value,
          source: 'live_oauth',
          liveCached: live.cached,
          meta: {
            generatedAt: nowSec,
            fromTs: range.fromTs,
            toTs: range.toTs,
            filesScanned: -1,
            linesParsed: -1,
            turns: 0,
            sessions: 0,
          },
        });
      }

      // Fall back to JSONL-embedded rate_limits. Annotate the response so
      // the client can surface the degraded mode.
      const snapshot = await getCodexUsageSnapshot({
        projectRoots: settings.paths.projectsRoots.map((root) => expandHomePath(root)),
        knownProjects: knownProjectsFromDb(db),
        fromTs: range.fromTs,
        toTs: range.toTs,
        maxFiles: CODEX_JSONL_MAX_FILES,
      });

      return c.json({
        rateLimits: snapshot.rateLimits,
        source: 'jsonl_fallback',
        liveError: live.error,
        meta: codexUsageMeta(snapshot),
      });
    } catch (error) {
      return c.json({ error: 'codex_usage_rate_limits_failed', details: String(error) }, 500);
    }
  });
}

function codexUsageMeta(snapshot: {
  generatedAt: number;
  fromTs: number;
  toTs: number;
  filesScanned: number;
  linesParsed: number;
  turns: number;
  sessions: number;
}) {
  return {
    generatedAt: snapshot.generatedAt,
    fromTs: snapshot.fromTs,
    toTs: snapshot.toTs,
    filesScanned: snapshot.filesScanned,
    linesParsed: snapshot.linesParsed,
    turns: snapshot.turns,
    sessions: snapshot.sessions,
  };
}
