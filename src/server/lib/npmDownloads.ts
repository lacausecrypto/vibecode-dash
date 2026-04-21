import type { Database } from 'bun:sqlite';
import { loadSettings } from '../config';
import { getDb } from '../db';

/**
 * Pull npm download counts for GitHub repos that also publish on npm.
 *
 * Strategy for matching a repo to an npm package name:
 *   1. Try unscoped: `pkg = repo.name`
 *   2. If 404, try scoped: `pkg = @${githubUser}/${repo.name}`
 *   3. If still 404, persist `not_found=1` so we skip next refreshes.
 *
 * Cached rows are re-fetched only when older than TTL, so the browser-facing
 * endpoint can call this eagerly without hammering registry.npmjs.org.
 */

export type NpmDownloadRow = {
  repo_name: string;
  npm_package: string | null;
  last_day: number;
  last_week: number;
  last_month: number;
  not_found: number;
  fetched_at: number;
};

const TTL_SECONDS = 6 * 60 * 60;
const NPM_POINT = 'https://api.npmjs.org/downloads/point';
const NPM_RANGE = 'https://api.npmjs.org/downloads/range';
const RANGE_DAYS = 365;
const CONCURRENCY = 4;
const FETCH_TIMEOUT_MS = 8000;

type NpmPoint = { downloads: number; start: string; end: string; package: string };
type NpmRange = {
  downloads: Array<{ day: string; downloads: number }>;
  start: string;
  end: string;
  package: string;
};
type NpmError = { error: string };

async function fetchPoint(
  pkg: string,
  period: 'last-day' | 'last-week' | 'last-month',
): Promise<number | null> {
  const url = `${NPM_POINT}/${period}/${encodeURIComponent(pkg)}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (res.status === 404) return null;
    if (!res.ok) return 0;
    const body = (await res.json()) as NpmPoint | NpmError;
    if ('error' in body) return null;
    return Number.isFinite(body.downloads) ? body.downloads : 0;
  } catch {
    return 0;
  }
}

async function fetchRange(
  pkg: string,
  days: number,
): Promise<Array<{ date: string; downloads: number }> | null> {
  const end = new Date();
  end.setUTCHours(0, 0, 0, 0);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - (days - 1));
  const startIso = start.toISOString().slice(0, 10);
  const endIso = end.toISOString().slice(0, 10);
  const url = `${NPM_RANGE}/${startIso}:${endIso}/${encodeURIComponent(pkg)}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (res.status === 404) return null;
    if (!res.ok) return null;
    const body = (await res.json()) as NpmRange | NpmError;
    if ('error' in body) return null;
    return body.downloads
      .filter((d) => d && typeof d.day === 'string' && Number.isFinite(d.downloads))
      .map((d) => ({ date: d.day, downloads: d.downloads }));
  } catch {
    return null;
  }
}

async function resolvePackage(
  repoName: string,
  githubUser: string,
): Promise<{ pkg: string; counts: [number, number, number] } | null> {
  const candidates = [
    repoName,
    githubUser ? `@${githubUser.toLowerCase()}/${repoName}` : null,
  ].filter((v): v is string => typeof v === 'string' && v.length > 0);

  for (const pkg of candidates) {
    const day = await fetchPoint(pkg, 'last-day');
    if (day === null) continue;
    const [week, month] = await Promise.all([
      fetchPoint(pkg, 'last-week'),
      fetchPoint(pkg, 'last-month'),
    ]);
    return { pkg, counts: [day, week ?? 0, month ?? 0] };
  }
  return null;
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

// Module-level inflight lock: prevents auto + manual refresh from hitting
// npm's CF-rate-limited range endpoint in parallel, which compounds the
// 400ms-between-calls backoff and historically triggered hangs. Concurrent
// callers share the in-flight promise so only one pass hits the network.
let refreshInflight: Promise<{ updated: number; notFound: number; skipped: number }> | null = null;

export async function refreshNpmDownloads(
  opts: { db?: Database; force?: boolean } = {},
): Promise<{ updated: number; notFound: number; skipped: number }> {
  if (refreshInflight) return refreshInflight;
  refreshInflight = runRefresh(opts).finally(() => {
    refreshInflight = null;
  });
  return refreshInflight;
}

async function runRefresh(opts: { db?: Database; force?: boolean }): Promise<{
  updated: number;
  notFound: number;
  skipped: number;
}> {
  const db = opts.db ?? getDb();
  const settings = await loadSettings();
  const githubUser = settings.github.username || '';

  const repos = db.query<{ name: string }, []>('SELECT name FROM github_repos').all();
  const existing = new Map(
    db
      .query<NpmDownloadRow, []>('SELECT * FROM npm_downloads')
      .all()
      .map((row) => [row.repo_name, row]),
  );

  const staleCutoff = nowSec() - TTL_SECONDS;
  const targets = repos.filter((r) => {
    if (opts.force) return true;
    const cur = existing.get(r.name);
    if (!cur) return true;
    return cur.fetched_at < staleCutoff;
  });

  const upsert = db.query<unknown, [string, string | null, number, number, number, number, number]>(
    `INSERT INTO npm_downloads (repo_name, npm_package, last_day, last_week, last_month, not_found, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(repo_name) DO UPDATE SET
       npm_package = excluded.npm_package,
       last_day = excluded.last_day,
       last_week = excluded.last_week,
       last_month = excluded.last_month,
       not_found = excluded.not_found,
       fetched_at = excluded.fetched_at`,
  );

  let updated = 0;
  let notFound = 0;
  const skipped = repos.length - targets.length;

  const upsertDaily = db.query<unknown, [string, string, number]>(
    `INSERT INTO npm_downloads_daily (repo_name, date, downloads)
     VALUES (?, ?, ?)
     ON CONFLICT(repo_name, date) DO UPDATE SET downloads = excluded.downloads`,
  );

  // Phase 1: resolve + point counts (fan-out, light endpoint).
  const resolvedTargets: Array<{ name: string; pkg: string }> = [];
  const queue = [...targets];
  async function worker(): Promise<void> {
    while (queue.length > 0) {
      const target = queue.shift();
      if (!target) return;
      const resolved = await resolvePackage(target.name, githubUser);
      const ts = nowSec();
      if (resolved) {
        upsert.run(
          target.name,
          resolved.pkg,
          resolved.counts[0],
          resolved.counts[1],
          resolved.counts[2],
          0,
          ts,
        );
        updated += 1;
        resolvedTargets.push({ name: target.name, pkg: resolved.pkg });
      } else {
        upsert.run(target.name, null, 0, 0, 0, 1, ts);
        notFound += 1;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, targets.length) }, () => worker()));

  // Phase 2: range backfill — serialized + delayed. npm's range endpoint is
  // CF-rate-limited more aggressively than point, so 1 at a time with a short
  // pause is the polite default. Silent fail → cumul_local falls back to
  // last_month via the listNpmStats coalesce.
  for (const { name, pkg } of resolvedTargets) {
    const range = await fetchRange(pkg, RANGE_DAYS);
    if (range && range.length > 0) {
      const tx = db.transaction(() => {
        for (const row of range) upsertDaily.run(name, row.date, row.downloads);
      });
      tx();
    }
    await new Promise((r) => setTimeout(r, 400));
  }

  return { updated, notFound, skipped };
}

