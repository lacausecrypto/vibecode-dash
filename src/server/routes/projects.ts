import { readFile, readdir, stat } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, normalize, resolve } from 'node:path';
import type { Hono } from 'hono';
import { expandHomePath, loadSettings } from '../config';
import { getDb } from '../db';
import { buildProjectTree, scanAllProjects, scanProjectById } from '../scanners/projectScanner';

function isSubPath(candidate: string, root: string): boolean {
  const c = resolve(candidate);
  const r = resolve(root);
  return c === r || c.startsWith(`${r}/`);
}

// Content-type lookup for README-embedded assets. Kept deliberately narrow:
// only image/video formats commonly found in READMEs. Anything else returns
// 415 — we don't want this endpoint to become a generic file server.
const ASSET_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};

// Hard cap on bytes we'll stream out — prevents the UI from hanging on a
// 200 MB demo video accidentally committed to a README folder.
const ASSET_MAX_BYTES = 20 * 1024 * 1024;

export function registerProjectRoutes(app: Hono): void {
  app.get('/api/projects/status', (c) => {
    const db = getDb();
    const kvRow = db
      .query<{ value: string }, [string]>('SELECT value FROM kv WHERE key = ?')
      .get('last_scan_at');
    const lastScannedAt = kvRow ? Number.parseInt(kvRow.value, 10) : null;
    const count = db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM projects').get()?.n ?? 0;
    return c.json({
      lastScannedAt: lastScannedAt && Number.isFinite(lastScannedAt) ? lastScannedAt : null,
      projectCount: count,
    });
  });

  app.get('/api/projects', async (c) => {
    const db = getDb();
    const settings = await loadSettings();
    const excluded = new Set(
      (settings.paths.excludedProjects || []).map((p) => resolve(expandHomePath(p))),
    );
    const rows = db
      .query<{ path: string } & Record<string, unknown>, []>(
        `SELECT id, path, name, type, description, last_modified, last_commit_at,
                git_branch, uncommitted, health_score, health_breakdown_json,
                loc, languages_json, scanned_at
         FROM projects
         ORDER BY last_modified DESC`,
      )
      .all()
      .filter((row) => !excluded.has(resolve(row.path)));

    return c.json(rows);
  });

  app.get('/api/projects/:id', (c) => {
    const db = getDb();
    const id = c.req.param('id');
    const row = db.query('SELECT * FROM projects WHERE id = ?').get(id);

    if (!row) {
      return c.json({ error: 'project_not_found' }, 404);
    }

    return c.json(row);
  });

  app.get('/api/projects/:id/readme', async (c) => {
    const db = getDb();
    const id = c.req.param('id');
    const row = db
      .query<{ readme_path: string | null; path: string }, [string]>(
        'SELECT readme_path, path FROM projects WHERE id = ?',
      )
      .get(id);

    if (!row?.readme_path) {
      return c.json({ error: 'readme_not_found' }, 404);
    }

    const settings = await loadSettings();
    const allowedRoots = [
      ...settings.paths.projectsRoots.map((root) => expandHomePath(root)),
      row.path,
    ];

    if (!allowedRoots.some((root) => isSubPath(row.readme_path as string, root))) {
      return c.json({ error: 'readme_not_allowed' }, 403);
    }

    try {
      const markdown = await readFile(row.readme_path, 'utf8');
      return c.text(markdown, 200, { 'content-type': 'text/markdown; charset=utf-8' });
    } catch {
      return c.json({ error: 'readme_unreadable' }, 500);
    }
  });

  // Serves static assets (images, GIFs, short videos) referenced by a
  // project's README with relative paths like `./docs/demo.gif`. Without this
  // endpoint those references 404 in the browser because the README is served
  // as text/markdown with no host to resolve relative URLs against.
  //
  // Security model: the requested `path` is resolved against the project's
  // root, then we assert both (a) containment in the project dir and (b)
  // containment in an allowed settings root. Any `..` traversal that escapes
  // is rejected. MIME is whitelisted to image/video only.
  app.get('/api/projects/:id/asset', async (c) => {
    const db = getDb();
    const id = c.req.param('id');
    const relParam = c.req.query('path');

    if (!relParam || typeof relParam !== 'string') {
      return c.json({ error: 'missing_path' }, 400);
    }

    const row = db
      .query<{ path: string; readme_path: string | null }, [string]>(
        'SELECT path, readme_path FROM projects WHERE id = ?',
      )
      .get(id);
    if (!row) {
      return c.json({ error: 'project_not_found' }, 404);
    }

    // Resolve relative to the README's directory when present (matches how
    // GitHub/GitLab render image paths), falling back to the project root.
    const baseDir = row.readme_path ? dirname(row.readme_path) : row.path;
    const requested = isAbsolute(relParam) ? relParam : join(baseDir, relParam);
    const resolved = resolve(normalize(requested));

    // Double-containment check: resolved path must sit inside BOTH the
    // project directory AND a settings-allowed root. The settings check
    // mirrors the readme endpoint's policy; the project-dir check blocks the
    // edge case where a project sits at settings-root level and `..` could
    // walk into a sibling project.
    if (!isSubPath(resolved, row.path)) {
      return c.json({ error: 'asset_outside_project' }, 403);
    }
    const settings = await loadSettings();
    const allowedRoots = settings.paths.projectsRoots.map((r) => expandHomePath(r));
    if (!allowedRoots.some((root) => isSubPath(resolved, root))) {
      return c.json({ error: 'asset_outside_allowed_roots' }, 403);
    }

    const ext = extname(resolved).toLowerCase();
    const mime = ASSET_MIME[ext];
    if (!mime) {
      return c.json({ error: 'asset_mime_not_allowed', ext }, 415);
    }

    try {
      const fileStat = await stat(resolved);
      if (!fileStat.isFile()) {
        return c.json({ error: 'asset_not_a_file' }, 404);
      }
      if (fileStat.size > ASSET_MAX_BYTES) {
        return c.json({ error: 'asset_too_large', size: fileStat.size }, 413);
      }
      const data = await readFile(resolved);
      return new Response(data, {
        status: 200,
        headers: {
          'content-type': mime,
          'content-length': String(data.byteLength),
          // Short cache: assets change when the user edits the repo, but we
          // don't want the browser to re-fetch on every scroll.
          'cache-control': 'private, max-age=60',
        },
      });
    } catch {
      return c.json({ error: 'asset_not_found' }, 404);
    }
  });

  // Lightweight git stats: commit counts, author diversity, recent hotspots.
  // Computed on demand (not cached in DB) because this is cheap on any repo
  // modern enough to have a reachable .git directory and the values change
  // frequently. If the project isn't a git repo we just return null fields.
  app.get('/api/projects/:id/git/stats', async (c) => {
    const db = getDb();
    const id = c.req.param('id');
    const row = db
      .query<{ path: string }, [string]>('SELECT path FROM projects WHERE id = ?')
      .get(id);
    if (!row) {
      return c.json({ error: 'project_not_found' }, 404);
    }

    try {
      const stats = await collectGitStats(row.path);
      return c.json(stats);
    } catch (error) {
      return c.json({ error: 'git_stats_failed', details: String(error) }, 500);
    }
  });

  app.get('/api/projects/:id/tree', async (c) => {
    const db = getDb();
    const id = c.req.param('id');
    const rawDepth = Number.parseInt(c.req.query('depth') || '2', 10);
    // Bornes : un tree > profondeur 6 devient rarement utile et coûte exponentiellement.
    // Plafond défensif contre `?depth=9999` qui stallerait le process sur un gros repo.
    const depth = Number.isFinite(rawDepth) ? Math.min(6, Math.max(1, rawDepth)) : 2;

    const row = db
      .query<{ path: string }, [string]>('SELECT path FROM projects WHERE id = ?')
      .get(id);
    if (!row) {
      return c.json({ error: 'project_not_found' }, 404);
    }

    try {
      const tree = await buildProjectTree(row.path, depth);
      return c.json(tree);
    } catch (error) {
      return c.json({ error: 'tree_failed', details: String(error) }, 500);
    }
  });

  app.post('/api/projects/rescan', async (c) => {
    const db = getDb();
    const settings = await loadSettings();
    const result = await scanAllProjects(db, settings);
    return c.json(result);
  });

  app.get('/api/projects/paths/detect', async (c) => {
    const settings = await loadSettings();
    const excluded = new Set(
      (settings.paths.excludedProjects || []).map((p) => resolve(expandHomePath(p))),
    );
    const MARKERS = [
      'package.json',
      'pyproject.toml',
      'requirements.txt',
      'setup.py',
      'Cargo.toml',
      'go.mod',
      '.git',
    ];
    const hasMarker = async (dir: string): Promise<boolean> => {
      for (const marker of MARKERS) {
        try {
          await stat(`${dir}/${marker}`);
          return true;
        } catch {
          /* next */
        }
      }
      return false;
    };

    const roots: Array<{
      input: string;
      resolved: string;
      exists: boolean;
      projects: Array<{ path: string; name: string; excluded: boolean }>;
    }> = [];

    for (const input of settings.paths.projectsRoots) {
      const resolvedRoot = resolve(expandHomePath(input));
      let exists = false;
      const projects: Array<{ path: string; name: string; excluded: boolean }> = [];
      try {
        const st = await stat(resolvedRoot);
        exists = st.isDirectory();
      } catch {
        /* nope */
      }

      if (exists) {
        if (await hasMarker(resolvedRoot)) {
          projects.push({
            path: resolvedRoot,
            name: resolvedRoot.split('/').pop() || resolvedRoot,
            excluded: excluded.has(resolvedRoot),
          });
        }
        let names: string[] = [];
        try {
          names = await readdir(resolvedRoot);
        } catch {
          /* ignore */
        }
        for (const name of names) {
          if (name.startsWith('.')) continue;
          const sub = `${resolvedRoot}/${name}`;
          try {
            const subStat = await stat(sub);
            if (!subStat.isDirectory()) continue;
          } catch {
            continue;
          }
          if (await hasMarker(sub)) {
            projects.push({ path: sub, name, excluded: excluded.has(sub) });
          }
        }
      }

      roots.push({ input, resolved: resolvedRoot, exists, projects });
    }

    return c.json({ roots });
  });

  app.get('/api/projects/paths/check', async (c) => {
    const settings = await loadSettings();
    const rows = await Promise.all(
      settings.paths.projectsRoots.map(async (input) => {
        const resolved = resolve(expandHomePath(input));
        let exists = false;
        let candidates = 0;
        const MARKERS = [
          'package.json',
          'pyproject.toml',
          'requirements.txt',
          'setup.py',
          'Cargo.toml',
          'go.mod',
          '.git',
        ];
        const hasMarker = async (dir: string): Promise<boolean> => {
          for (const marker of MARKERS) {
            try {
              await stat(`${dir}/${marker}`);
              return true;
            } catch {
              /* next */
            }
          }
          return false;
        };
        try {
          const st = await stat(resolved);
          exists = st.isDirectory();
          if (exists) {
            // Root itself counts as a project if it carries a marker.
            if (await hasMarker(resolved)) candidates += 1;
            const names = await readdir(resolved);
            for (const name of names) {
              if (name.startsWith('.')) continue;
              const sub = `${resolved}/${name}`;
              try {
                const subStat = await stat(sub);
                if (!subStat.isDirectory()) continue;
              } catch {
                continue;
              }
              if (await hasMarker(sub)) candidates += 1;
            }
          }
        } catch {
          exists = false;
        }
        return { input, resolved, exists, candidates };
      }),
    );
    return c.json({ roots: rows });
  });

  app.post('/api/projects/rescan/:id', async (c) => {
    const db = getDb();
    const id = c.req.param('id');

    try {
      const row = await scanProjectById(db, id);
      if (!row) {
        return c.json({ error: 'project_not_found' }, 404);
      }
      return c.json(row);
    } catch (error) {
      return c.json({ error: 'rescan_failed', details: String(error) }, 500);
    }
  });
}

