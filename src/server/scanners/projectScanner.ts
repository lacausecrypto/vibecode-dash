import type { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';
import type { Settings } from '../config';
import { expandHomePath } from '../config';

type ProjectType = 'node' | 'python' | 'rust' | 'go' | 'git' | 'mixed' | 'generic';

type GitMeta = {
  branch: string | null;
  remote: string | null;
  lastCommitAt: number | null;
  uncommitted: number;
};

type LanguageStats = {
  loc: number;
  byExt: Record<string, number>;
};

type ScanResult = {
  id: string;
  path: string;
  name: string;
  type: ProjectType;
  description: string | null;
  readmePath: string | null;
  lastModified: number;
  git: GitMeta;
  languageStats: LanguageStats;
  healthScore: number;
  healthBreakdown: HealthBreakdown;
  scannedAt: number;
};

const IGNORED_DIRS = new Set([
  '.git',
  'node_modules',
  '.next',
  '.turbo',
  '.idea',
  '.vscode',
  'dist',
  'build',
  '.venv',
  'venv',
  'target',
]);

const CODE_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.py',
  '.rs',
  '.go',
  '.java',
  '.swift',
  '.kt',
  '.md',
  '.json',
  '.yml',
  '.yaml',
  '.toml',
]);

const PROJECT_MARKERS = [
  'package.json',
  'pyproject.toml',
  'requirements.txt',
  'setup.py',
  'Cargo.toml',
  'go.mod',
  '.git',
];

function hashId(value: string): string {
  return createHash('sha1').update(value).digest('hex');
}

async function dirExists(path: string): Promise<boolean> {
  try {
    const s = await stat(path);
    return s.isDirectory();
  } catch {
    return false;
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    const s = await stat(path);
    return s.isFile();
  } catch {
    return false;
  }
}

async function listCandidateProjects(root: string): Promise<string[]> {
  if (!(await dirExists(root))) {
    return [];
  }

  const out: string[] = [];

  // If the root itself carries a marker, treat it as a single-project root.
  // Lets the user paste either a parent dir (`~/dev`) or a project dir
  // (`~/dev/mcp-conduit`) without caring about the distinction.
  for (const marker of PROJECT_MARKERS) {
    if (existsSync(join(root, marker))) {
      out.push(root);
      break;
    }
  }

  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    if (entry.name.startsWith('.')) {
      continue;
    }

    const full = join(root, entry.name);

    for (const marker of PROJECT_MARKERS) {
      if (existsSync(join(full, marker))) {
        out.push(full);
        break;
      }
    }
  }

  return out;
}

async function detectProjectType(path: string): Promise<ProjectType> {
  const matches: ProjectType[] = [];

  if (await fileExists(join(path, 'package.json'))) {
    matches.push('node');
  }

  if (
    (await fileExists(join(path, 'pyproject.toml'))) ||
    (await fileExists(join(path, 'requirements.txt'))) ||
    (await fileExists(join(path, 'setup.py')))
  ) {
    matches.push('python');
  }

  if (await fileExists(join(path, 'Cargo.toml'))) {
    matches.push('rust');
  }

  if (await fileExists(join(path, 'go.mod'))) {
    matches.push('go');
  }

  if (await dirExists(join(path, '.git'))) {
    matches.push('git');
  }

  const unique = [...new Set(matches)];
  if (unique.length === 0) {
    return 'generic';
  }
  if (unique.length === 1) {
    return unique[0] as ProjectType;
  }
  return 'mixed';
}

async function readPackageDescription(path: string): Promise<string | null> {
  const packagePath = join(path, 'package.json');
  if (!(await fileExists(packagePath))) {
    return null;
  }

  try {
    const raw = await readFile(packagePath, 'utf8');
    const parsed = JSON.parse(raw) as { description?: string };
    return parsed.description?.trim() || null;
  } catch {
    return null;
  }
}

