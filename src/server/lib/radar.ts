import type { Database } from 'bun:sqlite';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { type Settings, expandHomePath, loadSettings } from '../config';
import { getDb } from '../db';
import { type AgentExecResult, execAgentCli } from '../wrappers/agentCli';

export type CompetitorRow = {
  id: string;
  project_id: string;
  name: string;
  url: string | null;
  pitch: string | null;
  strengths_json: string | null;
  weaknesses_json: string | null;
  features_json: string | null;
  last_seen: number;
  discovered_at: number;
  source: string;
};

export type InsightRow = {
  id: string;
  type: string;
  title: string;
  body: string | null;
  related_projects_json: string | null;
  related_notes_json: string | null;
  meta_json: string | null;
  created_at: number;
  status: string | null;
  explored_at: number | null;
};

export type InsightType = 'market_gap' | 'overlap' | 'vault_echo';
export const INSIGHT_TYPES: readonly InsightType[] = ['market_gap', 'overlap', 'vault_echo'];

type ProjectRow = {
  id: string;
  path: string;
  name: string;
  type: string | null;
  description: string | null;
  readme_path: string | null;
  languages_json: string | null;
};

type ScannedCompetitor = {
  name: string;
  url: string | null;
  pitch: string | null;
  strengths: string[];
  weaknesses: string[];
  features: string[];
};

type GeneratedInsight = {
  type: InsightType;
  title: string;
  body: string;
  related_notes: string[];
  related_competitors: string[];
};

export type RadarAgentRun = {
  ok: boolean;
  exitCode: number;
  durationMs: number;
  model: string | null;
  costUsd: number | null;
  usage: AgentExecResult['usage'];
};

const MAX_README_CHARS = 8_000;
const MAX_COMPETITORS_PER_SCAN = 8;
const MAX_INSIGHTS_PER_RUN = 6;
const DEFAULT_SCAN_TIMEOUT_MS = 240_000;

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function projectById(db: Database, id: string): ProjectRow | null {
  return (
    (db
      .query(
        'SELECT id, path, name, type, description, readme_path, languages_json FROM projects WHERE id = ?',
      )
      .get(id) as ProjectRow | null) ?? null
  );
}

async function readProjectReadme(project: ProjectRow): Promise<string | null> {
  if (!project.readme_path) return null;
  try {
    const raw = await readFile(project.readme_path, 'utf8');
    if (raw.length <= MAX_README_CHARS) return raw;
    return `${raw.slice(0, MAX_README_CHARS)}\n\n… [truncated]`;
  } catch {
    return null;
  }
}

type VaultConcept = { path: string; title: string; snippet: string };

function relatedConcepts(db: Database, project: ProjectRow, limit = 6): VaultConcept[] {
  const slug = project.name
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .trim();
  if (!slug) return [];

  const rows = db
    .query<{ path: string; title: string; snippet: string | null }, [string, string, number]>(
      `SELECT n.path, n.title,
         (SELECT snippet(obsidian_notes_fts, 2, '', '', '…', 18) FROM obsidian_notes_fts f WHERE f.path = n.path) AS snippet
       FROM obsidian_notes n
       WHERE json_extract(n.frontmatter_json, '$.type') IN ('concept', 'project')
         AND (n.path LIKE ? OR n.title LIKE ?)
       LIMIT ?`,
    )
    .all(`%${project.name}%`, `%${project.name}%`, limit);

  return rows.map((r) => ({ path: r.path, title: r.title, snippet: r.snippet || '' }));
}

function parseJsonFromCliText(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  const trimmed = (candidate || '').trim();

  const firstBracket = trimmed.search(/[[{]/);
  if (firstBracket < 0) throw new Error('no_json_found');

  const slice = trimmed.slice(firstBracket);
  return JSON.parse(slice);
}

function sanitizeStringArray(value: unknown, maxItems = 8): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
    .slice(0, maxItems)
    .map((v) => v.trim().slice(0, 280));
}

function sanitizeCompetitor(raw: unknown): ScannedCompetitor | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const name = typeof r.name === 'string' ? r.name.trim() : '';
  if (!name) return null;

  const url = typeof r.url === 'string' ? r.url.trim().slice(0, 500) : null;
  const pitch = typeof r.pitch === 'string' ? r.pitch.trim().slice(0, 500) : null;

  return {
    name: name.slice(0, 120),
    url: url || null,
    pitch: pitch || null,
    strengths: sanitizeStringArray(r.strengths),
    weaknesses: sanitizeStringArray(r.weaknesses),
    features: sanitizeStringArray(r.features, 12),
  };
}

