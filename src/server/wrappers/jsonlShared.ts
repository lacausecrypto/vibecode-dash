import { resolve } from 'node:path';
import { expandHomePath } from '../config';

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

export function isSubPath(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(`${root}/`);
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

export async function runCommand(
  args: string[],
): Promise<{ stdout: string; stderr: string; code: number }> {
  const proc = Bun.spawn(args, { stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, code };
}
