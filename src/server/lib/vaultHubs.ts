import type { Database } from 'bun:sqlite';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import { expandHomePath, loadSettings } from '../config';
import { getDb } from '../db';

/**
 * Intelligent orphan reduction in the vault via two idempotent strategies:
 *
 * 1) **Project stubs** — `Projects/<slug>.md` is created for every project
 *    that has a `Projects/<slug>/memories.md` child. This makes the wikilinks
 *    that memoryVaultSync + promoteInsightToVault write in frontmatter
 *    (`project: "[[Projects/<slug>]]"`) actually resolve, turning silent
 *    unresolved edges into real backlinks.
 *
 * 2) **Folder hubs** — auto-generated `Concepts/_index.md`, `Sessions/_index.md`,
 *    and `People/_index.md`. Each is a flat wikilink roll-up of every `.md` in
 *    the folder (recursive, excluding auto-files). Two effects: every note
 *    in the folder gains an inbound backlink from the hub, and the user has
 *    a navigable table-of-contents per folder.
 *
 * Both writes are idempotent: existing user content outside a managed block
 * is preserved. The hub uses `<!-- hub:auto:start -->` / `<!-- hub:auto:end -->`
 * fences so manual notes above/below stay intact if the user adds them later.
 */

const HUB_START = '<!-- hub:auto:start -->';
const HUB_END = '<!-- hub:auto:end -->';
const IGNORED_NAMES = new Set(['_README.md', '_template.md', '_index.md']);
const IGNORED_DIRS = new Set(['.obsidian', '.trash', 'attachments']);

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

async function listMarkdownUnder(absDir: string, rootForRel: string): Promise<string[]> {
  const out: string[] = [];
  const queue: string[] = [absDir];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) continue;
    const names = await readdir(current).catch(() => [] as string[]);
    for (const name of names) {
      if (IGNORED_DIRS.has(name) || name.startsWith('.')) continue;
      const abs = join(current, name);
      let isDir = false;
      let isFile = false;
      try {
        const s = await stat(abs);
        isDir = s.isDirectory();
        isFile = s.isFile();
      } catch {
        continue;
      }
      if (isDir) {
        queue.push(abs);
        continue;
      }
      if (!isFile) continue;
      if (extname(name).toLowerCase() !== '.md') continue;
      if (IGNORED_NAMES.has(name)) continue;
      // Skip auto-generated per-project memories (already mirrored via frontmatter).
      if (name === 'memories.md') continue;
      out.push(abs.slice(rootForRel.length + 1));
    }
  }
  return out.sort((a, b) => a.localeCompare(b));
}

function titleFromPath(path: string): string {
  return basename(path, '.md').replace(/[-_]/g, ' ');
}