async function readReadmeExcerpt(
  path: string,
): Promise<{ excerpt: string | null; readmePath: string | null }> {
  const candidates = ['README.md', 'readme.md', 'README.MD'];
  for (const file of candidates) {
    const full = join(path, file);
    if (!(await fileExists(full))) {
      continue;
    }

    try {
      const raw = await readFile(full, 'utf8');
      const lines = raw
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
      const excerpt = lines.find((line) => !line.startsWith('#')) || lines[0] || null;
      return { excerpt, readmePath: full };
    } catch {
      return { excerpt: null, readmePath: full };
    }
  }

  return { excerpt: null, readmePath: null };
}

async function runCommand(args: string[], cwd: string): Promise<string | null> {
  const proc = Bun.spawn(args, { cwd, stdout: 'pipe', stderr: 'ignore' });
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  if (code !== 0) {
    return null;
  }
  return out.trim();
}

async function getGitMeta(path: string): Promise<GitMeta> {
  if (!(await dirExists(join(path, '.git')))) {
    return {
      branch: null,
      remote: null,
      lastCommitAt: null,
      uncommitted: 0,
    };
  }

  const [branch, remote, lastCommitRaw, status] = await Promise.all([
    runCommand(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], path),
    runCommand(['git', 'config', '--get', 'remote.origin.url'], path),
    runCommand(['git', 'log', '-1', '--format=%ct'], path),
    runCommand(['git', 'status', '--porcelain'], path),
  ]);

  const uncommitted = status ? status.split('\n').filter((line) => line.length > 0).length : 0;

  return {
    branch,
    remote,
    lastCommitAt: lastCommitRaw ? Number.parseInt(lastCommitRaw, 10) : null,
    uncommitted,
  };
}

async function walkFiles(
  root: string,
  callback: (filePath: string, depth: number) => Promise<void> | void,
  maxDepth = 4,
): Promise<void> {
  const queue: Array<{ path: string; depth: number }> = [{ path: root, depth: 0 }];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) {
      break;
    }

    const entries = await readdir(current.path, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.')) {
        continue;
      }

      const full = join(current.path, entry.name);
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) {
          continue;
        }
        if (current.depth + 1 <= maxDepth) {
          queue.push({ path: full, depth: current.depth + 1 });
        }
        continue;
      }

      if (entry.isFile()) {
        await callback(full, current.depth);
      }
    }
  }
}

async function countLines(path: string): Promise<number> {
  try {
    const text = await readFile(path, 'utf8');
    if (text.length === 0) {
      return 0;
    }
    return text.split('\n').length;
  } catch {
    return 0;
  }
}

async function computeLanguageStats(path: string): Promise<LanguageStats> {
  const byExt: Record<string, number> = {};
  let loc = 0;
  let processed = 0;

  await walkFiles(
    path,
    async (file) => {
      if (processed > 1800) {
        return;
      }

      const ext = extname(file).toLowerCase();
      if (!CODE_EXTENSIONS.has(ext)) {
        return;
      }

      const lines = await countLines(file);
      if (lines === 0) {
        return;
      }

      loc += lines;
      byExt[ext.slice(1) || 'unknown'] = (byExt[ext.slice(1) || 'unknown'] || 0) + lines;
      processed += 1;
    },
    5,
  );

  return { loc, byExt };
}

async function computeLastModified(path: string): Promise<number> {
  let max = 0;
  await walkFiles(
    path,
    async (file, depth) => {
      if (depth > 2) {
        return;
      }
      try {
        const s = await stat(file);
        const m = Math.floor(s.mtimeMs / 1000);
        if (m > max) {
          max = m;
        }
      } catch {
        // ignore unreadable files
      }
    },
    2,
  );

  if (max > 0) {
    return max;
  }

  const rootStat = await stat(path);
  return Math.floor(rootStat.mtimeMs / 1000);
}

async function hasTests(path: string): Promise<boolean> {
  const testDirs = ['test', 'tests', '__tests__'];
  for (const dir of testDirs) {
    if (await dirExists(join(path, dir))) {
      return true;
    }
  }

  let found = false;
  await walkFiles(
    path,
    async (file) => {
      if (/\.(test|spec)\.[^.]+$/i.test(file)) {
        found = true;
      }
    },
    4,
  );

  return found;
}

