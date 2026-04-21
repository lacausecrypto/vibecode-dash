import type { Database } from 'bun:sqlite';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Settings } from '../config';
import {
  __internal,
  addManualCompetitor,
  deleteCompetitor,
  listCompetitorsByProject,
  listInsights,
  promoteInsightToVault,
  updateInsightStatus,
} from '../lib/radar';

let originalCwd: string;
let tmpDir: string;

beforeAll(() => {
  originalCwd = process.cwd();
  tmpDir = mkdtempSync(join(tmpdir(), 'vibecode-dash-radar-'));
  mkdirSync(join(tmpDir, 'data'), { recursive: true });
  process.chdir(tmpDir);
});

afterAll(() => {
  process.chdir(originalCwd);
  rmSync(tmpDir, { recursive: true, force: true });
});

async function bootDb(): Promise<Database> {
  const { runMigrations, getDb, closeDb } = await import(`../db?cache=${Date.now()}`);
  closeDb?.();
  await runMigrations();
  return getDb();
}

function seedProject(db: Database, id = 'proj-1'): string {
  const now = Math.floor(Date.now() / 1000);
  db.query(
    `INSERT INTO projects
       (id, path, name, type, description, readme_path, last_modified, scanned_at, git_branch, uncommitted, health_score, loc, languages_json)
     VALUES (?, ?, ?, 'app', ?, NULL, ?, ?, NULL, 0, 50, 100, '{}')`,
  ).run(id, `/tmp/fake-project-${id}`, 'fake-project', 'desc', now, now);
  return id;
}

describe('radar — pure parsing', () => {
  test('parseJsonFromCliText handles fenced JSON', () => {
    const text = 'some preamble\n```json\n[{"name":"foo"}]\n```';
    expect(__internal.parseJsonFromCliText(text)).toEqual([{ name: 'foo' }]);
  });

  test('parseJsonFromCliText handles bare array', () => {
    expect(__internal.parseJsonFromCliText('[{"a":1}]')).toEqual([{ a: 1 }]);
  });

  test('parseJsonFromCliText throws on missing bracket', () => {
    expect(() => __internal.parseJsonFromCliText('no json here')).toThrow();
  });

  test('sanitizeCompetitor accepts minimum shape', () => {
    const result = __internal.sanitizeCompetitor({ name: '  Acme  ', url: 'https://a.co' });
    expect(result?.name).toBe('Acme');
    expect(result?.url).toBe('https://a.co');
    expect(result?.strengths).toEqual([]);
  });

  test('sanitizeCompetitor rejects missing name', () => {
    expect(__internal.sanitizeCompetitor({ url: 'x' })).toBeNull();
  });

  test('sanitizeCompetitor clips features to 12 items', () => {
    const features = Array.from({ length: 30 }, (_, i) => `f${i}`);
    const result = __internal.sanitizeCompetitor({ name: 'x', features });
    expect(result?.features.length).toBe(12);
  });

  test('sanitizeInsight rejects unknown type', () => {
    expect(__internal.sanitizeInsight({ type: 'random', title: 'x', body: 'x' })).toBeNull();
  });

  test('sanitizeInsight accepts the three valid types', () => {
    for (const type of ['market_gap', 'overlap', 'vault_echo'] as const) {
      const result = __internal.sanitizeInsight({
        type,
        title: 'Title',
        body: 'Body here',
        related_notes: ['Concepts/x.md'],
        related_competitors: ['ZRival'],
      });
      expect(result?.type).toBe(type);
    }
  });
});

