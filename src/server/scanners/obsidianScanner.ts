import type { Database } from 'bun:sqlite';
import { readFile, readdir, stat } from 'node:fs/promises';
import { basename, dirname, extname, join, normalize, posix, relative, resolve } from 'node:path';
import matter from 'gray-matter';
import type { Settings } from '../config';
import { expandHomePath } from '../config';
import { isSubPath } from '../lib/pathGuards';

type RawLink = {
  target: string;
  display: string | null;
};

type ParsedNote = {
  path: string;
  title: string;
  tags: string[];
  frontmatter: Record<string, unknown>;
  modified: number;
  size: number;
  body: string;
  links: RawLink[];
};

type NoteIndex = {
  byPathExact: Map<string, string>;
  byPathLower: Map<string, string>;
  byNoExtLower: Map<string, string>;
  byBasenameLower: Map<string, string[]>;
};

const IGNORED_DIRS = new Set(['.obsidian', '.trash', 'attachments']);

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;

  async function spawn(): Promise<void> {
    while (true) {
      const index = cursor;
      if (index >= items.length) {
        return;
      }
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  }

  const runners = Array.from({ length: Math.min(concurrency, items.length) }, () => spawn());
  await Promise.all(runners);
  return results;
}

function normalizeRelativePath(input: string): string {
  return input.replaceAll('\\', '/').replace(/^\.\//, '').replace(/^\/+/, '');
}

function noExt(path: string): string {
  return path.toLowerCase().replace(/\.md$/i, '');
}

function withMd(path: string): string {
  return /\.md$/i.test(path) ? path : `${path}.md`;
}

function extractInlineTags(content: string): string[] {
  const tags = new Set<string>();
  const pattern = /(^|\s)#([A-Za-z0-9_/-]+)/g;
  for (const match of content.matchAll(pattern)) {
    const tag = match[2]?.trim();
    if (!tag) {
      continue;
    }
    tags.add(tag);
  }
  return [...tags].sort((a, b) => a.localeCompare(b));
}

function extractFrontmatterTags(frontmatter: Record<string, unknown>): string[] {
  const value = frontmatter.tags;
  if (!value) {
    return [];
  }

  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter((item) => item.length > 0);
  }

  if (typeof value === 'string') {
    return value
      .split(/[,\s]+/)
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
  }

  return [];
}

function extractWikilinks(content: string): RawLink[] {
  const links: RawLink[] = [];
  const pattern = /\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|([^\]]+))?\]\]/g;
  for (const match of content.matchAll(pattern)) {
    const target = (match[1] || '').trim();
    if (!target) {
      continue;
    }

    links.push({
      target,
      display: match[2]?.trim() || null,
    });
  }
  return links;
}

function collectFrontmatterStrings(value: unknown, out: string[]): void {
  if (typeof value === 'string') {
    out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectFrontmatterStrings(item, out);
    return;
  }
  if (value && typeof value === 'object') {
    for (const v of Object.values(value)) collectFrontmatterStrings(v, out);
  }
}

function extractFrontmatterWikilinks(frontmatter: Record<string, unknown>): RawLink[] {
  const strings: string[] = [];
  collectFrontmatterStrings(frontmatter, strings);
  return extractWikilinks(strings.join('\n'));
}

function extractTitle(
  frontmatter: Record<string, unknown>,
  content: string,
  notePath: string,
): string {
  if (typeof frontmatter.title === 'string' && frontmatter.title.trim().length > 0) {
    return frontmatter.title.trim();
  }

  const heading = content.match(/^#\s+(.+)$/m);
  if (heading?.[1]) {
    return heading[1].trim();
  }

  return basename(notePath, '.md');
}

async function listMarkdownFiles(vaultRoot: string): Promise<string[]> {
  const out: string[] = [];
  const queue: string[] = [vaultRoot];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) {
      continue;
    }

    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const abs = join(current, entry.name);

      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) {
          continue;
        }
        if (entry.name.startsWith('.')) {
          continue;
        }
        queue.push(abs);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      if (extname(entry.name).toLowerCase() !== '.md') {
        continue;
      }

      const rel = normalizeRelativePath(relative(vaultRoot, abs));
      out.push(rel);
    }
  }

  out.sort((a, b) => a.localeCompare(b));
  return out;
}