async function hasCi(path: string): Promise<boolean> {
  if (await dirExists(join(path, '.github', 'workflows'))) {
    return true;
  }
  if (await fileExists(join(path, '.gitlab-ci.yml'))) {
    return true;
  }
  return false;
}

async function lockfileFresh(path: string): Promise<boolean> {
  const pairs: Array<{ manifest: string; lock: string }> = [
    { manifest: 'package.json', lock: 'bun.lock' },
    { manifest: 'package.json', lock: 'package-lock.json' },
    { manifest: 'package.json', lock: 'pnpm-lock.yaml' },
    { manifest: 'package.json', lock: 'yarn.lock' },
    { manifest: 'pyproject.toml', lock: 'poetry.lock' },
  ];

  for (const pair of pairs) {
    const manifestPath = join(path, pair.manifest);
    const lockPath = join(path, pair.lock);

    if (!(await fileExists(manifestPath)) || !(await fileExists(lockPath))) {
      continue;
    }

    const [manifestStat, lockStat] = await Promise.all([stat(manifestPath), stat(lockPath)]);
    return lockStat.mtimeMs >= manifestStat.mtimeMs;
  }

  return false;
}

/**
 * Health score — decomposed & honest.
 *
 * 6 independent factors, each bounded [0..1], weighted sum = final score 0..100.
 * We return the full breakdown so the UI can show WHY a project scores what it
 * scores. No arbitrary clamping, no hidden penalties.
 *
 * Design rationale per factor:
 *  - `documentation` — README presence + depth proxies (lines, sections).
 *  - `tests`         — test artifacts present; best-effort, no coverage parsing.
 *  - `ci`            — pipeline config present.
 *  - `activity`      — commit recency, **asymétrique** : mature libs plafonnent
 *                      à 0.7 sans jamais être pénalisés en-dessous de ça ; seuls
 *                      les projets > 1 an passent sous 0.3. Evite de punir Flask.
 *  - `hygiene`       — uncommitted en **ratio** files tracked, lockfile frais.
 *  - `structure`     — markers dev-hygiene (LICENSE, .gitignore, CHANGELOG).
 *
 * Absent signals (indeterminate → 0 contribution but weight NOT removed — being
 * conservative: no README means no documentation score, period). Exception :
 * `activity` si pas de git du tout → weight redistributed across others.
 */
export type HealthFactor = {
  weight: number;
  value: number; // [0..1]
  label: string;
  reason: string;
};

export type HealthBreakdown = {
  factors: Record<string, HealthFactor>;
  score: number; // [0..100], rounded
};