function sanitizeInsight(raw: unknown): GeneratedInsight | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const type = typeof r.type === 'string' ? r.type.toLowerCase().trim() : '';
  if (!INSIGHT_TYPES.includes(type as InsightType)) return null;

  const title = typeof r.title === 'string' ? r.title.trim().slice(0, 200) : '';
  const body = typeof r.body === 'string' ? r.body.trim().slice(0, 2_000) : '';
  if (!title || !body) return null;

  return {
    type: type as InsightType,
    title,
    body,
    related_notes: sanitizeStringArray(r.related_notes),
    related_competitors: sanitizeStringArray(r.related_competitors),
  };
}

function buildScanPrompt(
  project: ProjectRow,
  readme: string | null,
  concepts: VaultConcept[],
): string {
  const languages = project.languages_json
    ? (JSON.parse(project.languages_json) as Record<string, number>)
    : {};
  const langLine = Object.entries(languages)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([k]) => k)
    .join(', ');

  return [
    `Project: ${project.name}`,
    project.type ? `Type: ${project.type}` : null,
    project.description ? `Description: ${project.description}` : null,
    langLine ? `Stack: ${langLine}` : null,
    '',
    readme ? `## README (truncated)\n${readme}` : null,
    concepts.length > 0
      ? `## Related vault concepts\n${concepts.map((c) => `- [[${c.path}]] · ${c.title}`).join('\n')}`
      : null,
    '',
    '---',
    `Your task: find up to ${MAX_COMPETITORS_PER_SCAN} direct competitors or alternatives to this project. Use WebSearch + WebFetch sparingly (1–3 searches max). Prioritise OSS / indie / local-first alternatives when the project has that bias.`,
    '',
    'Respond with JSON ONLY — no prose, no preamble. An array of competitor objects:',
    '[',
    '  { "name": string, "url": string|null, "pitch": string (one-liner, max 240 chars),',
    '    "strengths": string[] (max 6), "weaknesses": string[] (max 6), "features": string[] (max 10) }',
    ']',
    '',
    'If you cannot find credible competitors, return [].',
  ]
    .filter(Boolean)
    .join('\n');
}

function buildInsightsPrompt(
  project: ProjectRow,
  readme: string | null,
  competitors: CompetitorRow[],
  concepts: VaultConcept[],
): string {
  const compLines = competitors
    .map(
      (c) =>
        `- ${c.name}${c.url ? ` (${c.url})` : ''} · features: ${(
          JSON.parse(c.features_json || '[]') as string[]
        )
          .slice(0, 6)
          .join(', ')}`,
    )
    .join('\n');

  return [
    `Project: ${project.name}`,
    project.description ? `Description: ${project.description}` : null,
    '',
    readme ? `## Project README (truncated)\n${readme}` : null,
    '',
    '## Known competitors',
    compLines || '(aucun — pas encore scanné)',
    '',
    concepts.length > 0
      ? `## Related vault concepts\n${concepts
          .map((c) => `- [[${c.path}]] · ${c.title}${c.snippet ? ` — ${c.snippet}` : ''}`)
          .join('\n')}`
      : null,
    '',
    '---',
    `Your task: produce up to ${MAX_INSIGHTS_PER_RUN} actionable insights. Each insight has one of three types:`,
    '- "market_gap": a feature/angle that competitors have but the project lacks (or vice-versa, an untapped angle).',
    '- "overlap": an area where the project redundantly competes with a stronger incumbent — suggest differentiation.',
    '- "vault_echo": a vault concept ([[note]]) that could directly reinforce the project\'s positioning or roadmap.',
    '',
    'Rules:',
    '- Be concrete and specific. No bland advice.',
    "- If you don't have enough signal, emit fewer insights — don't fabricate.",
    '- Cite vault notes by their exact path in `related_notes`.',
    '- Cite competitor names in `related_competitors`.',
    '',
    'Respond with JSON ONLY — array of insight objects:',
    '[',
    '  { "type": "market_gap"|"overlap"|"vault_echo",',
    '    "title": string (max 120 chars, punchy),',
    '    "body": string (2–5 sentences, concrete),',
    '    "related_notes": string[] (vault paths),',
    '    "related_competitors": string[] (competitor names) }',
    ']',
  ]
    .filter(Boolean)
    .join('\n');
}

