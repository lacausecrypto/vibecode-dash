import { readdir, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expandHomePath } from '../config';
import { isSubPath } from '../lib/pathGuards';

export type KnownProject = {
  id: string;
  name: string;
  path: string;
};

export type PreparedProject = KnownProject & {
  normalizedPath: string;
};

export type PreparedRoot = {
  original: string;
  normalized: string;
};

export type ProjectIdentity = {
  projectKey: string;
  projectPath: string | null;
  projectId: string | null;
  projectName: string | null;
};

export type JsonlFileCandidate = {
  path: string;
  mtime: number;
};

export function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  return value as Record<string, unknown>;
}

export function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export function asNumber(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  return 0;
}

export function parseTimestamp(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value > 1_000_000_000_000) {
      return Math.floor(value / 1000);
    }
    if (value > 1_000_000_000) {
      return Math.floor(value);
    }
  }

  if (typeof value === 'string' && value.length > 0) {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) {
      return Math.floor(parsed / 1000);
    }
  }

  return null;
}

export function normalizeRoots(projectRoots: string[]): PreparedRoot[] {
  const out = new Map<string, PreparedRoot>();
  for (const root of projectRoots) {
    const expanded = expandHomePath(root);
    const normalized = resolve(expanded);
    out.set(normalized, { original: expanded, normalized });
  }
  return [...out.values()].sort((a, b) => b.normalized.length - a.normalized.length);
}

export function normalizeProjects(projects: KnownProject[]): PreparedProject[] {
  return projects
    .map((project) => ({
      ...project,
      normalizedPath: resolve(project.path),
    }))
    .sort((a, b) => b.normalizedPath.length - a.normalizedPath.length);
}

export async function listRecentJsonlFiles(
  root: string,
  opts: {
    fromTs: number;
    maxFiles: number;
    minDepth?: number;
    maxDepth?: number;
  },
): Promise<JsonlFileCandidate[]> {
  const resolvedRoot = resolve(expandHomePath(root));
  const minDepth = opts.minDepth ?? 1;
  const maxDepth = opts.maxDepth ?? Number.POSITIVE_INFINITY;
  const out: JsonlFileCandidate[] = [];

  async function walk(dir: string, depth: number): Promise<void> {
    let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const full = resolve(dir, entry.name);
      const entryDepth = depth + 1;

      if (entry.isDirectory()) {
        if (entryDepth < maxDepth) {
          await walk(full, entryDepth);
        }
        continue;
      }

      if (!entry.isFile() || entryDepth < minDepth || entryDepth > maxDepth) {
        continue;
      }
      if (!entry.name.endsWith('.jsonl')) {
        continue;
      }

      try {
        const s = await stat(full);
        const mtime = Math.floor(s.mtimeMs / 1000);
        if (mtime >= opts.fromTs) {
          out.push({ path: full, mtime });
        }
      } catch {
        // Ignore unreadable/raced files; next scan will pick them up.
      }
    }
  }

  await walk(resolvedRoot, 0);
  return out.sort((a, b) => b.mtime - a.mtime).slice(0, opts.maxFiles);
}

export { isSubPath };