async function computeDocumentationFactor(
  readmePath: string | null,
): Promise<{ value: number; reason: string }> {
  if (!readmePath) return { value: 0, reason: 'no README' };
  try {
    const body = await readFile(readmePath, 'utf8');
    const lines = body.split('\n').length;
    const headings = (body.match(/^#{1,6}\s+/gm) || []).length;
    const codeBlocks = (body.match(/```/g) || []).length / 2;

    // Presence baseline: 0.4. Depth climbs with lines, headings, code blocks.
    let v = 0.4;
    v += Math.min(0.3, lines / 200); // 200 lines → full credit
    v += Math.min(0.15, headings / 6); // 6 headings → full credit
    v += Math.min(0.15, codeBlocks / 4); // 4 code blocks → full credit
    return {
      value: Math.min(1, v),
      reason: `${lines} lines · ${headings} headings · ${Math.floor(codeBlocks)} code blocks`,
    };
  } catch {
    return { value: 0.4, reason: 'README present but unreadable' };
  }
}

async function computeTestsFactor(path: string): Promise<{ value: number; reason: string }> {
  const testDirs = ['test', 'tests', '__tests__'];
  let dirHit = false;
  for (const dir of testDirs) {
    if (await dirExists(join(path, dir))) {
      dirHit = true;
      break;
    }
  }

  let testFileCount = 0;
  let srcFileCount = 0;
  await walkFiles(
    path,
    async (file) => {
      if (/\.(test|spec)\.[^.]+$/i.test(file)) testFileCount += 1;
      else if (/\.(ts|tsx|js|jsx|py|rs|go)$/i.test(file)) srcFileCount += 1;
    },
    4,
  );

  if (!dirHit && testFileCount === 0) return { value: 0, reason: 'no tests found' };

  // Ratio of test files to src files. Cap at 0.3 (healthy projects rarely exceed).
  const ratio = srcFileCount > 0 ? Math.min(0.3, testFileCount / srcFileCount) / 0.3 : 0;
  // Baseline 0.6 for presence, +0.4 for ratio.
  const value = Math.min(1, 0.6 + ratio * 0.4);
  return { value, reason: `${testFileCount} test files · ${srcFileCount} src files` };
}

async function computeCiFactor(path: string): Promise<{ value: number; reason: string }> {
  if (await dirExists(join(path, '.github', 'workflows'))) {
    return { value: 1, reason: 'GitHub Actions configured' };
  }
  if (await fileExists(join(path, '.gitlab-ci.yml'))) {
    return { value: 1, reason: 'GitLab CI configured' };
  }
  if (await fileExists(join(path, '.circleci', 'config.yml'))) {
    return { value: 1, reason: 'CircleCI configured' };
  }
  return { value: 0, reason: 'no CI pipeline detected' };
}

function computeActivityFactor(git: GitMeta): {
  value: number;
  reason: string;
  included: boolean;
} {
  if (!git.lastCommitAt) {
    return { value: 0, reason: 'no git history', included: false };
  }
  const days = (Date.now() / 1000 - git.lastCommitAt) / 86400;
  // Piecewise: ≤7d=1.0, ≤30d=0.9, ≤90d=0.7, ≤365d=0.5, ≤730d=0.3, >730d=0.1
  // Rationale: mature stable libs (~90d between commits) deserve ≥0.7, not 0.
  let value: number;
  if (days <= 7) value = 1;
  else if (days <= 30) value = 0.9;
  else if (days <= 90) value = 0.7;
  else if (days <= 365) value = 0.5;
  else if (days <= 730) value = 0.3;
  else value = 0.1;
  return {
    value,
    reason: `last commit ${Math.floor(days)}d ago`,
    included: true,
  };
}

async function computeHygieneFactor(
  path: string,
  git: GitMeta,
  loc: number,
): Promise<{ value: number; reason: string }> {
  // Uncommitted as ratio (heuristic: 1 LOC ≈ 1 tracked file is absurd, use sqrt(loc)
  // as a rough proxy for "size class"). Avoids penalising big monorepos for 20 files.
  const sizeClass = Math.max(1, Math.sqrt(loc));
  const uncommittedRatio = Math.min(1, git.uncommitted / sizeClass);
  const uncommittedScore = 1 - uncommittedRatio; // fewer uncommitted = better

  const lockFresh = await lockfileFresh(path);
  const lockPart = lockFresh ? 1 : 0.5; // no lock isn't a sin, just unknown

  const value = 0.6 * uncommittedScore + 0.4 * lockPart;
  return {
    value,
    reason: `${git.uncommitted} uncommitted · lock ${lockFresh ? 'fresh' : 'unknown/stale'}`,
  };
}

async function computeStructureFactor(path: string): Promise<{ value: number; reason: string }> {
  const markers = [
    { name: 'LICENSE', weight: 0.35 },
    { name: 'LICENSE.md', weight: 0.35 },
    { name: 'LICENSE.txt', weight: 0.35 },
    { name: '.gitignore', weight: 0.3 },
    { name: 'CHANGELOG.md', weight: 0.2 },
    { name: 'CONTRIBUTING.md', weight: 0.15 },
  ];
  const hits: string[] = [];
  let value = 0;
  const licenseSeen = new Set<string>();
  for (const m of markers) {
    const key = m.name.split('.')[0].toUpperCase();
    if (licenseSeen.has(key)) continue; // avoid double-counting LICENSE variants
    if (await fileExists(join(path, m.name))) {
      licenseSeen.add(key);
      value += m.weight;
      hits.push(m.name);
    }
  }
  return { value: Math.min(1, value), reason: hits.length > 0 ? hits.join(' · ') : 'no markers' };
}

export async function computeHealthBreakdown(
  path: string,
  git: GitMeta,
  readmePath: string | null,
  loc: number,
): Promise<HealthBreakdown> {
  const [doc, tests, ci, hygiene, structure] = await Promise.all([
    computeDocumentationFactor(readmePath),
    computeTestsFactor(path),
    computeCiFactor(path),
    computeHygieneFactor(path, git, loc),
    computeStructureFactor(path),
  ]);
  const activity = computeActivityFactor(git);

  // Base weights — they sum to 1.0.
  const baseWeights = {
    documentation: 0.2,
    tests: 0.15,
    ci: 0.1,
    activity: 0.25,
    hygiene: 0.15,
    structure: 0.15,
  };

  // If activity can't be evaluated (no git), redistribute its weight proportionally
  // so the final score stays on a 0..100 scale honestly.
  const weights = { ...baseWeights };
  if (!activity.included) {
    const lost = weights.activity;
    weights.activity = 0;
    const sum = Object.values(weights).reduce((a, b) => a + b, 0);
    const factor = (sum + lost) / sum;
    for (const k of Object.keys(weights) as Array<keyof typeof weights>) {
      weights[k] *= factor;
    }
  }

  const factors: Record<string, HealthFactor> = {
    documentation: {
      weight: weights.documentation,
      value: doc.value,
      label: 'Documentation',
      reason: doc.reason,
    },
    tests: { weight: weights.tests, value: tests.value, label: 'Tests', reason: tests.reason },
    ci: { weight: weights.ci, value: ci.value, label: 'CI', reason: ci.reason },
    activity: {
      weight: weights.activity,
      value: activity.value,
      label: 'Activity',
      reason: activity.reason,
    },
    hygiene: {
      weight: weights.hygiene,
      value: hygiene.value,
      label: 'Hygiene',
      reason: hygiene.reason,
    },
    structure: {
      weight: weights.structure,
      value: structure.value,
      label: 'Structure',
      reason: structure.reason,
    },
  };

  let score = 0;
  for (const f of Object.values(factors)) {
    score += f.weight * f.value;
  }

  return { factors, score: Math.round(score * 100) };
}

export async function scanProject(path: string): Promise<ScanResult> {
  const [type, packageDescription, readmeData, git, languageStats, lastModified] =
    await Promise.all([
      detectProjectType(path),
      readPackageDescription(path),
      readReadmeExcerpt(path),
      getGitMeta(path),
      computeLanguageStats(path),
      computeLastModified(path),
    ]);

  const scannedAt = Math.floor(Date.now() / 1000);
  const healthBreakdown = await computeHealthBreakdown(
    path,
    git,
    readmeData.readmePath,
    languageStats.loc,
  );

  return {
    id: hashId(path),
    path,
    name: basename(path),
    type,
    description: packageDescription || readmeData.excerpt,
    readmePath: readmeData.readmePath,
    lastModified,
    git,
    languageStats,
    healthScore: healthBreakdown.score,
    healthBreakdown,
    scannedAt,
  };
}

function upsertProject(db: Database, project: ScanResult): void {
  const stmt = db.query(`
    INSERT INTO projects (
      id, path, name, type, description, readme_path, last_modified, git_branch,
      git_remote, last_commit_at, uncommitted, loc, languages_json, health_score,
      health_breakdown_json, scanned_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      path = excluded.path,
      name = excluded.name,
      type = excluded.type,
      description = excluded.description,
      readme_path = excluded.readme_path,
      last_modified = excluded.last_modified,
      git_branch = excluded.git_branch,
      git_remote = excluded.git_remote,
      last_commit_at = excluded.last_commit_at,
      uncommitted = excluded.uncommitted,
      loc = excluded.loc,
      languages_json = excluded.languages_json,
      health_score = excluded.health_score,
      health_breakdown_json = excluded.health_breakdown_json,
      scanned_at = excluded.scanned_at
  `);

  stmt.run(
    project.id,
    project.path,
    project.name,
    project.type,
    project.description,
    project.readmePath,
    project.lastModified,
    project.git.branch,
    project.git.remote,
    project.git.lastCommitAt,
    project.git.uncommitted,
    project.languageStats.loc,
    JSON.stringify(project.languageStats.byExt),
    project.healthScore,
    JSON.stringify(project.healthBreakdown),
    project.scannedAt,
  );
}

export type ScanRootReport = {
  input: string;
  resolved: string;
  exists: boolean;
  candidates: number;
  error?: string;
};

export async function scanAllProjects(
  db: Database,
  settings: Settings,
): Promise<{
  scanned: number;
  durationMs: number;
  roots: ScanRootReport[];
}> {
  const started = performance.now();

  const roots = settings.paths.projectsRoots;
  const excluded = new Set(
    (settings.paths.excludedProjects || []).map((p) => resolve(expandHomePath(p))),
  );
  const perRoot: ScanRootReport[] = [];
  const allCandidates: string[] = [];

  for (const input of roots) {
    const resolvedRoot = expandHomePath(input);
    const exists = await dirExists(resolvedRoot);
    if (!exists) {
      perRoot.push({ input, resolved: resolvedRoot, exists: false, candidates: 0 });
      continue;
    }
    try {
      const found = await listCandidateProjects(resolvedRoot);
      const candidates = found.filter((p) => !excluded.has(resolve(p)));
      allCandidates.push(...candidates);
      perRoot.push({
        input,
        resolved: resolvedRoot,
        exists: true,
        candidates: candidates.length,
      });
    } catch (error) {
      perRoot.push({
        input,
        resolved: resolvedRoot,
        exists: true,
        candidates: 0,
        error: String(error),
      });
    }
  }

  const seen = new Set<string>();
  let scanned = 0;

  for (const candidate of allCandidates) {
    if (seen.has(candidate)) {
      continue;
    }
    seen.add(candidate);

    try {
      const result = await scanProject(candidate);
      upsertProject(db, result);
      scanned += 1;
    } catch {
      // keep scan resilient
    }
  }

  if (allCandidates.length > 0) {
    const deleteStmt = db.query('DELETE FROM projects WHERE path = ?');
    const existing = db.query<{ path: string }, []>('SELECT path FROM projects').all();
    for (const row of existing) {
      if (!seen.has(row.path)) {
        deleteStmt.run(row.path);
      }
    }
  }

  const setKv = db.query('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)');
  setKv.run('last_scan_at', String(Math.floor(Date.now() / 1000)));

  return {
    scanned,
    durationMs: Math.round(performance.now() - started),
    roots: perRoot,
  };
}

export async function scanProjectById(
  db: Database,
  projectId: string,
): Promise<Record<string, unknown> | null> {
  const row = db
    .query<{ path: string }, [string]>('SELECT path FROM projects WHERE id = ? LIMIT 1')
    .get(projectId);

  if (!row) {
    return null;
  }

  const result = await scanProject(row.path);
  upsertProject(db, result);

  return db.query('SELECT * FROM projects WHERE id = ?').get(projectId) as Record<string, unknown>;
}

export async function buildProjectTree(path: string, depth = 2): Promise<Record<string, unknown>> {
  async function walk(currentPath: string, currentDepth: number): Promise<Record<string, unknown>> {
    const entries = await readdir(currentPath, { withFileTypes: true });
    const children: Record<string, unknown>[] = [];

    for (const entry of entries) {
      if (entry.name.startsWith('.')) {
        continue;
      }
      if (IGNORED_DIRS.has(entry.name)) {
        continue;
      }

      const fullPath = join(currentPath, entry.name);
      if (entry.isDirectory()) {
        if (currentDepth < depth) {
          children.push(await walk(fullPath, currentDepth + 1));
        } else {
          children.push({ name: entry.name, type: 'directory' });
        }
      } else {
        children.push({ name: entry.name, type: 'file' });
      }
    }

    return {
      name: basename(currentPath),
      path: currentPath,
      type: 'directory',
      children,
    };
  }

  return walk(path, 0);
}
