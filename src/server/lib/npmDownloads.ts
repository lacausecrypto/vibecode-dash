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

// Unused — npm responses are now parsed as `unknown` and shape-checked at
// runtime. See fetchPoint() / fetchRange() for the validation.

async function fetchPoint(
  pkg: string,
  period: 'last-day' | 'last-week' | 'last-month',
): Promise<number | null> {
  const url = `${NPM_POINT}/${period}/${encodeURIComponent(pkg)}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (res.status === 404) return null;
    if (!res.ok) return 0;
    const body = (await res.json()) as unknown;
    if (!body || typeof body !== 'object') return 0;
    const record = body as Record<string, unknown>;
    if ('error' in record) return null;
    const count = record.downloads;
    // Guard against string returns (observed on proxied caches) and negatives.
    return typeof count === 'number' && Number.isFinite(count) && count >= 0 ? count : 0;
  } catch {
    return 0;
  }
}

// Distinguish between "upstream said package doesn't exist" (permanent skip)
// and "network/rate-limit failure" (transient — caller should track so the UI
// can flag stale cumul_local data).
type FetchRangeResult =
  | { kind: 'ok'; points: Array<{ date: string; downloads: number }> }
  | { kind: 'not_found' }
  | { kind: 'error'; reason: string };

async function fetchRange(pkg: string, days: number): Promise<FetchRangeResult> {
  const end = new Date();
  end.setUTCHours(0, 0, 0, 0);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - (days - 1));
  const startIso = start.toISOString().slice(0, 10);
  const endIso = end.toISOString().slice(0, 10);
  const url = `${NPM_RANGE}/${startIso}:${endIso}/${encodeURIComponent(pkg)}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (res.status === 404) return { kind: 'not_found' };
    if (!res.ok) return { kind: 'error', reason: `http_${res.status}` };
    const body = (await res.json()) as unknown;
    // Validate shape before trusting the response — npm Enterprise proxies
    // have been seen to return HTML error pages with 200.
    if (!body || typeof body !== 'object') {
      return { kind: 'error', reason: 'bad_shape' };
    }
    const record = body as Record<string, unknown>;
    if ('error' in record) {
      return { kind: 'error', reason: String(record.error) };
    }
    if (!('downloads' in record)) {
      return { kind: 'error', reason: 'bad_shape' };
    }
    const downloads = record.downloads;
    if (!Array.isArray(downloads)) {
      return { kind: 'error', reason: 'downloads_not_array' };
    }
    const points = downloads
      .filter(
        (d: unknown): d is { day: string; downloads: number } =>
          !!d &&
          typeof d === 'object' &&
          typeof (d as { day?: unknown }).day === 'string' &&
          Number.isFinite((d as { downloads?: unknown }).downloads) &&
          (d as { downloads: number }).downloads >= 0,
      )
      .map((d) => ({ date: d.day, downloads: d.downloads }));
    return { kind: 'ok', points };
  } catch (error) {
    return { kind: 'error', reason: String(error) };
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
type RefreshSummary = {
  updated: number;
  notFound: number;
  skipped: number;
  rangeErrors: number;
};

let refreshInflight: Promise<RefreshSummary> | null = null;

export async function refreshNpmDownloads(
  opts: { db?: Database; force?: boolean } = {},
): Promise<RefreshSummary> {
  if (refreshInflight) return refreshInflight;
  refreshInflight = runRefresh(opts).finally(() => {
    refreshInflight = null;
  });
  return refreshInflight;
}

async function runRefresh(opts: { db?: Database; force?: boolean }): Promise<RefreshSummary> {
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
    // `<=` so a row exactly at TTL boundary is treated as stale (expires at
    // TTL, not TTL + 1).
    return cur.fetched_at <= staleCutoff;
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
  // pause is the polite default.
  //
  // IMPORTANT: only UPSERT, never DELETE outside the response window.
  // npm's /downloads/range returns 365 days max. Over time the local table
  // accumulates >365 days of history from successive weekly refetches (week 1
  // fills D-364..D0, week 52 fills D-12..D+364, etc.). A naive
  // DELETE-then-upsert would wipe the legitimate accumulated history and make
  // cumul_local drop at each refresh — this was the visible regression.
  // npm returns zero-filled continuous ranges (never "removed" dates), so
  // upsert alone is sufficient: any correction npm applies to a date within
  // the 365-day window gets reflected, and older data we've already cached
  // stays intact.
  const rangeErrors: Array<{ pkg: string; reason: string }> = [];
  for (const { name, pkg } of resolvedTargets) {
    const result = await fetchRange(pkg, RANGE_DAYS);
    if (result.kind === 'ok') {
      const tx = db.transaction(() => {
        for (const row of result.points) upsertDaily.run(name, row.date, row.downloads);
      });
      tx();
    } else if (result.kind === 'error') {
      rangeErrors.push({ pkg, reason: result.reason });
    }
    // kind === 'not_found' is silent: package genuinely not on npm.
    await new Promise((r) => setTimeout(r, 400));
  }

  if (rangeErrors.length > 0) {
    // Surfaced via the `skipped` field in caller summary — UI can warn that
    // some cumul_local figures are stale. Keeps the caller signature stable.
    console.warn(
      `[npm] range backfill failed for ${rangeErrors.length} package(s):`,
      rangeErrors.slice(0, 5),
    );
  }

  return { updated, notFound, skipped, rangeErrors: rangeErrors.length };
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
