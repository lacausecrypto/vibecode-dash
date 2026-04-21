import { readFile, readdir, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Hono } from 'hono';
import { expandHomePath, loadSettings } from '../config';
import { getDb } from '../db';
import { buildProjectTree, scanAllProjects, scanProjectById } from '../scanners/projectScanner';

function isSubPath(candidate: string, root: string): boolean {
  const c = resolve(candidate);
  const r = resolve(root);
  return c === r || c.startsWith(`${r}/`);
}

export function registerProjectRoutes(app: Hono): void {
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
                loc, languages_json
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