export async function scanCompetitors(
  projectId: string,
  opts: { db?: Database; settings?: Settings; timeoutMs?: number } = {},
): Promise<{
  run: RadarAgentRun;
  written: number;
  competitors: CompetitorRow[];
  stderr?: string;
}> {
  const db = opts.db ?? getDb();
  const settings = opts.settings ?? (await loadSettings());
  const project = projectById(db, projectId);
  if (!project) throw new Error('project_not_found');

  const readme = await readProjectReadme(project);
  const concepts = relatedConcepts(db, project);
  const prompt = buildScanPrompt(project, readme, concepts);

  const cwd = expandHomePath(project.path);

  const result = await execAgentCli({
    provider: 'claude',
    prompt,
    cwd,
    toolPolicy: 'read-only',
    timeoutMs: opts.timeoutMs ?? DEFAULT_SCAN_TIMEOUT_MS,
  });

  const run: RadarAgentRun = {
    ok: result.ok,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    model: result.model,
    costUsd: result.costUsd,
    usage: result.usage,
  };

  if (!result.ok) {
    return { run, written: 0, competitors: [], stderr: result.stderr };
  }

  let parsed: unknown;
  try {
    parsed = parseJsonFromCliText(result.text);
  } catch {
    return { run, written: 0, competitors: [], stderr: 'invalid_json' };
  }

  const raw = Array.isArray(parsed) ? parsed : [];
  const clean = raw
    .map(sanitizeCompetitor)
    .filter((c): c is ScannedCompetitor => c !== null)
    .slice(0, MAX_COMPETITORS_PER_SCAN);

  // Scan NEVER overwrites manual entries. If the user curated a competitor,
  // the agent can only add siblings or refresh its own rows. The `WHERE
  // competitors.source != 'manual'` below is the integrity anchor: SQLite
  // treats a falsy WHERE on ON CONFLICT DO UPDATE as "no-op, conflict
  // resolved" — no error, no change.
  const upsert = db.query<
    unknown,
    [string, string, string, string | null, string | null, string, string, string, number, number]
  >(
    `INSERT INTO competitors
       (id, project_id, name, url, pitch, strengths_json, weaknesses_json, features_json, last_seen, discovered_at, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'agent')
     ON CONFLICT(project_id, LOWER(name)) DO UPDATE SET
       url = excluded.url,
       pitch = excluded.pitch,
       strengths_json = excluded.strengths_json,
       weaknesses_json = excluded.weaknesses_json,
       features_json = excluded.features_json,
       last_seen = excluded.last_seen
     WHERE competitors.source != 'manual'`,
  );

  const now = nowSec();
  const tx = db.transaction(() => {
    for (const c of clean) {
      upsert.run(
        crypto.randomUUID(),
        projectId,
        c.name,
        c.url,
        c.pitch,
        JSON.stringify(c.strengths),
        JSON.stringify(c.weaknesses),
        JSON.stringify(c.features),
        now,
        now,
      );
    }
  });
  tx();

  const competitors = db
    .query<CompetitorRow, [string]>(
      'SELECT * FROM competitors WHERE project_id = ? ORDER BY last_seen DESC, name ASC',
    )
    .all(projectId);

  void settings;
  return { run, written: clean.length, competitors };
}