describe('radar — DB round-trip', () => {
  test('addManualCompetitor → listCompetitorsByProject → deleteCompetitor', async () => {
    const db = await bootDb();
    const projectId = seedProject(db, 'proj-manual');

    const row = addManualCompetitor(db, projectId, {
      name: 'Obsidian',
      url: 'https://obsidian.md',
      pitch: 'local-first knowledge base',
    });

    expect(row.name).toBe('Obsidian');
    expect(row.source).toBe('manual');

    const listed = listCompetitorsByProject(db, projectId);
    expect(listed.length).toBe(1);

    const deleted = deleteCompetitor(db, row.id);
    expect(deleted).toBe(true);
    expect(listCompetitorsByProject(db, projectId).length).toBe(0);
  });

  test('addManualCompetitor is idempotent on name conflict (case-insensitive)', async () => {
    const db = await bootDb();
    const projectId = seedProject(db, 'proj-idem');

    addManualCompetitor(db, projectId, { name: 'Notion' });
    addManualCompetitor(db, projectId, { name: 'notion', url: 'https://notion.so' });

    const listed = listCompetitorsByProject(db, projectId);
    expect(listed.length).toBe(1);
    expect(listed[0].url).toBe('https://notion.so');
  });

  test('scan upsert preserves source=manual row unchanged', async () => {
    const db = await bootDb();
    const projectId = seedProject(db, 'proj-preserve');

    // Seed a manual row with custom strengths.
    addManualCompetitor(db, projectId, {
      name: 'Notion',
      url: 'https://notion.so',
      pitch: 'hand-curated pitch',
    });
    db.query<unknown, [string, string, string]>(
      'UPDATE competitors SET strengths_json = ? WHERE project_id = ? AND LOWER(name) = LOWER(?)',
    ).run(JSON.stringify(['fast search']), projectId, 'Notion');

    // Simulate an agent upsert that would normally overwrite.
    const now = Math.floor(Date.now() / 1000);
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
    upsert.run(
      crypto.randomUUID(),
      projectId,
      'notion',
      'https://overwritten.example',
      'AGENT PITCH',
      JSON.stringify(['different']),
      '[]',
      '[]',
      now,
      now,
    );

    const rows = listCompetitorsByProject(db, projectId);
    expect(rows.length).toBe(1);
    expect(rows[0].source).toBe('manual');
    expect(rows[0].pitch).toBe('hand-curated pitch');
    expect(rows[0].url).toBe('https://notion.so');
    expect(JSON.parse(rows[0].strengths_json || '[]')).toEqual(['fast search']);
  });

  test('listInsights filters by status and project', async () => {
    const db = await bootDb();
    const projectId = seedProject(db, 'proj-ins');

    const now = Math.floor(Date.now() / 1000);
    db.query(
      `INSERT INTO insights (id, type, title, body, related_projects_json, related_notes_json, meta_json, created_at, status)
       VALUES (?, 'market_gap', 'Pending A', 'body', ?, '[]', '{}', ?, 'pending')`,
    ).run('ins-1', JSON.stringify([projectId]), now);

    db.query(
      `INSERT INTO insights (id, type, title, body, related_projects_json, related_notes_json, meta_json, created_at, status, explored_at)
       VALUES (?, 'overlap', 'Explored B', 'body', ?, '[]', '{}', ?, 'explored', ?)`,
    ).run('ins-2', JSON.stringify([projectId]), now, now);

    expect(listInsights(db, { projectId, status: 'pending' }).length).toBe(1);
    expect(listInsights(db, { projectId, status: 'explored' }).length).toBe(1);
    expect(listInsights(db, { projectId, status: 'dismissed' }).length).toBe(0);

    updateInsightStatus(db, 'ins-1', 'dismissed');
    expect(listInsights(db, { projectId, status: 'pending' }).length).toBe(0);
    expect(listInsights(db, { projectId, status: 'dismissed' }).length).toBe(1);
  });

  test('promoteInsightToVault writes Concepts/radar/<slug>.md and flips to explored', async () => {
    const db = await bootDb();
    const projectId = seedProject(db, 'proj-promote');
    const vaultRoot = join(tmpDir, 'vault');
    mkdirSync(vaultRoot, { recursive: true });

    const now = Math.floor(Date.now() / 1000);
    db.query(
      `INSERT INTO insights (id, type, title, body, related_projects_json, related_notes_json, meta_json, created_at, status)
       VALUES (?, 'market_gap', 'Missing real-time sync', 'Body text', ?, ?, ?, ?, 'pending')`,
    ).run(
      'ins-prom',
      JSON.stringify([projectId]),
      JSON.stringify(['Concepts/sync.md']),
      JSON.stringify({ related_competitors: ['Obsidian', 'Notion'] }),
      now,
    );

    const settings: Settings = {
      paths: {
        projectsRoots: ['/tmp'],
        vaultPath: vaultRoot,
        claudeConfigDir: '/tmp',
      },
      filters: { allowAgentExec: true },
    } as unknown as Settings;

    const res = await promoteInsightToVault('ins-prom', { db, settings });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const abs = res.abs;
    expect(abs.startsWith(vaultRoot)).toBe(true);
    expect(existsSync(abs)).toBe(true);
    const content = readFileSync(abs, 'utf8');
    expect(content).toContain('type: concept');
    expect(content).toContain('source: radar-insight');
    expect(content).toContain('insight_id: ins-prom');
    expect(content).toContain('# Missing real-time sync');
    expect(content).toContain('Body text');
    expect(content).toContain('[[Concepts/sync.md]]');
    expect(content).toContain('Obsidian');

    const row = db
      .query<{ status: string }, [string]>('SELECT status FROM insights WHERE id = ?')
      .get('ins-prom');
    expect(row?.status).toBe('explored');
  });

  test('promoteInsightToVault dedupes by filename (-2 suffix)', async () => {
    const db = await bootDb();
    const projectId = seedProject(db, 'proj-dedup');
    const vaultRoot = join(tmpDir, 'vault-dedup');
    mkdirSync(vaultRoot, { recursive: true });

    const now = Math.floor(Date.now() / 1000);
    for (const id of ['a', 'b']) {
      db.query(
        `INSERT INTO insights (id, type, title, body, related_projects_json, related_notes_json, meta_json, created_at, status)
         VALUES (?, 'overlap', 'Same title', 'body', ?, '[]', '{}', ?, 'pending')`,
      ).run(`ins-dup-${id}`, JSON.stringify([projectId]), now);
    }

    const settings = {
      paths: { projectsRoots: ['/tmp'], vaultPath: vaultRoot, claudeConfigDir: '/tmp' },
      filters: { allowAgentExec: true },
    } as unknown as Settings;

    const r1 = await promoteInsightToVault('ins-dup-a', { db, settings });
    const r2 = await promoteInsightToVault('ins-dup-b', { db, settings });
    expect(r1.ok && r2.ok).toBe(true);
    if (r1.ok && r2.ok) {
      expect(r1.path).not.toBe(r2.path);
      expect(r2.path).toMatch(/-2\.md$/);
    }
  });
});