function buildHubBody(folder: string, entries: string[]): string {
  const lines = [`# ${folder}`, ''];
  if (entries.length === 0) {
    lines.push('_Aucune note._');
    lines.push('');
  } else {
    lines.push(`> ${entries.length} note${entries.length > 1 ? 's' : ''} · auto-index`);
    lines.push('');
    for (const path of entries) {
      // Wikilink target is the path without .md — Obsidian resolves it back to the file.
      const linkTarget = path.replace(/\.md$/, '');
      lines.push(`- [[${linkTarget}|${titleFromPath(path)}]]`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

function wrapManagedBlock(folder: string, entries: string[]): string {
  const body = buildHubBody(folder, entries);
  const tags = ['hub', 'index', folder.toLowerCase()];
  return `---
type: hub
source: dashboard-auto
collab_reviewed: false
tags: [${tags.map((t) => JSON.stringify(t)).join(', ')}]
---

${HUB_START}
${body}
${HUB_END}
`;
}

async function writeHub(absPath: string, folder: string, entries: string[]): Promise<void> {
  await mkdir(dirname(absPath), { recursive: true });
  const nextContent = wrapManagedBlock(folder, entries);

  if (!(await fileExists(absPath))) {
    await writeFile(absPath, nextContent, 'utf8');
    return;
  }

  // Preserve any user-authored content outside the managed block.
  const current = await readFile(absPath, 'utf8');

  // Upgrade path: if this is a previous-version auto hub (no `tags:` in
  // frontmatter), re-write the whole file so the new frontmatter lands.
  const isAutoHub = /\bsource:\s*dashboard-auto\b/.test(current);
  const hasTagsFm = /^tags:\s*\[/m.test(current);
  if (isAutoHub && !hasTagsFm) {
    await writeFile(absPath, nextContent, 'utf8');
    return;
  }

  const start = current.indexOf(HUB_START);
  const end = current.indexOf(HUB_END);
  if (start === -1 || end === -1 || end < start) {
    await writeFile(absPath, nextContent, 'utf8');
    return;
  }

  const autoBlock = `${HUB_START}\n${buildHubBody(folder, entries)}\n${HUB_END}`;
  const before = current.slice(0, start);
  const after = current.slice(end + HUB_END.length);
  await writeFile(absPath, `${before}${autoBlock}${after}`, 'utf8');
}

type ProjectRow = { id: string; name: string };

async function writeProjectStubs(vaultRoot: string, db: Database): Promise<string[]> {
  const projectsRoot = join(vaultRoot, 'Projects');
  if (!(await fileExists(projectsRoot))) return [];

  const created: string[] = [];
  const names = await readdir(projectsRoot).catch(() => [] as string[]);
  const subDirs: string[] = [];
  for (const name of names) {
    try {
      const s = await stat(join(projectsRoot, name));
      if (s.isDirectory()) subDirs.push(name);
    } catch {
      /* ignore */
    }
  }

  // Map known DB project names to their expected slug so stubs cover every
  // project the memoryVaultSync / promoteInsight may target.
  const dbSlugs = new Set<string>();
  try {
    const rows = db.query<ProjectRow, []>('SELECT id, name FROM projects').all();
    for (const row of rows) dbSlugs.add(slugify(row.name));
  } catch {
    /* projects table may not exist in isolated tests */
  }

  const slugs = new Set<string>([...subDirs, ...dbSlugs]);
  for (const slug of slugs) {
    const stubPath = join(projectsRoot, `${slug}.md`);
    if (await fileExists(stubPath)) {
      // Re-write if the existing file is one we previously auto-generated
      // (upgrades frontmatter/tags across versions). User-authored files are
      // preserved: the `source: dashboard-auto` marker is our opt-in sentinel.
      try {
        const current = await readFile(stubPath, 'utf8');
        if (!/\bsource:\s*dashboard-auto\b/.test(current)) continue;
      } catch {
        continue;
      }
    }
    const memoriesPath = join(projectsRoot, slug, 'memories.md');
    const hasMemories = await fileExists(memoriesPath);
    const body = [
      '---',
      'type: project',
      'source: dashboard-auto',
      'collab_reviewed: false',
      `tags: ["project", "project/${slug}", "auto"]`,
      '---',
      '',
      `# ${slug}`,
      '',
      '> Fiche projet auto-générée pour résoudre les wikilinks `[[Projects/<slug>]]`.',
      '',
      hasMemories ? `- [[Projects/${slug}/memories|Mémoires]]` : null,
      '',
    ]
      .filter(Boolean)
      .join('\n');
    await writeFile(stubPath, body, 'utf8');
    created.push(`Projects/${slug}.md`);
  }
  return created;
}

export type VaultHubsResult = {
  hubs: string[];
  stubs: string[];
};

/**
 * Retro-tag auto-generated notes from earlier versions that shipped without
 * `tags:` in their frontmatter. We only touch files whose `source` marks
 * them as dashboard-authored; user-authored notes are never rewritten.
 */
async function upgradeLegacyAutoNotes(vaultRoot: string): Promise<number> {
  let upgraded = 0;
  const targets: Array<{ dir: string; marker: RegExp; tagsFor: (path: string) => string[] }> = [
    {
      dir: 'Concepts/radar',
      marker: /\bsource:\s*radar-insight\b/,
      tagsFor: (_p) => ['concept', 'radar'],
    },
    {
      dir: 'Sessions',
      marker: /\btype:\s*session\b/,
      tagsFor: (_p) => ['session'],
    },
  ];

  for (const { dir, marker, tagsFor } of targets) {
    const absDir = join(vaultRoot, dir);
    if (!(await fileExists(absDir))) continue;
    const files = await listMarkdownUnder(absDir, vaultRoot);
    for (const rel of files) {
      if (rel.endsWith('_index.md')) continue;
      const abs = join(vaultRoot, rel);
      let content: string;
      try {
        content = await readFile(abs, 'utf8');
      } catch {
        continue;
      }
      if (!marker.test(content)) continue;
      if (/^tags:\s*\[/m.test(content)) continue;
      // Inject tags line before the closing `---` of the frontmatter block.
      const fmClose = content.indexOf('\n---', 4);
      if (fmClose === -1) continue;
      const tags = tagsFor(rel);
      const tagsLine = `tags: [${tags.map((t) => JSON.stringify(t)).join(', ')}]\n`;
      const next = `${content.slice(0, fmClose + 1)}${tagsLine}${content.slice(fmClose + 1)}`;
      try {
        await writeFile(abs, next, 'utf8');
        upgraded += 1;
      } catch {
        /* ignore */
      }
    }
  }
  return upgraded;
}

export async function rebuildVaultHubs(
  opts: { db?: Database; vaultRoot?: string } = {},
): Promise<VaultHubsResult> {
  const db = opts.db ?? getDb();
  const vaultRoot = opts.vaultRoot ?? expandHomePath((await loadSettings()).paths.vaultPath);

  if (!(await fileExists(vaultRoot))) {
    return { hubs: [], stubs: [] };
  }

  await upgradeLegacyAutoNotes(vaultRoot);
  const stubs = await writeProjectStubs(vaultRoot, db);

  const folders: Array<{ name: string; out: string }> = [
    { name: 'Concepts', out: 'Concepts/_index.md' },
    { name: 'Sessions', out: 'Sessions/_index.md' },
    { name: 'People', out: 'People/_index.md' },
    { name: 'Projects', out: 'Projects/_index.md' },
  ];
  const hubs: string[] = [];
  for (const f of folders) {
    const absDir = join(vaultRoot, f.name);
    if (!(await fileExists(absDir))) continue;
    const entries = await listMarkdownUnder(absDir, vaultRoot);
    if (entries.length === 0) continue;
    await writeHub(join(vaultRoot, f.out), f.name, entries);
    hubs.push(f.out);
  }

  return { hubs, stubs };
}
