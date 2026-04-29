import type { Database } from 'bun:sqlite';
import type { Hono } from 'hono';
import { loadSettings } from '../config';
import { getDb } from '../db';
import { listNpmDaily, listNpmStats, refreshNpmDownloads } from '../lib/npmDownloads';
import { listSyncLog, recordSyncEvent } from '../lib/syncLog';
import { syncGithubAll, syncGithubHeatmap } from '../scanners/githubSync';

const HEATMAP_TTL_SECONDS = 30 * 60;

type GithubStatusSnapshot = {
  repos: number;
  trafficRows: number;
  trafficRepos: number;
  latestTrafficDate: string | null;
  heatmapDays: number;
  heatmapTotal: number;
  heatmapLastSync: number | null;
  reposLastSync: number | null;
  trafficLastSync: number | null;
};

function kvNumber(db: Database, key: string): number | null {
  const row = db
    .query<{ value: string | null }, [string]>('SELECT value FROM kv WHERE key = ?')
    .get(key);
  if (!row?.value) {
    return null;
  }
  const parsed = Number.parseInt(row.value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function snapshot(db: Database): GithubStatusSnapshot {
  const repos = db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM github_repos').get()?.n ?? 0;
  const trafficRows =
    db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM github_repo_traffic_daily').get()?.n ??
    0;
  const trafficRepos =
    db
      .query<{ n: number }, []>('SELECT COUNT(DISTINCT repo) AS n FROM github_repo_traffic_daily')
      .get()?.n ?? 0;
  const latestTrafficDate =
    db.query<{ d: string | null }, []>('SELECT MAX(date) AS d FROM github_repo_traffic_daily').get()
      ?.d ?? null;
  const heatmapDays =
    db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM github_contributions').get()?.n ?? 0;
  const heatmapTotal =
    db
      .query<{ n: number | null }, []>(
        'SELECT COALESCE(SUM(count), 0) AS n FROM github_contributions',
      )
      .get()?.n ?? 0;

  return {
    repos,
    trafficRows,
    trafficRepos,
    latestTrafficDate,
    heatmapDays,
    heatmapTotal,
    heatmapLastSync: kvNumber(db, 'last_github_heatmap_sync'),
    reposLastSync: kvNumber(db, 'last_github_repos_sync'),
    trafficLastSync: kvNumber(db, 'last_github_traffic_sync'),
  };
}

const heatmapInflight = new Map<string, Promise<void>>();
let npmAutoRefreshInflight: Promise<void> | null = null;

function scheduleNpmAutoRefresh(db: Database): void {
  if (npmAutoRefreshInflight) return;
  const startedAt = Date.now();
  npmAutoRefreshInflight = refreshNpmDownloads({ db, force: false })
    .then((res) => {
      const hasWork = res.updated > 0 || res.notFound > 0 || res.rangeErrors > 0;
      if (hasWork) {
        recordSyncEvent(db, {
          kind: 'npm',
          trigger: 'auto',
          status: res.rangeErrors > 0 ? 'partial' : res.updated > 0 ? 'ok' : 'no-change',
          durationMs: Date.now() - startedAt,
          summary: res,
        });
      }
    })
    .catch((error) => {
      recordSyncEvent(db, {
        kind: 'npm',
        trigger: 'auto',
        status: 'error',
        durationMs: Date.now() - startedAt,
        summary: { error: String(error) },
      });
      console.warn('[npm] auto refresh failed:', String(error));
    })
    .finally(() => {
      npmAutoRefreshInflight = null;
    });
}

function scheduleHeatmapSync(db: Database, login: string, year: number): void {
  const key = `${login}:${year}`;
  if (heatmapInflight.has(key)) {
    return;
  }

  const startedAt = Date.now();
  const before = snapshot(db);
  const promise = syncGithubHeatmap(db, login, year)
    .then(() => {
      const after = snapshot(db);
      const daysDelta = after.heatmapDays - before.heatmapDays;
      const totalDelta = after.heatmapTotal - before.heatmapTotal;
      recordSyncEvent(db, {
        kind: 'heatmap',
        trigger: 'background',
        status: daysDelta === 0 && totalDelta === 0 ? 'no-change' : 'ok',
        durationMs: Date.now() - startedAt,
        summary: { login, year, daysDelta, totalDelta, heatmapDays: after.heatmapDays },
      });
    })
    .catch((error) => {
      recordSyncEvent(db, {
        kind: 'heatmap',
        trigger: 'background',
        status: 'error',
        durationMs: Date.now() - startedAt,
        summary: { login, year, error: String(error) },
      });
      console.warn('[github] background heatmap sync failed', error);
    })
    .finally(() => {
      heatmapInflight.delete(key);
    });

  heatmapInflight.set(key, promise);
}

export function registerGithubRoutes(app: Hono): void {
  app.get('/api/github/heatmap', async (c) => {
    const db = getDb();
    const settings = await loadSettings();
    // Clamp year to [2008, currentYear]. GitHub was founded in 2008; anything
    // earlier has no contributions. The upper bound blocks `?year=9999`-style
    // abuse that would balloon the GraphQL window variables.
    const currentYear = new Date().getUTCFullYear();
    const rawYear = Number.parseInt(c.req.query('year') || String(currentYear), 10);
    const year = Number.isFinite(rawYear)
      ? Math.max(2008, Math.min(currentYear, rawYear))
      : currentYear;

    const latest = db
      .query<{ synced_at: number }, []>(
        'SELECT MAX(synced_at) AS synced_at FROM github_contributions',
      )
      .get();

    const now = Math.floor(Date.now() / 1000);
    const hasData = latest?.synced_at != null;
    const stale = !hasData || now - (latest?.synced_at || 0) > HEATMAP_TTL_SECONDS;
    let syncError: string | null = null;

    if (stale) {
      if (hasData) {
        scheduleHeatmapSync(db, settings.github.username, year);
      } else {
        const startedAt = Date.now();
        const before = snapshot(db);
        try {
          await syncGithubHeatmap(db, settings.github.username, year);
          const after = snapshot(db);
          recordSyncEvent(db, {
            kind: 'heatmap',
            trigger: 'auto',
            status: 'ok',
            durationMs: Date.now() - startedAt,
            summary: {
              login: settings.github.username,
              year,
              daysDelta: after.heatmapDays - before.heatmapDays,
              totalDelta: after.heatmapTotal - before.heatmapTotal,
              heatmapDays: after.heatmapDays,
            },
          });
        } catch (error) {
          syncError = String(error);
          recordSyncEvent(db, {
            kind: 'heatmap',
            trigger: 'auto',
            status: 'error',
            durationMs: Date.now() - startedAt,
            summary: { login: settings.github.username, year, error: String(error) },
          });
        }
      }
    }

    const rows = db
      .query<{ date: string; count: number; color: string | null }, []>(
        'SELECT date, count, color FROM github_contributions ORDER BY date ASC',
      )
      .all();

    return c.json({
      year,
      total: rows.reduce((sum, row) => sum + row.count, 0),
      days: rows,
      syncError,
      lastSyncAt: latest?.synced_at || null,
      backgroundSyncScheduled: stale && hasData,
    });
  });

  app.get('/api/github/status', (c) => {
    const db = getDb();
    return c.json(snapshot(db));
  });

  app.get('/api/github/repos', (c) => {
    const db = getDb();
    const rows = db
      .query<
        {
          name: string;
          description: string | null;
          stars: number;
          forks: number;
          primary_lang: string | null;
          pushed_at: number | null;
          url: string | null;
          topics_json: string | null;
          is_fork: number | null;
        },
        []
      >(
        `SELECT name, description, stars, forks, primary_lang, pushed_at, url,
                topics_json, is_fork
         FROM github_repos
         ORDER BY pushed_at DESC, stars DESC`,
      )
      .all();
    // Parse topics_json → string[], coerce is_fork → boolean. Keeps the wire
    // shape flat and predictable for the client (no JSON parsing downstream).
    const normalized = rows.map((r) => {
      let topics: string[] = [];
      if (r.topics_json) {
        try {
          const parsed = JSON.parse(r.topics_json);
          if (Array.isArray(parsed)) {
            topics = parsed.filter((t): t is string => typeof t === 'string');
          }
        } catch {
          // malformed topics_json — treat as empty; don't crash the list
        }
      }
      return {
        name: r.name,
        description: r.description,
        stars: r.stars,
        forks: r.forks,
        primary_lang: r.primary_lang,
        pushed_at: r.pushed_at,
        url: r.url,
        topics,
        is_fork: Boolean(r.is_fork),
      };
    });
    return c.json(normalized);
  });

  app.get('/api/github/npm', async (c) => {
    const db = getDb();
    const force = c.req.query('refresh') === '1';

    if (force) {
      const startedAt = Date.now();
      try {
        const res = await refreshNpmDownloads({ db, force: true });
        recordSyncEvent(db, {
          kind: 'npm',
          trigger: 'manual',
          status: res.rangeErrors > 0 ? 'partial' : res.updated > 0 ? 'ok' : 'no-change',
          durationMs: Date.now() - startedAt,
          summary: res,
        });
      } catch (error) {
        recordSyncEvent(db, {
          kind: 'npm',
          trigger: 'manual',
          status: 'error',
          durationMs: Date.now() - startedAt,
          summary: { error: String(error) },
        });
        console.warn('[npm] refresh failed:', String(error));
      }
    } else {
      // Non-blocking: auto-refresh runs in background so the response returns
      // instantly with current DB state. The next poll picks up the refreshed
      // numbers. Avoids freezing the UI on the first hit after TTL expiry.
      scheduleNpmAutoRefresh(db);
    }
    return c.json(listNpmStats(db));
  });

  app.get('/api/github/npm/daily', (c) => {
    const db = getDb();
    const from = c.req.query('from') || undefined;
    const to = c.req.query('to') || undefined;
    return c.json({ rows: listNpmDaily(db, { from, to }) });
  });

  /**
   * Per-repo per-day npm downloads, for the heatmap's cumulative
   * stacked-bars view. Same window contract as
   * `/api/github/traffic/timeseries`: `?days=N` (default 120, capped 365).
   * Returned rows are date-descending then download-descending so the UI
   * can pick the top contributors at a glance during dev/debug, but the
   * client doesn't depend on that ordering — it bags by date and repo.
   */
  app.get('/api/github/npm/daily-by-repo', (c) => {
    const db = getDb();
    const days = Math.min(365, Math.max(1, Number.parseInt(c.req.query('days') || '120', 10)));
    const now = new Date();
    const cutoff = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - (days - 1)),
    )
      .toISOString()
      .slice(0, 10);
    const rows = db
      .query<{ date: string; repo: string; downloads: number }, [string]>(
        `SELECT date, repo_name AS repo, downloads
           FROM npm_downloads_daily
          WHERE date >= ?
          ORDER BY date DESC, downloads DESC`,
      )
      .all(cutoff);
    return c.json({ rows });
  });

  app.post('/api/github/npm/refresh', async (c) => {
    const db = getDb();
    const startedAt = Date.now();
    try {
      const res = await refreshNpmDownloads({ db, force: true });
      recordSyncEvent(db, {
        kind: 'npm',
        trigger: 'manual',
        status: res.rangeErrors > 0 ? 'partial' : res.updated > 0 ? 'ok' : 'no-change',
        durationMs: Date.now() - startedAt,
        summary: res,
      });
      return c.json({ ...res, stats: listNpmStats(db) });
    } catch (error) {
      recordSyncEvent(db, {
        kind: 'npm',
        trigger: 'manual',
        status: 'error',
        durationMs: Date.now() - startedAt,
        summary: { error: String(error) },
      });
      throw error;
    }
  });

  app.get('/api/github/sync-log', (c) => {
    const db = getDb();
    const limit = Number.parseInt(c.req.query('limit') || '50', 10);
    return c.json({ rows: listSyncLog(db, limit) });
  });

  app.get('/api/github/repos/:name', (c) => {
    const db = getDb();
    const row = db.query('SELECT * FROM github_repos WHERE name = ?').get(c.req.param('name'));
    if (!row) {
      return c.json({ error: 'repo_not_found' }, 404);
    }
    return c.json(row);
  });

  app.get('/api/github/activity', (c) => {
    const db = getDb();
    const rawDays = Number.parseInt(c.req.query('days') || '30', 10);
    const days = Number.isFinite(rawDays) ? Math.max(1, Math.min(365, rawDays)) : 30;
    const minTs = Math.floor(Date.now() / 1000) - days * 86400;

    const commits = db
      .query(
        'SELECT sha, repo, date, message FROM github_commits WHERE date >= ? ORDER BY date DESC LIMIT 250',
      )
      .all(minTs);

    return c.json(commits);
  });

  app.get('/api/github/traffic', (c) => {
    const db = getDb();
    const rawDays = Number.parseInt(c.req.query('days') || '14', 10);
    const days = Number.isFinite(rawDays) ? Math.max(1, Math.min(90, rawDays)) : 14;
    const now = new Date();
    const cutoff = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - (days - 1)),
    )
      .toISOString()
      .slice(0, 10);

    const perRepo = db
      .query<
        {
          repo: string;
          viewsRecent: number;
          viewsUniquesRecent: number;
          clonesRecent: number;
          clonesUniquesRecent: number;
          viewsCumulative: number;
          viewsUniquesCumulative: number;
          clonesCumulative: number;
          clonesUniquesCumulative: number;
          lastDate: string | null;
          daysCaptured: number;
        },
        [string, string, string, string]
      >(
        `SELECT
           repo,
           SUM(CASE WHEN date >= ? THEN views_count ELSE 0 END) AS viewsRecent,
           SUM(CASE WHEN date >= ? THEN views_uniques ELSE 0 END) AS viewsUniquesRecent,
           SUM(CASE WHEN date >= ? THEN clones_count ELSE 0 END) AS clonesRecent,
           SUM(CASE WHEN date >= ? THEN clones_uniques ELSE 0 END) AS clonesUniquesRecent,
           SUM(views_count) AS viewsCumulative,
           SUM(views_uniques) AS viewsUniquesCumulative,
           SUM(clones_count) AS clonesCumulative,
           SUM(clones_uniques) AS clonesUniquesCumulative,
           MAX(date) AS lastDate,
           COUNT(*) AS daysCaptured
         FROM github_repo_traffic_daily
         GROUP BY repo
         ORDER BY viewsCumulative DESC, clonesCumulative DESC, repo ASC`,
      )
      .all(cutoff, cutoff, cutoff, cutoff);

    const totals = perRepo.reduce(
      (acc, row) => {
        acc.viewsRecent += Number(row.viewsRecent || 0);
        acc.viewsUniquesRecent += Number(row.viewsUniquesRecent || 0);
        acc.clonesRecent += Number(row.clonesRecent || 0);
        acc.clonesUniquesRecent += Number(row.clonesUniquesRecent || 0);
        acc.viewsCumulative += Number(row.viewsCumulative || 0);
        acc.viewsUniquesCumulative += Number(row.viewsUniquesCumulative || 0);
        acc.clonesCumulative += Number(row.clonesCumulative || 0);
        acc.clonesUniquesCumulative += Number(row.clonesUniquesCumulative || 0);
        return acc;
      },
      {
        viewsRecent: 0,
        viewsUniquesRecent: 0,
        clonesRecent: 0,
        clonesUniquesRecent: 0,
        viewsCumulative: 0,
        viewsUniquesCumulative: 0,
        clonesCumulative: 0,
        clonesUniquesCumulative: 0,
      },
    );

    return c.json({
      days,
      cutoff,
      repos: perRepo,
      totals,
      reposWithTraffic: perRepo.length,
    });
  });

  app.get('/api/github/traffic/timeseries', (c) => {
    const db = getDb();
    const days = Math.min(365, Math.max(1, Number.parseInt(c.req.query('days') || '120', 10)));
    const now = new Date();
    const cutoff = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - (days - 1)),
    )
      .toISOString()
      .slice(0, 10);

    const rows = db
      .query<
        {
          repo: string;
          date: string;
          viewsCount: number;
          viewsUniques: number;
          clonesCount: number;
          clonesUniques: number;
        },
        [string]
      >(
        `SELECT
           repo,
           date,
           views_count AS viewsCount,
           views_uniques AS viewsUniques,
           clones_count AS clonesCount,
           clones_uniques AS clonesUniques
         FROM github_repo_traffic_daily
         WHERE date >= ?
         ORDER BY repo ASC, date ASC`,
      )
      .all(cutoff)
      .map((row) => ({
        ...row,
        viewsCount: Number(row.viewsCount || 0),
        viewsUniques: Number(row.viewsUniques || 0),
        clonesCount: Number(row.clonesCount || 0),
        clonesUniques: Number(row.clonesUniques || 0),
      }));

    return c.json({
      days,
      cutoff,
      rows,
      reposWithTraffic: new Set(rows.map((row) => row.repo)).size,
    });
  });

  /**
   * Per-repo daily metrics for small in-card bar charts: npm downloads,
   * traffic views, traffic clones, commit count. One request, 4 zero-filled
   * vectors per repo aligned on the same day window — callers pick a repo
   * by name and draw 4 bar sparks without any extra plumbing.
   */
  app.get('/api/github/repo-metrics', (c) => {
    const db = getDb();
    // 365d is the ceiling: npm API only keeps a year, traffic has at most
    // 14 d of upstream history (we accumulate but older than ~6 mo gets
    // sparse), commits go back further. Above 365 we'd be mixing regimes.
    const days = Math.min(365, Math.max(1, Number.parseInt(c.req.query('days') || '14', 10)));
    const now = new Date();
    const startMs = Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() - (days - 1),
    );
    const cutoff = new Date(startMs).toISOString().slice(0, 10);
    const dates: string[] = [];
    for (let i = 0; i < days; i += 1) {
      dates.push(new Date(startMs + i * 86_400_000).toISOString().slice(0, 10));
    }
    const dateIndex = new Map(dates.map((d, i) => [d, i]));

    // Seed every known repo with zero-filled vectors so low-traffic repos
    // still show a card (empty bars → visibly calm, not "missing").
    const reposList = db
      .query<{ name: string }, []>('SELECT name FROM github_repos ORDER BY name ASC')
      .all();
    const perRepo = new Map<
      string,
      { views: number[]; clones: number[]; commits: number[]; npm: number[] }
    >();
    for (const r of reposList) {
      perRepo.set(r.name, {
        views: new Array(days).fill(0),
        clones: new Array(days).fill(0),
        commits: new Array(days).fill(0),
        npm: new Array(days).fill(0),
      });
    }
    const ensure = (repo: string) => {
      let v = perRepo.get(repo);
      if (!v) {
        v = {
          views: new Array(days).fill(0),
          clones: new Array(days).fill(0),
          commits: new Array(days).fill(0),
          npm: new Array(days).fill(0),
        };
        perRepo.set(repo, v);
      }
      return v;
    };

    const trafficRows = db
      .query<{ repo: string; date: string; v: number; c: number }, [string]>(
        `SELECT repo, date,
                COALESCE(views_count, 0) AS v,
                COALESCE(clones_count, 0) AS c
         FROM github_repo_traffic_daily
         WHERE date >= ?`,
      )
      .all(cutoff);
    for (const row of trafficRows) {
      const idx = dateIndex.get(row.date);
      if (idx === undefined) continue;
      const bucket = ensure(row.repo);
      bucket.views[idx] += Number(row.v || 0);
      bucket.clones[idx] += Number(row.c || 0);
    }

    const commitRows = db
      .query<{ repo: string; date: string; n: number }, [string]>(
        `SELECT repo, date, COUNT(*) AS n
         FROM github_commits
         WHERE date >= ?
         GROUP BY repo, date`,
      )
      .all(cutoff);
    for (const row of commitRows) {
      const idx = dateIndex.get(row.date);
      if (idx === undefined) continue;
      ensure(row.repo).commits[idx] = Number(row.n || 0);
    }

    const npmRows = db
      .query<{ repo_name: string; date: string; downloads: number }, [string]>(
        `SELECT repo_name, date, downloads
         FROM npm_downloads_daily
         WHERE date >= ?`,
      )
      .all(cutoff);
    for (const row of npmRows) {
      const idx = dateIndex.get(row.date);
      if (idx === undefined) continue;
      ensure(row.repo_name).npm[idx] = Number(row.downloads || 0);
    }

    const result = [...perRepo.entries()].map(([repo, v]) => ({
      repo,
      views: v.views,
      clones: v.clones,
      commits: v.commits,
      npm: v.npm,
    }));
    return c.json({ days, cutoff, dates, repos: result });
  });

  app.post('/api/github/sync', async (c) => {
    const db = getDb();
    const settings = await loadSettings();
    const before = snapshot(db);
    const startedAt = Date.now();

    try {
      const result = await syncGithubAll(db, settings.github.username);
      const after = snapshot(db);

      const delta = {
        newRepos: after.repos - before.repos,
        newTrafficRows: after.trafficRows - before.trafficRows,
        newTrafficRepos: after.trafficRepos - before.trafficRepos,
        newHeatmapDays: after.heatmapDays - before.heatmapDays,
        heatmapTotalDelta: after.heatmapTotal - before.heatmapTotal,
        latestTrafficDateChanged:
          (before.latestTrafficDate || '') !== (after.latestTrafficDate || ''),
      };

      const hasChange =
        delta.newRepos !== 0 ||
        delta.newTrafficRows !== 0 ||
        delta.newTrafficRepos !== 0 ||
        delta.newHeatmapDays !== 0 ||
        delta.heatmapTotalDelta !== 0 ||
        delta.latestTrafficDateChanged;

      const status = result.trafficErrors > 0 ? 'partial' : hasChange ? 'ok' : 'no-change';
      recordSyncEvent(db, {
        kind: 'github-all',
        trigger: 'manual',
        status,
        durationMs: Date.now() - startedAt,
        summary: {
          synced: {
            repos: result.repos,
            trafficRepos: result.trafficRepos,
            trafficDays: result.trafficDays,
            trafficErrors: result.trafficErrors,
          },
          delta,
        },
      });

      return c.json({
        ok: true,
        synced: {
          repos: result.repos,
          trafficRepos: result.trafficRepos,
          trafficDays: result.trafficDays,
          trafficErrors: result.trafficErrors,
        },
        delta,
        hasChange,
        status: after,
      });
    } catch (error) {
      recordSyncEvent(db, {
        kind: 'github-all',
        trigger: 'manual',
        status: 'error',
        durationMs: Date.now() - startedAt,
        summary: { error: String(error) },
      });
      return c.json({ ok: false, error: String(error), status: before }, 500);
    }
  });
}
