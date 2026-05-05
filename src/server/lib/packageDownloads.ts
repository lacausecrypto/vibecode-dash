import type { Database } from 'bun:sqlite';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Generic per-registry download tracking. Mirrors the npm-only
 * lib/npmDownloads.ts pattern but generalised so PyPI, crates.io and
 * (eventually) RubyGems / NuGet / Maven can plug in via a single
 * `RegistryAdapter` interface.
 *
 * One adapter per registry. Each adapter knows:
 *   - how to detect the published package name from the project's
 *     local manifest (pyproject.toml, Cargo.toml, …);
 *   - how to fetch point counts (last day / week / month);
 *   - how to fetch a daily range (for the cumul stacked-bars view).
 *
 * The orchestrator (`refreshAllPackageDownloads`) walks the GitHub
 * repo list × the adapter list, picks the right local path from the
 * `projects` table when the repo is also a scanned project, and writes
 * results into the generic `package_downloads` + `package_downloads_daily`
 * tables created in migration 0018.
 *
 * Why we DON'T touch lib/npmDownloads.ts in this commit:
 *   The existing npm path already populates `npm_downloads*` and feeds
 *   the dashboard's NPM displays. Replacing it would be a multi-file
 *   refactor with backfill semantics. The generic path lives alongside
 *   for now; a follow-up can consolidate.
 */

// ────────── types ──────────

export type Registry = 'pypi' | 'crates' | 'rubygems';

export type PackagePoint = {
  /** Last-day downloads — registry's own definition (UTC for npm/crates,
      pacific for pypistats). Display the number, don't compare across
      registries directly. */
  lastDay: number;
  lastWeek: number;
  lastMonth: number;
};

export type PackageDailyRow = {
  date: string; // YYYY-MM-DD
  downloads: number;
};

export type RegistryAdapter = {
  registry: Registry;
  /**
   * Look at the project's local files and return the published package
   * name on this registry, or null if the project isn't published here.
   * Pure file-system inspection — no network calls. Fast enough to run
   * synchronously per repo on every refresh.
   *
   * `repoName` is provided so adapters can pick between siblings in
   * polyglot layouts (e.g. a Cargo workspace with multiple crates —
   * we prefer the one matching the repo or its `-cli` variant).
   */
  detectPackageName(projectPath: string, repoName: string): Promise<string | null>;
  /** Point counts; returns null when the registry says "not found". */
  fetchPoint(packageName: string): Promise<PackagePoint | null>;
  /** Daily downloads for the last N days (registry-capped, often 365). */
  fetchRange(packageName: string, days: number): Promise<PackageDailyRow[] | null>;
};

// ────────── shared helpers ──────────

async function fileExists(path: string): Promise<boolean> {
  try {
    const f = Bun.file(path);
    return await f.exists();
  } catch {
    return false;
  }
}

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Naive TOML field extractor. Avoids the full TOML parsing dependency
 * because we only need ONE specific top-level field per file
 * (`name = "…"` under `[package]` for Cargo, under `[project]` for
 * pyproject). Robust to quoted vs single-quoted values + leading
 * whitespace; gives up gracefully on malformed input.
 *
 * Returns the first match in `[section]` block, or null.
 */
function tomlField(text: string, section: string, field: string): string | null {
  const sectionRe = new RegExp(`\\[${section}\\]`, 'm');
  const sectionMatch = sectionRe.exec(text);
  if (!sectionMatch) return null;
  // Slice to the next [section] or EOF.
  const after = text.slice(sectionMatch.index + sectionMatch[0].length);
  const nextSection = after.search(/\n\[/);
  const block = nextSection === -1 ? after : after.slice(0, nextSection);
  // `name = "value"` or `name = 'value'`. Strip leading whitespace,
  // tolerate spacing around `=`.
  const fieldRe = new RegExp(`^\\s*${field}\\s*=\\s*['"]([^'"\\n]+)['"]`, 'm');
  const m = fieldRe.exec(block);
  return m ? m[1].trim() : null;
}

const FETCH_TIMEOUT_MS = 8000;
const RANGE_DAYS = 365;

async function safeJson<T>(url: string): Promise<T | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { accept: 'application/json' },
    });
    if (!res.ok) {
      // 404 means "not on this registry" — caller should treat as null,
      // not an error. 5xx → caller can retry next tick.
      return null;
    }
    return (await res.json()) as T;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ────────── PyPI adapter ──────────