type GitStats = {
  isGitRepo: boolean;
  totalCommits: number | null;
  commitsLast30d: number | null;
  commitsLast7d: number | null;
  authors30d: number | null;
  authorsTotal: number | null;
  hotFiles: Array<{ path: string; changes: number }>;
  topAuthors: Array<{ name: string; commits: number }>;
};

async function runGitCommand(
  args: string[],
  cwd: string,
  timeoutMs = 5000,
): Promise<string | null> {
  const proc = Bun.spawn(args, { cwd, stdout: 'pipe', stderr: 'ignore' });
  // Timeout guard: a 100k-file repo's `git log --name-only` can take a while.
  // Fire-and-forget kill to avoid leaking a wedged process.
  const timer = setTimeout(() => {
    try {
      proc.kill();
    } catch {
      /* ignore */
    }
  }, timeoutMs);
  try {
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    if (code !== 0) return null;
    return out;
  } finally {
    clearTimeout(timer);
  }
}

async function collectGitStats(path: string): Promise<GitStats> {
  try {
    const gitDir = await stat(`${path}/.git`).catch(() => null);
    if (!gitDir) {
      return {
        isGitRepo: false,
        totalCommits: null,
        commitsLast30d: null,
        commitsLast7d: null,
        authors30d: null,
        authorsTotal: null,
        hotFiles: [],
        topAuthors: [],
      };
    }
  } catch {
    /* ignore */
  }

  // Fire these in parallel — they're independent.
  const [totalRaw, last30Raw, last7Raw, authors30Raw, authorsTotalRaw, hotFilesRaw, topAuthorsRaw] =
    await Promise.all([
      runGitCommand(['git', 'rev-list', '--count', 'HEAD'], path),
      runGitCommand(['git', 'rev-list', '--count', '--since=30.days', 'HEAD'], path),
      runGitCommand(['git', 'rev-list', '--count', '--since=7.days', 'HEAD'], path),
      runGitCommand(['git', 'log', '--since=30.days', '--pretty=format:%ae', 'HEAD'], path),
      runGitCommand(['git', 'log', '--pretty=format:%ae', 'HEAD'], path),
      runGitCommand(
        ['git', 'log', '--since=90.days', '--name-only', '--pretty=format:', 'HEAD'],
        path,
        10000,
      ),
      runGitCommand(['git', 'shortlog', '-sne', '--since=90.days', 'HEAD'], path),
    ]);

  const toInt = (s: string | null): number | null => {
    if (!s) return null;
    const n = Number.parseInt(s.trim(), 10);
    return Number.isFinite(n) ? n : null;
  };

  const uniqueEmails = (raw: string | null): number | null => {
    if (!raw) return null;
    const set = new Set(
      raw
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean),
    );
    return set.size;
  };

  // Count file occurrences in the log output. Each non-empty, non-commit
  // line is a touched file. Top 10 by change count.
  const hotFileCounts = new Map<string, number>();
  if (hotFilesRaw) {
    for (const line of hotFilesRaw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      hotFileCounts.set(trimmed, (hotFileCounts.get(trimmed) || 0) + 1);
    }
  }
  const hotFiles = [...hotFileCounts.entries()]
    .sort(([, a], [, b]) => b - a)
    .slice(0, 10)
    .map(([p, changes]) => ({ path: p, changes }));

  // Parse `git shortlog -sne` → "  123  Alice <alice@example.com>"
  const topAuthors: Array<{ name: string; commits: number }> = [];
  if (topAuthorsRaw) {
    for (const line of topAuthorsRaw.split('\n')) {
      const m = line.match(/^\s*(\d+)\s+(.+?)\s+<[^>]+>\s*$/);
      if (m) {
        topAuthors.push({ commits: Number.parseInt(m[1], 10), name: m[2] });
      }
    }
    topAuthors.splice(8);
  }

  return {
    isGitRepo: true,
    totalCommits: toInt(totalRaw),
    commitsLast30d: toInt(last30Raw),
    commitsLast7d: toInt(last7Raw),
    authors30d: uniqueEmails(authors30Raw),
    authorsTotal: uniqueEmails(authorsTotalRaw),
    hotFiles,
    topAuthors,
  };
}
