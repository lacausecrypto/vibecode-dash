import type { Database } from 'bun:sqlite';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { type Settings, expandHomePath } from '../config';
import { withLock } from './locks';
import type { MemoryRow } from './memory';

/**
 * Karpathy write-back: surface every auto-distilled memory in the Obsidian
 * vault so the user can read, curate, promote or delete them from their own
 * editor. Source of truth stays in SQLite (authoritative, queryable); the
 * markdown files are append-only mirrors organised by scope.
 *
 * Layout:
 *   {vault}/Persona/memories.md         — global scope (user-wide facts)
 *   {vault}/Projects/<slug>/memories.md — per-project scope
 *   (session scope is NOT mirrored — too ephemeral)
 *
 * Each memory occupies one bullet line tagged with its key, so re-runs are
 * idempotent: we never insert the same (key) twice, we only append new rows.
 */

const BLOCK_START = '<!-- memories:auto:start -->';
const BLOCK_END = '<!-- memories:auto:end -->';

function slugify(input: string): string {
  return (
    input
      .toLowerCase()
      .normalize('NFD')
      .replace(/\p{Diacritic}/gu, '')
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 60) || 'project'
  );
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function frontMatterFor(kind: 'persona' | 'project', label: string, slug?: string): string {
  const lines: string[] = ['---'];
  lines.push(`type: ${kind === 'persona' ? 'persona' : 'project'}-memories`);
  lines.push(`scope: ${kind}`);
  if (kind === 'project') {
    // Wikilink target must match the on-disk slug (lowercase, diacritic-stripped)
    // so `Projects/<slug>.md` (auto-created by vaultHubs) resolves it.
    lines.push(`project: "[[Projects/${slug ?? label}]]"`);
  }
  lines.push('generated_by: vibecode-dash memory pass');
  lines.push('collab_reviewed: false');
  const tags = ['memory', kind];
  if (kind === 'project' && slug) tags.push(`project/${slug}`);
  lines.push(`tags: [${tags.map((t) => JSON.stringify(t)).join(', ')}]`);
  lines.push('---');
  return lines.join('\n');
}

function initialBody(kind: 'persona' | 'project', label: string, slug?: string): string {
  const heading = kind === 'persona' ? '# Global memories' : `# Memories · ${label}`;
  const hint =
    kind === 'persona'
      ? "> Faits distillés automatiquement par l'agent au fil des conversations. SQLite reste la source d'autorité ; ce fichier est un miroir navigable.\n"
      : `> Faits projet distillés automatiquement. Source d'autorité : SQLite \`agent_memories\` scope \`project:*\`.\n`;

  return [
    frontMatterFor(kind, label, slug),
    '',
    heading,
    '',
    hint,
    '',
    BLOCK_START,
    BLOCK_END,
    '',
  ].join('\n');
}

function extractExistingKeys(body: string): Set<string> {
  const keys = new Set<string>();
  const blockStart = body.indexOf(BLOCK_START);
  const blockEnd = body.indexOf(BLOCK_END);
  if (blockStart === -1 || blockEnd === -1 || blockEnd < blockStart) {
    return keys;
  }
  const block = body.slice(blockStart + BLOCK_START.length, blockEnd);
  for (const line of block.split('\n')) {
    // format: `- **key** · content _(source · YYYY-MM-DD)_`
    const match = line.match(/^\s*-\s+\*\*([^*]+)\*\*/);
    if (match?.[1]) {
      keys.add(match[1].trim());
    }
  }
  return keys;
}

function formatDate(ts: number): string {
  const d = new Date(ts * 1000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function formatMemoryLine(row: MemoryRow): string {
  const content = row.content.replace(/\s+/g, ' ').trim();
  return `- **${row.key}** · ${content} _(${row.source} · ${formatDate(row.updated_at)})_`;
}

function injectBlock(body: string, lines: string[]): string {
  const blockStart = body.indexOf(BLOCK_START);
  const blockEnd = body.indexOf(BLOCK_END);
  if (blockStart === -1 || blockEnd === -1 || blockEnd < blockStart) {
    // Corrupt / missing block — append a fresh one at the end.
    return `${body.trimEnd()}\n\n${BLOCK_START}\n${lines.join('\n')}\n${BLOCK_END}\n`;
  }
  const before = body.slice(0, blockStart + BLOCK_START.length);
  const after = body.slice(blockEnd);
  const existing = body
    .slice(blockStart + BLOCK_START.length, blockEnd)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const merged = [...existing, ...lines].join('\n');
  return `${before}\n${merged}\n${after}`;
}

async function ensureFile(
  path: string,
  kind: 'persona' | 'project',
  label: string,
  slug?: string,
): Promise<string> {
  if (!(await fileExists(path))) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, initialBody(kind, label, slug), 'utf8');
  }
  return await readFile(path, 'utf8');
}

