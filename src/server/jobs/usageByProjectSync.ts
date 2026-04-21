import type { Database } from 'bun:sqlite';
import { expandHomePath, loadSettings } from '../config';
import { buildCodexDailyByProject } from '../wrappers/codexJsonlParser';
import { type DailyProjectAggregate, buildClaudeDailyByProject } from '../wrappers/jsonlParser';

type KnownProject = { id: string; name: string; path: string };

function knownProjectsFromDb(db: Database): KnownProject[] {
  return db.query<KnownProject, []>('SELECT id, name, path FROM projects').all();
}

function upsertRow(db: Database, row: DailyProjectAggregate, now: number): void {
  db.query(
    `INSERT INTO usage_daily_by_project (
      date, project_key, source,
      project_path, project_id, project_name,
      input_tokens, output_tokens, cache_create, cache_read, total_tokens,
      messages, sessions, cost_usd, models_json, tools_json, synced_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(date, project_key, source) DO UPDATE SET
      project_path = excluded.project_path,
      project_id = excluded.project_id,
      project_name = excluded.project_name,
      input_tokens = excluded.input_tokens,
      output_tokens = excluded.output_tokens,
      cache_create = excluded.cache_create,
      cache_read = excluded.cache_read,
      total_tokens = excluded.total_tokens,
      messages = excluded.messages,
      sessions = excluded.sessions,
      cost_usd = excluded.cost_usd,
      models_json = excluded.models_json,
      tools_json = excluded.tools_json,
      synced_at = excluded.synced_at`,
  ).run(
    row.date,
    row.projectKey,
    row.source,
    row.projectPath,
    row.projectId,
    row.projectName,
    row.inputTokens,
    row.outputTokens,
    row.cacheCreate,
    row.cacheRead,
    row.totalTokens,
    row.messages,
    row.sessions,
    row.costUsd,
    JSON.stringify(row.models),
    JSON.stringify(row.tools),
    now,
  );
}

export async function syncUsageByProject(
  db: Database,
  opts: { windowDays?: number } = {},
): Promise<{
  claudeRows: number;
  codexRows: number;
  filesScanned: number;
  linesParsed: number;
  durationMs: number;
}> {
  const started = performance.now();
  const windowDays = opts.windowDays || 90;
  const nowSec = Math.floor(Date.now() / 1000);
  const fromTs = nowSec - windowDays * 86400;
  const toTs = nowSec;

  const settings = await loadSettings();
  const knownProjects = knownProjectsFromDb(db);
  const projectRoots = settings.paths.projectsRoots.map((root) => expandHomePath(root));

  const [claude, codex] = await Promise.all([
    buildClaudeDailyByProject({
      claudeConfigDir: settings.paths.claudeConfigDir,
      projectRoots,
      knownProjects,
      fromTs,
      toTs,
    }).catch((error) => {
      console.warn('[usageByProjectSync] claude failed', error);
      return { rows: [], filesScanned: 0, linesParsed: 0 };
    }),
    buildCodexDailyByProject({
      projectRoots,
      knownProjects,
      fromTs,
      toTs,
    }).catch((error) => {
      console.warn('[usageByProjectSync] codex failed', error);
      return { rows: [], filesScanned: 0, linesParsed: 0 };
    }),
  ]);

  const apply = db.transaction(() => {
    for (const row of claude.rows) {
      upsertRow(db, row as DailyProjectAggregate, nowSec);
    }
    for (const row of codex.rows) {
      upsertRow(db, row as DailyProjectAggregate, nowSec);
    }
  });
  apply();

  return {
    claudeRows: claude.rows.length,
    codexRows: codex.rows.length,
    filesScanned: claude.filesScanned + codex.filesScanned,
    linesParsed: claude.linesParsed + codex.linesParsed,
    durationMs: Math.round(performance.now() - started),
  };
}