export type NpmStats = {
  totals: {
    last_day: number;
    last_week: number;
    last_month: number;
    /** Sum of every daily row we have locally backfilled (≤ 365d per package). */
    cumul_local: number;
    /** How many days of daily history cover the cumul. Informs the UI. */
    cumul_days: number;
  };
  published: Array<{
    repo_name: string;
    npm_package: string;
    last_day: number;
    last_week: number;
    last_month: number;
    cumul_local: number;
  }>;
  notPublishedCount: number;
  notFetchedCount: number;
  lastFetchedAt: number | null;
};

export function listNpmDaily(
  db: Database = getDb(),
  opts: { from?: string; to?: string } = {},
): Array<{ date: string; downloads: number }> {
  const from = opts.from || '1900-01-01';
  const to = opts.to || '9999-12-31';
  return db
    .query<{ date: string; downloads: number }, [string, string]>(
      `SELECT date, COALESCE(SUM(downloads), 0) AS downloads
       FROM npm_downloads_daily
       WHERE date >= ? AND date <= ?
       GROUP BY date
       ORDER BY date ASC`,
    )
    .all(from, to);
}

export function listNpmStats(db: Database = getDb()): NpmStats {
  const rows = db.query<NpmDownloadRow, []>('SELECT * FROM npm_downloads').all();
  const totalRepos =
    db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM github_repos').get()?.n ?? 0;

  const cumulByRepo = new Map<string, number>();
  for (const r of db
    .query<{ repo_name: string; total: number }, []>(
      'SELECT repo_name, COALESCE(SUM(downloads), 0) AS total FROM npm_downloads_daily GROUP BY repo_name',
    )
    .all()) {
    cumulByRepo.set(r.repo_name, r.total);
  }

  const cumulDays =
    db.query<{ n: number }, []>('SELECT COUNT(DISTINCT date) AS n FROM npm_downloads_daily').get()
      ?.n ?? 0;

  const published = rows
    .filter((r) => r.not_found === 0 && r.npm_package)
    .map((r) => ({
      repo_name: r.repo_name,
      npm_package: r.npm_package as string,
      last_day: r.last_day,
      last_week: r.last_week,
      last_month: r.last_month,
      cumul_local: cumulByRepo.get(r.repo_name) ?? r.last_month,
    }))
    .sort((a, b) => b.cumul_local - a.cumul_local);

  const totals = published.reduce(
    (acc, r) => {
      acc.last_day += r.last_day;
      acc.last_week += r.last_week;
      acc.last_month += r.last_month;
      acc.cumul_local += r.cumul_local;
      return acc;
    },
    { last_day: 0, last_week: 0, last_month: 0, cumul_local: 0, cumul_days: cumulDays },
  );

  const notPublishedCount = rows.filter((r) => r.not_found === 1).length;
  const notFetchedCount = Math.max(0, totalRepos - rows.length);
  const lastFetchedAt =
    rows.reduce((max, r) => (r.fetched_at > max ? r.fetched_at : max), 0) || null;

  return { totals, published, notPublishedCount, notFetchedCount, lastFetchedAt };
}