export async function generateInsights(
  projectId: string,
  opts: { db?: Database; timeoutMs?: number } = {},
): Promise<{ run: RadarAgentRun; written: number; insights: InsightRow[]; stderr?: string }> {
  const db = opts.db ?? getDb();
  const project = projectById(db, projectId);
  if (!project) throw new Error('project_not_found');

  const competitors = db
    .query<CompetitorRow, [string]>(
      'SELECT * FROM competitors WHERE project_id = ? ORDER BY last_seen DESC',
    )
    .all(projectId);

  const readme = await readProjectReadme(project);
  const concepts = relatedConcepts(db, project, 10);
  const prompt = buildInsightsPrompt(project, readme, competitors, concepts);

  const result = await execAgentCli({
    provider: 'claude',
    prompt,
    cwd: expandHomePath(project.path),
    toolPolicy: 'none',
    timeoutMs: opts.timeoutMs ?? DEFAULT_SCAN_TIMEOUT_MS,
  });

  const run: RadarAgentRun = {
    ok: result.ok,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    model: result.model,
    costUsd: result.costUsd,
    usage: result.usage,
  };

  if (!result.ok) {
    return { run, written: 0, insights: [], stderr: result.stderr };
  }

  let parsed: unknown;
  try {
    parsed = parseJsonFromCliText(result.text);
  } catch {
    return { run, written: 0, insights: [], stderr: 'invalid_json' };
  }

  const raw = Array.isArray(parsed) ? parsed : [];
  const clean = raw
    .map(sanitizeInsight)
    .filter((i): i is GeneratedInsight => i !== null)
    .slice(0, MAX_INSIGHTS_PER_RUN);

  const insert = db.query<
    unknown,
    [string, string, string, string, string, string, string, number]
  >(
    `INSERT INTO insights
       (id, type, title, body, related_projects_json, related_notes_json, meta_json, created_at, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
  );

  const now = nowSec();
  const tx = db.transaction(() => {
    for (const i of clean) {
      insert.run(
        crypto.randomUUID(),
        i.type,
        i.title,
        i.body,
        JSON.stringify([projectId]),
        JSON.stringify(i.related_notes),
        JSON.stringify({ related_competitors: i.related_competitors }),
        now,
      );
    }
  });
  tx();

  const insights = db
    .query<InsightRow, [string]>(
      `SELECT * FROM insights
       WHERE json_extract(related_projects_json, '$[0]') = ?
       ORDER BY created_at DESC
       LIMIT 50`,
    )
    .all(projectId);

  return { run, written: clean.length, insights };
}

export type RadarSummaryRow = {
  project_id: string;
  project_name: string;
  competitors: number;
  competitors_manual: number;
  competitors_agent: number;
  insights_pending: number;
  insights_explored: number;
  insights_dismissed: number;
  insights_market_gap: number;
  insights_overlap: number;
  insights_vault_echo: number;
  last_seen: number | null;
};

/**
 * Bird's-eye view of the radar: one row per project that has at least one
 * competitor OR insight. Used by the global (no-projectId) radar view so the
 * user lands on something actionable instead of a cross-project empty feed.
 */
export function getRadarSummary(db: Database): RadarSummaryRow[] {
  return db
    .query<RadarSummaryRow, []>(
      `SELECT
         p.id   AS project_id,
         p.name AS project_name,
         COALESCE(c.count, 0)         AS competitors,
         COALESCE(c.manual_count, 0)  AS competitors_manual,
         COALESCE(c.agent_count, 0)   AS competitors_agent,
         COALESCE(i.pending, 0)       AS insights_pending,
         COALESCE(i.explored, 0)      AS insights_explored,
         COALESCE(i.dismissed, 0)     AS insights_dismissed,
         COALESCE(i.market_gap, 0)    AS insights_market_gap,
         COALESCE(i.overlap, 0)       AS insights_overlap,
         COALESCE(i.vault_echo, 0)    AS insights_vault_echo,
         c.last_seen                  AS last_seen
       FROM projects p
       LEFT JOIN (
         SELECT project_id,
                COUNT(*) AS count,
                SUM(CASE WHEN source = 'manual' THEN 1 ELSE 0 END) AS manual_count,
                SUM(CASE WHEN source = 'agent'  THEN 1 ELSE 0 END) AS agent_count,
                MAX(last_seen) AS last_seen
         FROM competitors
         GROUP BY project_id
       ) c ON c.project_id = p.id
       LEFT JOIN (
         SELECT json_extract(related_projects_json, '$[0]') AS pid,
                SUM(CASE WHEN status = 'pending'   THEN 1 ELSE 0 END) AS pending,
                SUM(CASE WHEN status = 'explored'  THEN 1 ELSE 0 END) AS explored,
                SUM(CASE WHEN status = 'dismissed' THEN 1 ELSE 0 END) AS dismissed,
                SUM(CASE WHEN type = 'market_gap'  AND status = 'pending' THEN 1 ELSE 0 END) AS market_gap,
                SUM(CASE WHEN type = 'overlap'     AND status = 'pending' THEN 1 ELSE 0 END) AS overlap,
                SUM(CASE WHEN type = 'vault_echo'  AND status = 'pending' THEN 1 ELSE 0 END) AS vault_echo
         FROM insights
         WHERE pid IS NOT NULL
         GROUP BY pid
       ) i ON i.pid = p.id
       WHERE c.count IS NOT NULL OR i.pending IS NOT NULL OR i.explored IS NOT NULL OR i.dismissed IS NOT NULL
       ORDER BY insights_pending DESC, competitors DESC, p.name ASC`,
    )
    .all();
}

export function listCompetitorsByProject(db: Database, projectId: string): CompetitorRow[] {
  return db
    .query<CompetitorRow, [string]>(
      'SELECT * FROM competitors WHERE project_id = ? ORDER BY last_seen DESC, name ASC',
    )
    .all(projectId);
}

export function addManualCompetitor(
  db: Database,
  projectId: string,
  input: { name: string; url?: string | null; pitch?: string | null },
): CompetitorRow {
  const now = nowSec();
  const id = crypto.randomUUID();
  db.query(
    `INSERT INTO competitors
       (id, project_id, name, url, pitch, strengths_json, weaknesses_json, features_json, last_seen, discovered_at, source)
     VALUES (?, ?, ?, ?, ?, '[]', '[]', '[]', ?, ?, 'manual')
     ON CONFLICT(project_id, LOWER(name)) DO UPDATE SET
       url = COALESCE(excluded.url, competitors.url),
       pitch = COALESCE(excluded.pitch, competitors.pitch),
       last_seen = excluded.last_seen`,
  ).run(id, projectId, input.name.trim(), input.url || null, input.pitch || null, now, now);

  return db
    .query<CompetitorRow, [string, string]>(
      'SELECT * FROM competitors WHERE project_id = ? AND LOWER(name) = LOWER(?)',
    )
    .get(projectId, input.name.trim()) as CompetitorRow;
}

export function updateManualCompetitor(
  db: Database,
  id: string,
  patch: { name?: string; url?: string | null; pitch?: string | null },
): CompetitorRow | null {
  const current = db
    .query<CompetitorRow, [string]>('SELECT * FROM competitors WHERE id = ?')
    .get(id);
  if (!current) return null;
  // Only manual competitors are user-editable: scanned ones get overwritten by
  // the next scan anyway, and letting the user rewrite their name would desync
  // the `project_id + LOWER(name)` uniqueness invariant in non-obvious ways.
  if (current.source !== 'manual') return null;

  const next = {
    name: patch.name?.trim() || current.name,
    url: patch.url === undefined ? current.url : patch.url,
    pitch: patch.pitch === undefined ? current.pitch : patch.pitch,
  };

  // Guard: if the rename would collide with another competitor in the same
  // project, reject — client should display an error.
  if (next.name.toLowerCase() !== current.name.toLowerCase()) {
    const conflict = db
      .query<{ id: string }, [string, string, string]>(
        'SELECT id FROM competitors WHERE project_id = ? AND LOWER(name) = LOWER(?) AND id != ?',
      )
      .get(current.project_id, next.name, id);
    if (conflict) return null;
  }

  db.query<unknown, [string, string | null, string | null, number, string]>(
    `UPDATE competitors
     SET name = ?, url = ?, pitch = ?, last_seen = ?
     WHERE id = ?`,
  ).run(next.name, next.url, next.pitch, nowSec(), id);

  return db.query<CompetitorRow, [string]>('SELECT * FROM competitors WHERE id = ?').get(id);
}

export function deleteCompetitor(db: Database, id: string): boolean {
  // Fetch before delete: we need the name + project_id to scrub stale references
  // in insights.meta_json.related_competitors (names, not FKs, so SQLite can't
  // cascade them for us).
  const comp = db
    .query<{ name: string; project_id: string }, [string]>(
      'SELECT name, project_id FROM competitors WHERE id = ?',
    )
    .get(id);
  if (!comp) return false;

  const res = db.query<unknown, [string]>('DELETE FROM competitors WHERE id = ?').run(id);
  if (res.changes === 0) return false;

  const target = comp.name.trim().toLowerCase();
  const stale = db
    .query<{ id: string; meta_json: string | null }, [string, string]>(
      `SELECT id, meta_json FROM insights
       WHERE meta_json LIKE ?
         AND json_extract(related_projects_json, '$[0]') = ?`,
    )
    .all(`%${comp.name}%`, comp.project_id);

  for (const row of stale) {
    if (!row.meta_json) continue;
    try {
      const parsed = JSON.parse(row.meta_json) as Record<string, unknown>;
      const refs = parsed.related_competitors;
      if (!Array.isArray(refs)) continue;
      const filtered = refs.filter(
        (n) => typeof n === 'string' && n.trim().toLowerCase() !== target,
      );
      if (filtered.length !== refs.length) {
        parsed.related_competitors = filtered;
        db.query<unknown, [string, string]>('UPDATE insights SET meta_json = ? WHERE id = ?').run(
          JSON.stringify(parsed),
          row.id,
        );
      }
    } catch {
      // Malformed meta_json — leave it alone rather than trash the whole row.
    }
  }
  return true;
}

export function listInsights(
  db: Database,
  filter: { projectId?: string; status?: string; limit?: number } = {},
): InsightRow[] {
  const status = filter.status ?? 'pending';
  const limit = Math.min(filter.limit ?? 100, 500);

  if (filter.projectId) {
    return db
      .query<InsightRow, [string, string, number]>(
        `SELECT * FROM insights
         WHERE status = ?
           AND json_extract(related_projects_json, '$[0]') = ?
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(status, filter.projectId, limit);
  }

  return db
    .query<InsightRow, [string, number]>(
      'SELECT * FROM insights WHERE status = ? ORDER BY created_at DESC LIMIT ?',
    )
    .all(status, limit);
}

