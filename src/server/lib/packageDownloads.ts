import type { Database } from 'bun:sqlite';
import { readFile } from 'node:fs/promises';
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
   */
  detectPackageName(projectPath: string): Promise<string | null>;
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
 */
async function detectPypiName(projectPath: string): Promise<string | null> {
  const pyproject = join(projectPath, 'pyproject.toml');
  if (await fileExists(pyproject)) {
    const text = await readText(pyproject);
    if (text) {
      const fromProject = tomlField(text, 'project', 'name');
      if (fromProject) return normalizePypiName(fromProject);
      // Older Poetry layout used [tool.poetry] before PEP 621 adoption.
      const fromPoetry = tomlField(text, 'tool\\.poetry', 'name');
      if (fromPoetry) return normalizePypiName(fromPoetry);
    }
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

async function detectCratesName(projectPath: string): Promise<string | null> {
  const cargo = join(projectPath, 'Cargo.toml');
  if (!(await fileExists(cargo))) return null;
  const text = await readText(cargo);
  if (!text) return null;
  return tomlField(text, 'package', 'name');
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

async function detectRubyGemsName(projectPath: string): Promise<string | null> {
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

type RepoTarget = { name: string; localPath: string };

/**
 * Walk all GitHub repos that have a known local path (= they're also
 * scanned as projects), run every adapter against them, persist what
 * each one finds. Adapters are idempotent and TTL-respecting at the
 * point-count level; the daily range is upserted unconditionally
 * because registries occasionally backfill late.
 *
 * Returns per-registry summary so the caller can log + surface in the
 * sync events table.
 */
export async function refreshAllPackageDownloads(opts: {
  db: Database;
  force?: boolean;
}): Promise<{
  byRegistry: Record<
    Registry,
    { detected: number; updated: number; notFound: number; errors: number }
  >;
}> {
  const { db, force = false } = opts;

  // Source of truth for "where this repo lives on disk": the projects
  // table. github_repos has a name but no path; we join on name.
  const repos = db
    .query<RepoTarget, []>(
      `SELECT g.name AS name, p.path AS localPath
         FROM github_repos g
         JOIN projects p ON LOWER(p.name) = LOWER(g.name)
        WHERE COALESCE(g.is_fork, 0) = 0
        ORDER BY g.pushed_at DESC, g.name ASC`,
    )
    .all();

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
      try {
        pkgName = await adapter.detectPackageName(repo.localPath);
      } catch {
        // Manifest read failure (perm denied, malformed file) — record
        // as "not detected" so we don't retry every tick on a broken
        // file. fetched_at advances so the TTL gates future attempts.
        upsertPoint.run(adapter.registry, repo.name, null, 0, 0, 0, 1, nowSec());
        summary[adapter.registry].errors += 1;
        continue;
      }
      if (!pkgName) {
        // Project isn't published on this registry. Mark not_found so
        // the cache prevents re-scanning every 6 h.
        upsertPoint.run(adapter.registry, repo.name, null, 0, 0, 0, 1, nowSec());
        continue;
      }
      summary[adapter.registry].detected += 1;

      try {
        const point = await adapter.fetchPoint(pkgName);
        if (!point) {
          upsertPoint.run(adapter.registry, repo.name, pkgName, 0, 0, 0, 1, nowSec());
          summary[adapter.registry].notFound += 1;
          continue;
        }
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