async function parseNote(vaultRoot: string, relPath: string): Promise<ParsedNote> {
  const absPath = join(vaultRoot, relPath);
  const [raw, fileStat] = await Promise.all([readFile(absPath, 'utf8'), stat(absPath)]);
  const parsed = matter(raw);

  const frontmatter = (parsed.data || {}) as Record<string, unknown>;
  const body = parsed.content || '';

  const title = extractTitle(frontmatter, body, relPath);
  const inlineTags = extractInlineTags(body);
  const frontmatterTags = extractFrontmatterTags(frontmatter);

  const tags = [...new Set([...frontmatterTags, ...inlineTags])].sort((a, b) => a.localeCompare(b));
  const bodyLinks = extractWikilinks(body);
  const fmLinks = extractFrontmatterWikilinks(frontmatter);
  const seen = new Set<string>();
  const links: RawLink[] = [];
  for (const link of [...bodyLinks, ...fmLinks]) {
    const key = `${link.target}|${link.display || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    links.push(link);
  }

  return {
    path: relPath,
    title,
    tags,
    frontmatter,
    modified: Math.floor(fileStat.mtimeMs / 1000),
    size: fileStat.size,
    body,
    links,
  };
}

function buildIndex(notes: ParsedNote[]): NoteIndex {
  const byPathExact = new Map<string, string>();
  const byPathLower = new Map<string, string>();
  const byNoExtLower = new Map<string, string>();
  const byBasenameLower = new Map<string, string[]>();

  // Case-sensitive lookup always gets all notes — no collisions possible.
  for (const note of notes) {
    byPathExact.set(note.path, note.path);
  }

  // Case-insensitive lookups may have collisions (e.g. Foo/Bar.md vs foo/bar.md
  // coexisting on APFS). On collision, keep the lexicographically smallest
  // path so the resolver is deterministic across scans regardless of readdir
  // order (which is filesystem-dependent and can vary).
  const keepSmaller = (map: Map<string, string>, key: string, candidate: string) => {
    const current = map.get(key);
    if (current === undefined || candidate < current) {
      map.set(key, candidate);
    }
  };

  for (const note of notes) {
    const pathLower = note.path.toLowerCase();
    keepSmaller(byPathLower, pathLower, note.path);
    keepSmaller(byNoExtLower, noExt(note.path), note.path);

    const baseLower = basename(note.path, '.md').toLowerCase();
    const arr = byBasenameLower.get(baseLower) || [];
    arr.push(note.path);
    byBasenameLower.set(baseLower, arr);
  }

  // Sort basename collision arrays so single-match disambiguation is stable.
  for (const arr of byBasenameLower.values()) {
    arr.sort();
  }

  return {
    byPathExact,
    byPathLower,
    byNoExtLower,
    byBasenameLower,
  };
}

function normalizeLinkCandidate(input: string): string {
  const raw = input.trim().replaceAll('\\', '/');
  if (raw.length === 0) {
    return '';
  }

  const cleaned = raw.replace(/^\.\//, '');
  return normalizeRelativePath(posix.normalize(cleaned));
}

function resolveTargetPath(targetRaw: string, sourcePath: string, index: NoteIndex): string | null {
  const sourceDir = normalizeRelativePath(dirname(sourcePath));
  const target = normalizeLinkCandidate(targetRaw);
  if (!target) {
    return null;
  }

  const candidates: string[] = [];

  const direct = target;
  candidates.push(direct);
  candidates.push(withMd(direct));

  if (sourceDir && sourceDir !== '.') {
    const joined = normalizeLinkCandidate(posix.join(sourceDir, target));
    if (joined) {
      candidates.push(joined);
      candidates.push(withMd(joined));
    }
  }

  for (const candidate of candidates) {
    // Case-sensitive first: a wikilink that matches the filename's actual
    // casing should not be overridden by a case-insensitive collision.
    const exact = index.byPathExact.get(candidate) || index.byPathExact.get(withMd(candidate));
    if (exact) {
      return exact;
    }
    const lowered = candidate.toLowerCase();
    const fromPath = index.byPathLower.get(lowered);
    if (fromPath) {
      return fromPath;
    }

    const fromNoExt = index.byNoExtLower.get(noExt(lowered));
    if (fromNoExt) {
      return fromNoExt;
    }
  }

  if (!target.includes('/')) {
    const byBase = index.byBasenameLower.get(noExt(target).toLowerCase()) || [];
    if (byBase.length === 1) {
      return byBase[0];
    }
  }

  return null;
}

function resetTables(db: Database): void {
  db.query('DELETE FROM obsidian_links').run();
  db.query('DELETE FROM obsidian_notes').run();
  db.query('DELETE FROM obsidian_notes_fts').run();
}

export async function reindexObsidianVault(
  db: Database,
  settings: Settings,
): Promise<{
  indexed: number;
  links: number;
  tags: number;
  durationMs: number;
  vaultRoot: string;
  warning?: string;
}> {
  const started = performance.now();

  const vaultRoot = resolve(expandHomePath(settings.paths.vaultPath));
  try {
    const rootStat = await stat(vaultRoot);
    if (!rootStat.isDirectory()) {
      return {
        indexed: 0,
        links: 0,
        tags: 0,
        durationMs: Math.round(performance.now() - started),
        vaultRoot,
        warning: 'vault_path_is_not_directory',
      };
    }
  } catch {
    return {
      indexed: 0,
      links: 0,
      tags: 0,
      durationMs: Math.round(performance.now() - started),
      vaultRoot,
      warning: 'vault_not_found',
    };
  }

  const markdownFiles = await listMarkdownFiles(vaultRoot);
  const parsedNotes = await mapWithConcurrency(markdownFiles, 16, (relPath) =>
    parseNote(vaultRoot, relPath),
  );

  const index = buildIndex(parsedNotes);
  const linksToInsert: Array<{ src: string; dst: string; display: string | null }> = [];

  for (const note of parsedNotes) {
    for (const link of note.links) {
      const resolved = resolveTargetPath(link.target, note.path, index);
      if (!resolved) {
        continue;
      }
      if (resolved === note.path) {
        continue;
      }

      linksToInsert.push({
        src: note.path,
        dst: resolved,
        display: link.display,
      });
    }
  }

  const uniqueLinks = new Map<string, { src: string; dst: string; display: string | null }>();
  for (const edge of linksToInsert) {
    const key = `${edge.src}::${edge.dst}`;
    if (!uniqueLinks.has(key)) {
      uniqueLinks.set(key, edge);
    }
  }

  const insertNote = db.query(`
    INSERT INTO obsidian_notes (path, title, tags_json, frontmatter_json, modified, size, indexed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const insertFts = db.query('INSERT INTO obsidian_notes_fts (path, title, body) VALUES (?, ?, ?)');
  const insertLink = db.query(
    'INSERT OR REPLACE INTO obsidian_links (src, dst, display) VALUES (?, ?, ?)',
  );

  const indexedAt = Math.floor(Date.now() / 1000);

  const transaction = db.transaction(() => {
    resetTables(db);

    for (const note of parsedNotes) {
      insertNote.run(
        note.path,
        note.title,
        JSON.stringify(note.tags),
        JSON.stringify(note.frontmatter),
        note.modified,
        note.size,
        indexedAt,
      );

      insertFts.run(note.path, note.title, note.body);
    }

    for (const edge of uniqueLinks.values()) {
      insertLink.run(edge.src, edge.dst, edge.display);
    }

    db.query('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)').run(
      'last_obsidian_index_at',
      String(indexedAt),
    );
  });

  transaction();

  const tagCount = parsedNotes.reduce((total, note) => total + note.tags.length, 0);

  return {
    indexed: parsedNotes.length,
    links: uniqueLinks.size,
    tags: tagCount,
    durationMs: Math.round(performance.now() - started),
    vaultRoot,
  };
}

export function resolveVaultPath(vaultRoot: string, notePath: string): string {
  const abs = resolve(join(vaultRoot, notePath));
  const root = resolve(vaultRoot);
  if (!isSubPath(abs, root)) {
    throw new Error('Path escapes vault root');
  }
  return abs;
}