function insightSlug(title: string): string {
  const base = title
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
  return base || 'insight';
}

// Must match the slug used by memoryVaultSync / vaultHubs so wikilinks
// resolve against the on-disk `Projects/<slug>.md` stub.
function projectSlug(name: string): string {
  return (
    name
      .toLowerCase()
      .normalize('NFD')
      .replace(/\p{Diacritic}/gu, '')
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 60) || 'project'
  );
}

async function resolveUniquePath(baseAbs: string): Promise<string> {
  try {
    await stat(baseAbs);
  } catch {
    return baseAbs;
  }
  const ext = baseAbs.endsWith('.md') ? '.md' : '';
  const stem = ext ? baseAbs.slice(0, -3) : baseAbs;
  for (let i = 2; i < 50; i += 1) {
    const candidate = `${stem}-${i}${ext}`;
    try {
      await stat(candidate);
    } catch {
      return candidate;
    }
  }
  return `${stem}-${Date.now()}${ext}`;
}

/**
 * Promote an insight to a Concepts/<slug>.md note in the vault.
 * Rules:
 * - Writes under `Concepts/radar/<slug>.md` to keep auto-promoted notes grouped.
 * - Frontmatter tracks the source (radar-insight, original type, project).
 * - Body carries the insight's body plus backlinks to related notes + competitors.
 * - Idempotent filename: collisions append `-2`, `-3`, …
 * - Also flips the insight's status to `explored` and stamps explored_at.
 */
