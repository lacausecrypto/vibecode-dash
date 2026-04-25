import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { Hono } from 'hono';
import { z } from 'zod';
import { expandHomePath, loadSettings } from '../config';
import { getDb } from '../db';
import { bootstrapVault } from '../lib/vaultBootstrap';
import { rebuildVaultHubs } from '../lib/vaultHubs';
import { reindexObsidianVault, resolveVaultPath } from '../scanners/obsidianScanner';

const ReindexPayloadSchema = z.object({
  force: z.boolean().optional(),
});

const CapturePayloadSchema = z.object({
  content: z.string().min(1),
  daily: z.boolean().optional(),
  path: z.string().optional(),
});

function toFtsQuery(input: string): string {
  const tokens = input
    .trim()
    .split(/\s+/)
    .map((token) => token.replace(/[^\p{L}\p{N}_-]/gu, ''))
    .filter((token) => token.length > 0);

  if (tokens.length === 0) {
    return '';
  }

  return tokens.map((token) => `${token}*`).join(' AND ');
}

function todayDailyPath(): string {
  const now = new Date();
  const date = now.toISOString().slice(0, 10);
  return `Daily/${date}.md`;
}

export function registerObsidianRoutes(app: Hono): void {
  app.get('/api/obsidian/status', (c) => {
    const db = getDb();
    const kvRow = db
      .query<{ value: string }, [string]>('SELECT value FROM kv WHERE key = ?')
      .get('last_obsidian_index_at');
    const indexedAt = kvRow ? Number.parseInt(kvRow.value, 10) : null;
    const counts = db
      .query<{ notes: number; links: number }, []>(
        'SELECT (SELECT COUNT(*) FROM obsidian_notes) AS notes, (SELECT COUNT(*) FROM obsidian_links) AS links',
      )
      .get();
    return c.json({
      indexedAt: indexedAt && Number.isFinite(indexedAt) ? indexedAt : null,
      noteCount: counts?.notes ?? 0,
      linkCount: counts?.links ?? 0,
    });
  });

  app.get('/api/obsidian/notes', (c) => {
    const db = getDb();
    const limit = Math.min(Number.parseInt(c.req.query('limit') || '100', 10), 500);
    const offset = Math.max(Number.parseInt(c.req.query('offset') || '0', 10), 0);

    const rows = db
      .query(
        `SELECT
          n.path,
          n.title,
          n.modified,
          n.size,
          n.tags_json,
          n.indexed_at AS indexed_at,
          (SELECT COUNT(*) FROM obsidian_links l WHERE l.src = n.path) AS outgoing_count,
          (SELECT COUNT(*) FROM obsidian_links l WHERE l.dst = n.path) AS backlinks_count
         FROM obsidian_notes n
         ORDER BY n.modified DESC
         LIMIT ? OFFSET ?`,
      )
      .all(limit, offset);

    return c.json(rows);
  });

  app.get('/api/obsidian/notes/search', (c) => {
    const db = getDb();
    const q = c.req.query('q') || '';
    const limit = Math.min(Number.parseInt(c.req.query('limit') || '30', 10), 100);

    const ftsQuery = toFtsQuery(q);
    if (!ftsQuery) {
      return c.json([]);
    }

    try {
      const rows = db
        .query(
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

      return c.json(rows);
    } catch (error) {
      return c.json({ error: 'search_failed', details: String(error) }, 400);
    }
  });

  app.get('/api/obsidian/note', async (c) => {
    const db = getDb();
    const notePath = c.req.query('path');
    if (!notePath) {
      return c.json({ error: 'missing_path' }, 400);
    }

    const meta = db.query('SELECT * FROM obsidian_notes WHERE path = ?').get(notePath);
    if (!meta) {
      return c.json({ error: 'note_not_found' }, 404);
    }

    const outgoing = db
      .query('SELECT dst, display FROM obsidian_links WHERE src = ? ORDER BY dst')
      .all(notePath);

    const backlinks = db
      .query('SELECT src, display FROM obsidian_links WHERE dst = ? ORDER BY src')
      .all(notePath);

    const settings = await loadSettings();
    const vaultRoot = resolve(expandHomePath(settings.paths.vaultPath));

    let body = '';
    try {
      const abs = resolveVaultPath(vaultRoot, notePath);
      body = await readFile(abs, 'utf8');
    } catch {
      body = '';
    }

    return c.json({
      ...meta,
      body,
      outgoing,
      backlinks,
    });
  });

  app.get('/api/obsidian/graph', (c) => {
    const db = getDb();
    const maxNodes = Math.min(Number.parseInt(c.req.query('nodes') || '1200', 10), 3000);
    const maxEdges = Math.min(Number.parseInt(c.req.query('edges') || '5000', 10), 20000);

    const nodes = db
      .query(
        'SELECT path AS id, title, modified FROM obsidian_notes ORDER BY modified DESC LIMIT ?',
      )
      .all(maxNodes) as Array<{ id: string; title: string; modified: number }>;

    const nodeSet = new Set(nodes.map((node) => node.id));

    const allEdges = db
      .query('SELECT src, dst, display FROM obsidian_links ORDER BY src, dst LIMIT ?')
      .all(maxEdges) as Array<{ src: string; dst: string; display: string | null }>;

    const edges = allEdges.filter((edge) => nodeSet.has(edge.src) && nodeSet.has(edge.dst));

    return c.json({ nodes, edges });
  });

  app.get('/api/obsidian/tags', (c) => {
    const db = getDb();
    const rows = db.query('SELECT tags_json FROM obsidian_notes').all() as Array<{
      tags_json: string | null;
    }>;

    const counts = new Map<string, number>();
    for (const row of rows) {
      if (!row.tags_json) {
        continue;
      }

      try {
        const tags = JSON.parse(row.tags_json) as string[];
        for (const tag of tags) {
          counts.set(tag, (counts.get(tag) || 0) + 1);
        }
      } catch {
        // ignore malformed rows
      }
    }

    const sorted = [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([tag, count]) => ({ tag, count }));

    return c.json(sorted);
  });

  app.get('/api/obsidian/orphans', (c) => {
    const db = getDb();
    const limit = Math.min(Number.parseInt(c.req.query('limit') || '100', 10), 500);

    const rows = db
      .query(
        `SELECT
           n.path,
           n.title,
           n.modified,
           n.size,
           n.tags_json
         FROM obsidian_notes n
         LEFT JOIN obsidian_links l ON l.dst = n.path
         WHERE COALESCE(json_extract(n.frontmatter_json, '$.type'), '')
           NOT IN ('map', 'readme', 'persona', 'persona-memories', 'project-memories', 'daily', 'hub')
           AND n.path NOT LIKE 'Daily/%'
           AND n.path NOT LIKE '%/_index.md'
           AND n.path NOT LIKE '_index.md'
         GROUP BY n.path
         HAVING COUNT(l.src) = 0
         ORDER BY n.modified DESC
         LIMIT ?`,
      )
      .all(limit);

    return c.json(rows);
  });

  app.get('/api/obsidian/activity', (c) => {
    const db = getDb();
    const days = Math.min(Math.max(Number.parseInt(c.req.query('days') || '90', 10), 1), 730);
    const minTs = Math.floor(Date.now() / 1000) - days * 86400;

    const rows = db
      .query(
        `SELECT
           strftime('%Y-%m-%d', datetime(modified, 'unixepoch')) AS date,
           COUNT(*) AS notes
         FROM obsidian_notes
         WHERE modified >= ?
         GROUP BY date
         ORDER BY date ASC`,
      )
      .all(minTs);

    return c.json(rows);
  });

  app.post('/api/obsidian/bootstrap', async (c) => {
    const settings = await loadSettings();
    const vaultRoot = resolve(expandHomePath(settings.paths.vaultPath));

    try {
      await mkdir(vaultRoot, { recursive: true });
      const result = await bootstrapVault(vaultRoot);

      // Auto-reindex after bootstrap so the new notes are queryable immediately
      const db = getDb();
      const reindex = await reindexObsidianVault(db, settings);

      return c.json({
        ok: true,
        bootstrap: result,
        reindex,
      });
    } catch (error) {
      return c.json({ ok: false, error: 'bootstrap_failed', details: String(error) }, 500);
    }
  });

  app.post('/api/obsidian/reindex', async (c) => {
    const payload = await c.req.json().catch(() => ({}));
    const parsed = ReindexPayloadSchema.safeParse(payload);
    if (!parsed.success) {
      return c.json({ error: 'invalid_payload', details: parsed.error.flatten() }, 400);
    }

    const db = getDb();
    const settings = await loadSettings();

    try {
      // Rebuild hubs + project stubs BEFORE scanning so the new files enter
      // the links graph in the same pass.
      let hubs: Awaited<ReturnType<typeof rebuildVaultHubs>> = { hubs: [], stubs: [] };
      try {
        hubs = await rebuildVaultHubs({ db });
      } catch (error) {
        console.warn('[vaultHubs] rebuild failed:', String(error));
      }
      const result = await reindexObsidianVault(db, settings);
      return c.json({ ok: true, ...result, hubs });
    } catch (error) {
      return c.json({ ok: false, error: 'reindex_failed', details: String(error) }, 500);
    }
  });

  app.post('/api/obsidian/hubs/rebuild', async (c) => {
    const db = getDb();
    try {
      const hubs = await rebuildVaultHubs({ db });
      return c.json({ ok: true, ...hubs });
    } catch (error) {
      return c.json({ ok: false, error: 'hubs_rebuild_failed', details: String(error) }, 500);
    }
  });

  app.post('/api/obsidian/capture', async (c) => {
    const payload = await c.req.json();
    const parsed = CapturePayloadSchema.safeParse(payload);
    if (!parsed.success) {
      return c.json({ error: 'invalid_payload', details: parsed.error.flatten() }, 400);
    }

    const settings = await loadSettings();
    const vaultRoot = resolve(expandHomePath(settings.paths.vaultPath));

    const rawTarget = parsed.data.daily ? todayDailyPath() : parsed.data.path;
    if (!rawTarget) {
      return c.json({ error: 'missing_target_path' }, 400);
    }

    const targetPath = /\.md$/i.test(rawTarget) ? rawTarget : `${rawTarget}.md`;

    let abs: string;
    try {
      abs = resolveVaultPath(vaultRoot, targetPath);
    } catch {
      return c.json({ error: 'path_escapes_vault' }, 400);
    }

    try {
      await mkdir(dirname(abs), { recursive: true });
      const content = `\n\n${parsed.data.content.trim()}\n`;
      await appendFile(abs, content, 'utf8');
    } catch (error) {
      return c.json({ error: 'capture_failed', details: String(error) }, 500);
    }

    return c.json({ ok: true, path: targetPath });
  });
}