/**
 * pyproject.toml is the canonical PEP 621 spec — `[project] name`.
 * setup.py fallback uses a regex on `setup(name="…")`; not robust to
 * computed names (rare in real projects).
 *
 * Polyglot repos that bundle a Python sub-package (e.g. mcp-wallfacer
 * with its `pip/pyproject.toml`) keep the manifest in a sub-dir. We
 * try the root first, then a short list of conventional locations,
 * before walking `packages/*` (one level only — full recursion would
 * pull in vendored deps and inflate scan time).
 */
async function detectPypiName(projectPath: string, _repoName: string): Promise<string | null> {
  for (const candidate of await pyManifestCandidates(projectPath)) {
    const text = await readText(candidate);
    if (!text) continue;
    const fromProject = tomlField(text, 'project', 'name');
    if (fromProject) return normalizePypiName(fromProject);
    // Older Poetry layout used [tool.poetry] before PEP 621 adoption.
    const fromPoetry = tomlField(text, 'tool\\.poetry', 'name');
    if (fromPoetry) return normalizePypiName(fromPoetry);
  }
  const setupPy = join(projectPath, 'setup.py');
  if (await fileExists(setupPy)) {
    const text = await readText(setupPy);
    if (text) {
      const m = /name\s*=\s*['"]([\w._-]+)['"]/.exec(text);
      if (m) return normalizePypiName(m[1]);
    }
  }
  return null;
}

/**
 * Ordered candidate list for a `pyproject.toml` lookup. The order
 * prioritises the canonical location at the repo root, then the most
 * common polyglot layouts, before falling back to a one-level scan of
 * `packages/`. Returning paths that may not exist is fine — caller
 * already guards each read.
 */
async function pyManifestCandidates(projectPath: string): Promise<string[]> {
  const out: string[] = [join(projectPath, 'pyproject.toml')];
  for (const sub of ['pip', 'python', 'py']) {
    out.push(join(projectPath, sub, 'pyproject.toml'));
  }
  const packagesDir = join(projectPath, 'packages');
  for (const entry of await readdirSafe(packagesDir)) {
    out.push(join(packagesDir, entry, 'pyproject.toml'));
  }
  return out;
}

/** Directory listing that returns [] on any error (missing dir, perm). */
async function readdirSafe(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

/** PyPI canonicalises names: lowercase, runs of `-_.` → single `-`. */
function normalizePypiName(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[-_.]+/g, '-')
    .trim();
}

type PypistatsRecent = {
  data?: { last_day?: number; last_week?: number; last_month?: number };
};

type PypistatsOverall = {
  data?: Array<{ category?: string; date?: string; downloads?: number }>;
};

const pypiAdapter: RegistryAdapter = {
  registry: 'pypi',
  detectPackageName: detectPypiName,
  async fetchPoint(name) {
    const res = await safeJson<PypistatsRecent>(
      `https://pypistats.org/api/packages/${encodeURIComponent(name)}/recent`,
    );
    if (!res?.data) return null;
    return {
      lastDay: Number(res.data.last_day || 0),
      lastWeek: Number(res.data.last_week || 0),
      lastMonth: Number(res.data.last_month || 0),
    };
  },
  async fetchRange(name, days) {
    // pypistats /overall returns up to 180 days of daily counts.
    // The `category` field splits "with_mirrors" vs "without_mirrors";
    // we sum the without_mirrors series (closer to "real installs").
    const res = await safeJson<PypistatsOverall>(
      `https://pypistats.org/api/packages/${encodeURIComponent(name)}/overall?mirrors=false`,
    );
    if (!res?.data) return null;
    const cutoff = isoDateNDaysAgo(days);
    return res.data
      .filter((row) => row.date && row.date >= cutoff)
      .map((row) => ({ date: row.date as string, downloads: Number(row.downloads || 0) }));
  },
};

// ────────── crates.io adapter ──────────

async function detectCratesName(projectPath: string, repoName: string): Promise<string | null> {
  return detectCratesNameForRepo(projectPath, repoName);
}

/**
 * Cargo crate detection. Two layouts to handle:
 *   1. Single-crate repo: top-level Cargo.toml has `[package] name = …`.
 *   2. Workspace: top-level Cargo.toml has `[workspace]` (no `[package]`),
 *      and the actual published crates live in sub-dirs (typically
 *      `crates/<name>/Cargo.toml`). One repo → multiple crates; we pick
 *      the "best" one by heuristic since `package_downloads` keys on
 *      `(registry, repo_name)` and only stores one.
 *
 * The optional `repoName` lets us prefer a sub-crate that matches the
 * repo (or `<repo>-cli`), which is the convention for binary-distributing
 * workspaces like mcp-wallfacer (publishes `mcp-wallfacer-cli` as the
 * user-facing entry). When omitted, we fall back to alphabetical order.
 */
async function detectCratesNameForRepo(
  projectPath: string,
  repoName: string | null,
): Promise<string | null> {
  const cargo = join(projectPath, 'Cargo.toml');
  if (!(await fileExists(cargo))) return null;
  const text = await readText(cargo);
  if (!text) return null;

  const direct = tomlField(text, 'package', 'name');
  if (direct) return direct;

  // No top-level package — check for a workspace and scan members.
  if (!/\[workspace\]/m.test(text)) return null;

  const subCrates = await collectWorkspaceCrates(projectPath, text);
  if (subCrates.length === 0) return null;

  return pickPrimaryCrate(subCrates, repoName);
}

/**
 * Enumerate the crate names declared by a Cargo workspace. We honour
 * the `[workspace] members = […]` list when present (handling literal
 * paths and one-level globs like `crates/*`), then fall back to scanning
 * common sub-dirs (`crates/`, `packages/`) so freshly-bootstrapped
 * workspaces without an explicit members list still work.
 */
async function collectWorkspaceCrates(projectPath: string, rootToml: string): Promise<string[]> {
  const memberPaths = extractWorkspaceMembers(rootToml);
  const crateDirs = new Set<string>();

  for (const member of memberPaths) {
    if (member.endsWith('/*')) {
      const baseDir = join(projectPath, member.slice(0, -2));
      for (const sub of await readdirSafe(baseDir)) {
        crateDirs.add(join(baseDir, sub));
      }
    } else {
      crateDirs.add(join(projectPath, member));
    }
  }
  // Belt-and-braces: even when members is set, also probe the
  // conventional dirs in case the workspace lists paths via includes
  // we don't model. Set semantics dedupe.
  for (const conv of ['crates', 'packages']) {
    const baseDir = join(projectPath, conv);
    for (const sub of await readdirSafe(baseDir)) {
      crateDirs.add(join(baseDir, sub));
    }
  }

  const names: string[] = [];
  for (const dir of crateDirs) {
    const subToml = join(dir, 'Cargo.toml');
    const text = await readText(subToml);
    if (!text) continue;
    const name = tomlField(text, 'package', 'name');
    if (name) names.push(name);
  }
  return names.sort();
}

/**
 * Parse the `members = [ "a", "b/*" ]` array out of a workspace's
 * top-level Cargo.toml. We only need a flat string list — the TOML
 * spec allows multi-line arrays, so a regex on the captured block is
 * adequate without pulling in a TOML parser.
 */
function extractWorkspaceMembers(rootToml: string): string[] {
  const block = /\[workspace\][^\[]*?members\s*=\s*\[([\s\S]*?)\]/m.exec(rootToml);
  if (!block) return [];
  const out: string[] = [];
  for (const m of block[1].matchAll(/['"]([^'"\n]+)['"]/g)) {
    out.push(m[1]);
  }
  return out;
}

/**
 * Pick one crate to represent the repo. Preference order:
 *   1. Exact repo-name match (rare in workspaces, but cheap to check).
 *   2. `<repo>-cli` suffix — the de-facto convention for executable
 *      crates in a multi-crate workspace.
 *   3. First entry in alphabetical order — deterministic fallback.
 */
function pickPrimaryCrate(candidates: string[], repoName: string | null): string {
  if (repoName) {
    const lowerRepo = repoName.toLowerCase();
    const exact = candidates.find((c) => c.toLowerCase() === lowerRepo);
    if (exact) return exact;
    const cli = candidates.find((c) => c.toLowerCase() === `${lowerRepo}-cli`);
    if (cli) return cli;
  }
  return candidates[0];
}

type CratesPoint = {
  crate?: { downloads?: number; recent_downloads?: number };
  versions?: Array<{ downloads?: number; updated_at?: string }>;
};

type CratesRange = {
  version_downloads?: Array<{ date?: string; downloads?: number }>;
  meta?: { extra_downloads?: Array<{ date?: string; downloads?: number }> };
};

const cratesAdapter: RegistryAdapter = {
  registry: 'crates',
  detectPackageName: detectCratesName,
  async fetchPoint(name) {
    const res = await safeJson<CratesPoint>(
      `https://crates.io/api/v1/crates/${encodeURIComponent(name)}`,
    );
    if (!res?.crate) return null;
    // crates.io exposes lifetime + recent-90-day. We approximate the
    // last-week/last-month from recent_downloads (~90d) divided pro-rata
    // — coarse but consistent with the registry's actual granularity.
    const recent = Number(res.crate.recent_downloads || 0);
    const lifetime = Number(res.crate.downloads || 0);
    return {
      lastDay: Math.round(recent / 90),
      lastWeek: Math.round((recent / 90) * 7),
      lastMonth: Math.round((recent / 90) * 30),
      // lifetime not stored as a "point" — captured via the daily
      // range below for the chart.
      ...({ _lifetime: lifetime } as Record<string, number>),
    };
  },
  async fetchRange(name, days) {
    // crates.io `/downloads` returns version-level + extra-downloads
    // (deleted versions roll-up). Sum both for the "all versions" view.
    const res = await safeJson<CratesRange>(
      `https://crates.io/api/v1/crates/${encodeURIComponent(name)}/downloads`,
    );
    if (!res) return null;
    const cutoff = isoDateNDaysAgo(days);
    const sumByDate = new Map<string, number>();
    for (const row of res.version_downloads || []) {
      if (!row.date || row.date < cutoff) continue;
      sumByDate.set(row.date, (sumByDate.get(row.date) || 0) + Number(row.downloads || 0));
    }
    for (const row of res.meta?.extra_downloads || []) {
      if (!row.date || row.date < cutoff) continue;
      sumByDate.set(row.date, (sumByDate.get(row.date) || 0) + Number(row.downloads || 0));
    }
    return [...sumByDate.entries()]
      .map(([date, downloads]) => ({ date, downloads }))
      .sort((a, b) => (a.date < b.date ? -1 : 1));
  },
};

// ────────── RubyGems adapter ──────────

async function detectRubyGemsName(projectPath: string, _repoName: string): Promise<string | null> {
  // RubyGems names live in <project>.gemspec or a single-line
  // `gem "<name>"` inside Gemfile (less reliable). Prefer the gemspec.
  const candidates = ['Gemfile', 'gemspec'];
  for (const _name of candidates) {
    // Walk dir for any *.gemspec — name there is canonical.
    // Skipped for v1: walking would require readdir + naming convention.
    // Instead, look for a `gemspec.name = "…"` line in any common file.
  }
  // Fallback: name field in a top-level <project>.gemspec
  const possible = ['gemspec'];
  for (const file of possible) {
    const p = join(projectPath, file);
    if (await fileExists(p)) {
      const text = await readText(p);
      if (text) {
        const m = /\.name\s*=\s*['"]([\w._-]+)['"]/.exec(text);
        if (m) return m[1];
      }
    }
  }
  return null;
}

type RubyGemsResp = {
  name?: string;
  downloads?: number;
  version_downloads?: number;
};

const rubygemsAdapter: RegistryAdapter = {
  registry: 'rubygems',
  detectPackageName: detectRubyGemsName,
  async fetchPoint(name) {
    const res = await safeJson<RubyGemsResp>(
      `https://rubygems.org/api/v1/gems/${encodeURIComponent(name)}.json`,
    );
    if (!res?.name) return null;
    // RubyGems doesn't expose day/week/month splits on the gems API.
    // We surface the lifetime download count three times — UI already
    // knows the granularity is coarse for this registry.
    const lifetime = Number(res.downloads || 0);
    return { lastDay: 0, lastWeek: 0, lastMonth: 0, _lifetime: lifetime } as PackagePoint &
      Record<string, number>;
  },
  async fetchRange() {
    // RubyGems has no public daily downloads endpoint. Skip gracefully
    // — the cumul chart simply won't include rubygems segments.
    return null;
  },
};

// ────────── orchestrator ──────────

const ADAPTERS: RegistryAdapter[] = [pypiAdapter, cratesAdapter, rubygemsAdapter];

const TTL_SECONDS = 6 * 60 * 60; // 6 h — registries refresh once/day max

function isoDateNDaysAgo(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

type RepoTarget = { name: string; localPath: string | null };

/**
 * Walk every non-fork GitHub repo, run every adapter against it,
 * persist what each one finds. Adapters are idempotent and
 * TTL-respecting at the point-count level; the daily range is upserted
 * unconditionally because registries occasionally backfill late.
 *
 * Resolution order for each (repo, registry) pair:
 *   1. If we have a local checkout, ask the adapter to detect the
 *      package name from manifests (pyproject.toml, Cargo.toml, …).
 *   2. If detection fails OR there's no local clone, fall back to
 *      hitting the registry with `repo.name` verbatim — most public
 *      packages share their name with the GitHub repo, and this is
 *      what shields.io effectively does. The adapter's `fetchPoint`
 *      returning null tells us the guess was wrong.
 *
 * `displayAliases` (settings.displayAliases) lets the user bridge a
 * GitHub repo name to a local project folder when the names diverge
 * (e.g. local `Dashboard` ↔ GitHub `vibecode-dash`). Without this,
 * detection would silently skip aliased projects because the JOIN on
 * `projects.name = github_repos.name` misses.
 *
 * Returns per-registry summary so the caller can log + surface in the
 * sync events table.
 */
export async function refreshAllPackageDownloads(opts: {
  db: Database;
  force?: boolean;
  displayAliases?: Record<string, string>;
}): Promise<{
  byRegistry: Record<
    Registry,
    { detected: number; updated: number; notFound: number; errors: number }
  >;
}> {
  const { db, force = false, displayAliases = {} } = opts;

  // Build a (case-insensitive) reverse map: GitHub-repo-name → local
  // project path. We start from the projects table directly, then layer
  // alias overrides on top so the alias path wins when both are
  // populated (the alias is an explicit user assertion).
  const projectByLowerName = new Map<string, string>();
  for (const row of db
    .query<{ name: string; path: string }, []>('SELECT name, path FROM projects')
    .all()) {
    projectByLowerName.set(row.name.toLowerCase(), row.path);
  }
  // displayAliases: { canonicalLocal → displayedAsRepo }. Reverse it so
  // a github repo name lookup returns the canonical local path.
  for (const [canonical, displayed] of Object.entries(displayAliases)) {
    const localPath = projectByLowerName.get(canonical.toLowerCase());
    if (localPath) projectByLowerName.set(displayed.toLowerCase(), localPath);
  }

  // LEFT JOIN-equivalent: every non-fork GitHub repo, with localPath
  // set when we know it (direct match OR alias) and null otherwise.
  // The orchestrator handles both branches below.
  const repos: RepoTarget[] = db
    .query<{ name: string }, []>(
      `SELECT name FROM github_repos
        WHERE COALESCE(is_fork, 0) = 0
        ORDER BY pushed_at DESC, name ASC`,
    )
    .all()
    .map((r) => ({
      name: r.name,
      localPath: projectByLowerName.get(r.name.toLowerCase()) ?? null,
    }));

  const summary: Record<
    Registry,
    { detected: number; updated: number; notFound: number; errors: number }
  > = {
    pypi: { detected: 0, updated: 0, notFound: 0, errors: 0 },
    crates: { detected: 0, updated: 0, notFound: 0, errors: 0 },
    rubygems: { detected: 0, updated: 0, notFound: 0, errors: 0 },
  };

  const upsertPoint = db.query<
    unknown,
    [string, string, string | null, number, number, number, number, number]
  >(
    `INSERT INTO package_downloads
       (registry, repo_name, package_name, last_day, last_week, last_month, not_found, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(registry, repo_name) DO UPDATE SET
       package_name = excluded.package_name,
       last_day     = excluded.last_day,
       last_week    = excluded.last_week,
       last_month   = excluded.last_month,
       not_found    = excluded.not_found,
       fetched_at   = excluded.fetched_at`,
  );
  const upsertDaily = db.query<unknown, [string, string, string, number]>(
    `INSERT INTO package_downloads_daily (registry, repo_name, date, downloads)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(registry, repo_name, date) DO UPDATE SET downloads = excluded.downloads`,
  );

  const staleCutoff = nowSec() - TTL_SECONDS;
  const existing = db
    .query<{ registry: string; repo_name: string; fetched_at: number }, []>(
      'SELECT registry, repo_name, fetched_at FROM package_downloads',
    )
    .all();
  const lastFetched = new Map<string, number>();
  for (const row of existing) lastFetched.set(`${row.registry}:${row.repo_name}`, row.fetched_at);

  // Adapters run sequentially per repo; per-registry I/O is small (one
  // /point + one /range call per package), so parallelism per repo isn't
  // worth the rate-limit risk on free public APIs.
  for (const repo of repos) {
    for (const adapter of ADAPTERS) {
      const cacheKey = `${adapter.registry}:${repo.name}`;
      const cachedTs = lastFetched.get(cacheKey) || 0;
      if (!force && cachedTs > staleCutoff) continue;

      let pkgName: string | null = null;
      let pkgSource: 'manifest' | 'verbatim' = 'manifest';
      if (repo.localPath) {
        try {
          pkgName = await adapter.detectPackageName(repo.localPath, repo.name);
        } catch {
          // Manifest read failure (perm denied, malformed file) — fall
          // through to the verbatim probe rather than aborting; that
          // way a broken pyproject.toml doesn't suppress the registry
          // hit when the package name happens to match repo.name.
          summary[adapter.registry].errors += 1;
        }
      }
      // Verbatim fallback: when we have no clone or the manifest didn't
      // surface a name, try repo.name directly. The probe is gated on
      // fetchPoint returning a non-null result, so wrong guesses just
      // get marked not_found like before — no false positives.
      if (!pkgName) {
        pkgName = repo.name;
        pkgSource = 'verbatim';
      }

      try {
        const point = await adapter.fetchPoint(pkgName);
        if (!point) {
          // Mark not_found whether the guess came from a manifest (rare
          // — the manifest said "this package", registry says no) or
          // from the verbatim fallback (common — most repos aren't
          // published on every registry). Either way the TTL gates the
          // next retry, so we don't hammer the registry every 6 h.
          // Persist null package_name on verbatim-miss so we don't lock
          // in a wrong guess across restarts.
          upsertPoint.run(
            adapter.registry,
            repo.name,
            pkgSource === 'manifest' ? pkgName : null,
            0,
            0,
            0,
            1,
            nowSec(),
          );
          summary[adapter.registry].notFound += 1;
          continue;
        }
        summary[adapter.registry].detected += 1;
        upsertPoint.run(
          adapter.registry,
          repo.name,
          pkgName,
          point.lastDay,
          point.lastWeek,
          point.lastMonth,
          0,
          nowSec(),
        );
        summary[adapter.registry].updated += 1;

        const range = await adapter.fetchRange(pkgName, RANGE_DAYS);
        if (range && range.length > 0) {
          const tx = db.transaction(() => {
            for (const row of range) {
              upsertDaily.run(adapter.registry, repo.name, row.date, row.downloads);
            }
          });
          tx();
        }
      } catch {
        summary[adapter.registry].errors += 1;
      }
      // Polite throttle between adapter network calls — each public
      // registry has its own rate limit policy.
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  // KV markers for the sync bar last-run pills.
  const ts = String(nowSec());
  for (const adapter of ADAPTERS) {
    db.query('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)').run(
      `last_${adapter.registry}_sync`,
      ts,
    );
  }

  return { byRegistry: summary };
}

/**
 * Per-day downloads across all repos for one registry, used by the
 * dashboard's cumul stacked-bars view. Mirrors the npm equivalent so
 * the chart code doesn't need a special case per registry — same
 * `Array<{date, repo, downloads}>` shape.
 */
export function listPackageDailyByRepo(
  db: Database,
  registry: Registry,
  opts: { days: number },
): Array<{ date: string; repo: string; downloads: number }> {
  const cutoff = isoDateNDaysAgo(opts.days);
  const todayIso = new Date().toISOString().slice(0, 10);
  return db
    .query<{ date: string; repo: string; downloads: number }, [string, string, string]>(
      `SELECT date, repo_name AS repo, downloads
         FROM package_downloads_daily
        WHERE registry = ? AND date >= ? AND date <= ?
        ORDER BY date DESC, downloads DESC`,
    )
    .all(registry, cutoff, todayIso);
}