export async function promoteInsightToVault(
  insightId: string,
  opts: { db?: Database; settings?: Settings } = {},
): Promise<{ ok: true; path: string; abs: string } | { ok: false; reason: string }> {
  const db = opts.db ?? getDb();
  const settings = opts.settings ?? (await loadSettings());
  const vaultRoot = expandHomePath(settings.paths.vaultPath);

  const insight = db
    .query<InsightRow, [string]>('SELECT * FROM insights WHERE id = ?')
    .get(insightId);
  if (!insight) return { ok: false, reason: 'insight_not_found' };

  const projectIds = insight.related_projects_json
    ? (JSON.parse(insight.related_projects_json) as string[])
    : [];
  const projectId = projectIds[0];
  const project = projectId
    ? (db
        .query<{ id: string; name: string }, [string]>('SELECT id, name FROM projects WHERE id = ?')
        .get(projectId) ?? null)
    : null;

  const relatedNotes = insight.related_notes_json
    ? (JSON.parse(insight.related_notes_json) as string[])
    : [];
  const relatedCompetitors =
    insight.meta_json && typeof insight.meta_json === 'string'
      ? (() => {
          try {
            const parsed = JSON.parse(insight.meta_json || '{}');
            return Array.isArray(parsed?.related_competitors)
              ? (parsed.related_competitors as string[])
              : [];
          } catch {
            return [];
          }
        })()
      : [];

  const slug = insightSlug(insight.title);
  const relPath = `Concepts/radar/${slug}.md`;
  const abs = join(vaultRoot, relPath);
  const finalAbs = await resolveUniquePath(abs);
  const finalRel = finalAbs.slice(vaultRoot.length + 1);

  const today = new Date().toISOString().slice(0, 10);
  const tags = ['concept', 'radar', insight.type];
  if (project) tags.push(`project/${projectSlug(project.name)}`);
  const frontmatter = [
    '---',
    'type: concept',
    'status: evergreen',
    'source: radar-insight',
    `insight_id: ${insight.id}`,
    `insight_type: ${insight.type}`,
    project ? `project: "[[Projects/${projectSlug(project.name)}]]"` : null,
    `promoted_at: ${today}`,
    'collab_reviewed: false',
    `tags: [${tags.map((t) => JSON.stringify(t)).join(', ')}]`,
    '---',
  ]
    .filter(Boolean)
    .join('\n');

  const body: string[] = ['', `# ${insight.title}`, '', insight.body || '', ''];
  if (relatedNotes.length > 0) {
    body.push('## Notes liées');
    for (const n of relatedNotes) body.push(`- [[${n}]]`);
    body.push('');
  }
  if (relatedCompetitors.length > 0) {
    body.push('## Concurrents cités');
    for (const c of relatedCompetitors) body.push(`- ${c}`);
    body.push('');
  }
  if (project) {
    body.push(`## Projet source\n- [[Projects/${projectSlug(project.name)}]]\n`);
  }

  await mkdir(dirname(finalAbs), { recursive: true });
  await writeFile(finalAbs, `${frontmatter}\n${body.join('\n')}`, 'utf8');

  // Flip status to explored so the user doesn't see it twice.
  const now = Math.floor(Date.now() / 1000);
  db.query<unknown, [number, string]>(
    "UPDATE insights SET status = 'explored', explored_at = ? WHERE id = ?",
  ).run(now, insightId);

  return { ok: true, path: finalRel, abs: finalAbs };
}

export function updateInsightStatus(
  db: Database,
  id: string,
  status: 'pending' | 'explored' | 'dismissed',
): InsightRow | null {
  const now = nowSec();
  const exploredAt = status === 'explored' ? now : null;
  db.query<unknown, [string, number | null, string]>(
    'UPDATE insights SET status = ?, explored_at = ? WHERE id = ?',
  ).run(status, exploredAt, id);

  return (db.query('SELECT * FROM insights WHERE id = ?').get(id) as InsightRow | null) ?? null;
}

// Exposed for tests so we can hand a fake AgentExecResult without spawning a CLI.
export const __internal = {
  buildScanPrompt,
  buildInsightsPrompt,
  parseJsonFromCliText,
  sanitizeCompetitor,
  sanitizeInsight,
};