async function appendMemoriesToFile(
  path: string,
  kind: 'persona' | 'project',
  label: string,
  rows: MemoryRow[],
  slug?: string,
): Promise<{ added: number; skipped: number }> {
  // Lock per path: two concurrent memory passes hitting the same file would
  // otherwise read/merge/write in lock-step and one write would overwrite
  // the other's block insertion.
  return withLock(`vault:${path}`, async () => {
    const body = await ensureFile(path, kind, label, slug);
    const existingKeys = extractExistingKeys(body);
    const fresh = rows.filter((row) => !existingKeys.has(row.key));
    if (fresh.length === 0) {
      return { added: 0, skipped: rows.length };
    }
    const nextBody = injectBlock(body, fresh.map(formatMemoryLine));
    await writeFile(path, nextBody, 'utf8');
    return { added: fresh.length, skipped: rows.length - fresh.length };
  });
}

type ProjectRow = { id: string; name: string };

function projectNameById(db: Database, projectId: string): string | null {
  const row = db
    .query<ProjectRow, [string]>('SELECT id, name FROM projects WHERE id = ? LIMIT 1')
    .get(projectId);
  return row?.name || null;
}

export type MemoryVaultSyncResult = {
  vaultRoot: string | null;
  written: Array<{ path: string; added: number; skipped: number }>;
  skippedReason?: 'vault_not_configured' | 'vault_not_found';
};

/**
 * Sync the given memories to the vault. Best-effort: any IO failure is logged
 * but never propagates — persistence in SQLite is what matters, this is just
 * the human-navigable mirror.
 */
export async function syncMemoriesToVault(options: {
  settings: Settings;
  db: Database;
  memories: MemoryRow[];
}): Promise<MemoryVaultSyncResult> {
  if (!options.settings.paths.vaultPath) {
    return { vaultRoot: null, written: [], skippedReason: 'vault_not_configured' };
  }

  const vaultRoot = resolve(expandHomePath(options.settings.paths.vaultPath));
  if (!(await fileExists(vaultRoot))) {
    return { vaultRoot, written: [], skippedReason: 'vault_not_found' };
  }

  // Bucket memories by target file path.
  const buckets = new Map<
    string,
    { kind: 'persona' | 'project'; label: string; slug?: string; rows: MemoryRow[] }
  >();

  for (const row of options.memories) {
    if (row.scope === 'global') {
      const path = join(vaultRoot, 'Persona', 'memories.md');
      const bucket = buckets.get(path) || { kind: 'persona' as const, label: 'global', rows: [] };
      bucket.rows.push(row);
      buckets.set(path, bucket);
      continue;
    }
    if (row.scope.startsWith('project:')) {
      const projectId = row.scope.slice('project:'.length);
      const name = projectNameById(options.db, projectId);
      if (!name) {
        // Orphan scope (project deleted). Skip silently.
        continue;
      }
      const slug = slugify(name);
      const path = join(vaultRoot, 'Projects', slug, 'memories.md');
      const bucket = buckets.get(path) || {
        kind: 'project' as const,
        label: name,
        slug,
        rows: [],
      };
      bucket.rows.push(row);
      buckets.set(path, bucket);
    }
    // session:* scope → skip (too ephemeral for vault)
  }

  const written: MemoryVaultSyncResult['written'] = [];
  for (const [path, bucket] of buckets) {
    try {
      const result = await appendMemoriesToFile(
        path,
        bucket.kind,
        bucket.label,
        bucket.rows,
        bucket.slug,
      );
      written.push({ path, ...result });
    } catch (error) {
      // Filesystem hiccup shouldn't break the turn. Record and continue.
      written.push({ path, added: 0, skipped: bucket.rows.length });
      // eslint-disable-next-line no-console
      console.warn(`[memoryVaultSync] failed for ${path}:`, String(error));
    }
  }

  return { vaultRoot, written };
}
