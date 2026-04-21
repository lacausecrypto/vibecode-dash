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
      const hasWork = res.updated > 0 || res.notFound > 0;
      if (hasWork) {
        recordSyncEvent(db, {
          kind: 'npm',
          trigger: 'auto',
          status: res.updated > 0 ? 'ok' : 'no-change',
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
    const year = Number.parseInt(c.req.query('year') || String(new Date().getUTCFullYear()), 10);

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
    const rows = db.query('SELECT * FROM github_repos ORDER BY pushed_at DESC, stars DESC').all();
    return c.json(rows);
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
          status: res.updated > 0 ? 'ok' : 'no-change',
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

  app.post('/api/github/npm/refresh', async (c) => {
    const db = getDb();
    const startedAt = Date.now();
    try {
      const res = await refreshNpmDownloads({ db, force: true });
      recordSyncEvent(db, {
        kind: 'npm',
        trigger: 'manual',
        status: res.updated > 0 ? 'ok' : 'no-change',
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
    const days = Number.parseInt(c.req.query('days') || '30', 10);
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
    const days = Math.max(1, Number.parseInt(c.req.query('days') || '14', 10));
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
