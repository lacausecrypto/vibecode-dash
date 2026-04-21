import { useEffect, useMemo, useState } from 'react';
import { Heatmap } from '../components/Heatmap';
import {
  Button,
  Card,
  Chip,
  Dot,
  Empty,
  ErrorBanner,
  Section,
  Segmented,
  Stat,
  Toolbar,
} from '../components/ui';
import { apiGet, apiPost } from '../lib/api';
import { type Locale, dateLocale, numberLocale, useTranslation } from '../lib/i18n';

type HeatmapDay = { date: string; count: number; color?: string | null };
type HeatmapResponse = {
  total: number;
  days: HeatmapDay[];
  year?: number;
  syncError?: string | null;
};
type Repo = {
  name: string;
  description: string | null;
  stars: number;
  forks: number;
  primary_lang: string | null;
  pushed_at: number | null;
  url: string | null;
};

type RepoTraffic = {
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
};

type TrafficResponse = {
  days: number;
  cutoff: string;
  repos: RepoTraffic[];
  totals: {
    viewsRecent: number;
    viewsUniquesRecent: number;
    clonesRecent: number;
    clonesUniquesRecent: number;
    viewsCumulative: number;
    viewsUniquesCumulative: number;
    clonesCumulative: number;
    clonesUniquesCumulative: number;
  };
  reposWithTraffic: number;
};

type TrafficTimeseriesRow = {
  repo: string;
  date: string;
  viewsCount: number;
  viewsUniques: number;
  clonesCount: number;
  clonesUniques: number;
};

type TrafficTimeseriesResponse = {
  days: number;
  cutoff: string;
  rows: TrafficTimeseriesRow[];
  reposWithTraffic: number;
};

type RepoSort = 'pushed' | 'stars' | 'forks' | 'name';
type SparkMetric = 'views' | 'clones';
type SparkSort = 'window' | 'cumulative';

type GithubStatus = {
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

type SyncDelta = {
  newRepos: number;
  newTrafficRows: number;
  newTrafficRepos: number;
  newHeatmapDays: number;
  heatmapTotalDelta: number;
  latestTrafficDateChanged: boolean;
};

type SyncResponse = {
  ok: boolean;
  synced?: {
    repos: number;
    trafficRepos: number;
    trafficDays: number;
    trafficErrors: number;
  };
  delta?: SyncDelta;
  hasChange?: boolean;
  status?: GithubStatus;
  error?: string;
};

type SyncLogKind = 'repos' | 'traffic' | 'heatmap' | 'npm' | 'github-all';
type SyncLogTrigger = 'manual' | 'auto' | 'background';
type SyncLogStatus = 'ok' | 'no-change' | 'partial' | 'error';

type SyncLogEntry = {
  id: number;
  at: number;
  kind: SyncLogKind;
  trigger: SyncLogTrigger;
  status: SyncLogStatus;
  durationMs: number | null;
  summary: Record<string, unknown> | null;
};

type SyncBannerState =
  | { kind: 'idle' }
  | { kind: 'pending' }
  | { kind: 'no-change'; at: number }
  | {
      kind: 'updated';
      at: number;
      delta: SyncDelta;
      synced: NonNullable<SyncResponse['synced']>;
    }
  | { kind: 'error'; at: number; message: string };

function formatPushed(ts: number | null): string {
  if (!ts) {
    return 'n/a';
  }
  return new Date(ts * 1000).toLocaleDateString(dateLocale(currentLocale()));
}

// Read-only snapshot of locale used outside React hooks.
let LOCALE_SNAPSHOT: Locale = 'fr';
function currentLocale(): Locale {
  return LOCALE_SNAPSHOT;
}

function relativeTime(
  ts: number | null,
  t: (key: string, vars?: Record<string, string | number>) => string,
): string {
  if (!ts) {
    return t('github.sourceChipNever');
  }
  const diff = Math.floor(Date.now() / 1000) - ts;
  if (diff < 60) {
    return t('common.today');
  }
  if (diff < 3600) {
    return `${Math.floor(diff / 60)} min`;
  }
  if (diff < 86400) {
    return `${Math.floor(diff / 3600)} h`;
  }
  return t('common.daysAgo', { n: Math.floor(diff / 86400) });
}

function sourceFreshness(
  lastSyncAt: number | null,
  ttlSeconds: number,
): 'fresh' | 'stale' | 'empty' {
  if (!lastSyncAt) {
    return 'empty';
  }
  const age = Math.floor(Date.now() / 1000) - lastSyncAt;
  return age > ttlSeconds ? 'stale' : 'fresh';
}

function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addUtcDays(dateIso: string, delta: number): string {
  const date = new Date(`${dateIso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + delta);
  return toIsoDate(date);
}

function buildDateWindow(endDateIso: string, days: number): string[] {
  const startDate = addUtcDays(endDateIso, -(days - 1));
  const out: string[] = [];
  for (let i = 0; i < days; i += 1) {
    out.push(addUtcDays(startDate, i));
  }
  return out;
}

function sparklinePath(values: number[], width: number, height: number): string {
  if (values.length === 0) {
    return '';
  }
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const span = Math.max(max - min, 1);
  const points = values.map((value, index) => {
    const x = (index / Math.max(values.length - 1, 1)) * width;
    const y = height - ((value - min) / span) * height;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  });
  return `M ${points.join(' L ')}`;
}

function numberLabel(value: number): string {
  return Intl.NumberFormat(numberLocale(currentLocale())).format(Math.round(value));
}

export default function GithubRoute() {
  const { t, locale } = useTranslation();
  // Keep module-level snapshot in sync so pure helpers (numberLabel, formatPushed)
  // don't need to be threaded through every JSX call site.
  LOCALE_SNAPSHOT = locale;
  const [heatmap, setHeatmap] = useState<HeatmapResponse | null>(null);
  const [repos, setRepos] = useState<Repo[]>([]);
  const [traffic, setTraffic] = useState<TrafficResponse | null>(null);
  const [trafficSeries, setTrafficSeries] = useState<TrafficTimeseriesResponse | null>(null);
  const [status, setStatus] = useState<GithubStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncBanner, setSyncBanner] = useState<SyncBannerState>({ kind: 'idle' });
  const [, setNowTick] = useState(0);
  const [repoSort, setRepoSort] = useState<RepoSort>('pushed');
  const [query, setQuery] = useState('');
  const [sparkMetric, setSparkMetric] = useState<SparkMetric>('clones');
  const [sparkWindowDays, setSparkWindowDays] = useState<number>(30);
  const [sparkSort, setSparkSort] = useState<SparkSort>('cumulative');
  const [sparkFilter, setSparkFilter] = useState('');
  const [sparkOnlyTraffic, setSparkOnlyTraffic] = useState(true);
  const [heatmapMetric, setHeatmapMetric] = useState<'contrib' | 'views' | 'clones' | 'npm'>(
    'contrib',
  );
  const [npmDaily, setNpmDaily] = useState<Array<{ date: string; count: number }>>([]);
  const [deltaPeriod, setDeltaPeriod] = useState<'day' | 'week' | 'month'>('week');
  const [syncLog, setSyncLog] = useState<SyncLogEntry[]>([]);
  const [syncLogFilter, setSyncLogFilter] = useState<'all' | 'github' | 'npm' | 'heatmap'>('all');
  const [isRefreshingNpm, setIsRefreshingNpm] = useState(false);

  async function load() {
    try {
      setError(null);
      const [
        heatmapData,
        reposData,
        trafficData,
        trafficSeriesData,
        statusData,
        npmDailyData,
        syncLogData,
      ] = await Promise.all([
        apiGet<HeatmapResponse>('/api/github/heatmap'),
        apiGet<Repo[]>('/api/github/repos'),
        apiGet<TrafficResponse>('/api/github/traffic?days=14'),
        apiGet<TrafficTimeseriesResponse>('/api/github/traffic/timeseries?days=120'),
        apiGet<GithubStatus>('/api/github/status'),
        apiGet<{ rows: Array<{ date: string; downloads: number }> }>('/api/github/npm/daily').catch(
          () => ({ rows: [] }),
        ),
        apiGet<{ rows: SyncLogEntry[] }>('/api/github/sync-log?limit=50').catch(() => ({
          rows: [] as SyncLogEntry[],
        })),
      ]);
      setHeatmap(heatmapData);
      setRepos(reposData);
      setTraffic(trafficData);
      setTrafficSeries(trafficSeriesData);
      setStatus(statusData);
      setNpmDaily(npmDailyData.rows.map((r) => ({ date: r.date, count: r.downloads })));
      setSyncLog(syncLogData.rows || []);
    } catch (e) {
      setError(String(e));
    }
  }

  async function refreshSyncLog() {
    try {
      const data = await apiGet<{ rows: SyncLogEntry[] }>('/api/github/sync-log?limit=50');
      setSyncLog(data.rows || []);
    } catch {
      /* ignore */
    }
  }

  async function refreshNpmNow() {
    setIsRefreshingNpm(true);
    try {
      await apiPost('/api/github/npm/refresh');
      await load();
    } catch (e) {
      setError(String(e));
    } finally {
      setIsRefreshingNpm(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  useEffect(() => {
    const id = setInterval(() => setNowTick((n) => n + 1), 30_000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (syncBanner.kind === 'idle' || syncBanner.kind === 'pending') {
      return;
    }
    const id = setTimeout(() => setSyncBanner({ kind: 'idle' }), 12_000);
    return () => clearTimeout(id);
  }, [syncBanner]);

  async function syncNow() {
    setSyncing(true);
    setSyncBanner({ kind: 'pending' });
    try {
      const result = await apiPost<SyncResponse>('/api/github/sync');
      if (result.ok === false) {
        setSyncBanner({
          kind: 'error',
          at: Date.now(),
          message: result.error || 'sync_failed',
        });
      } else if (result.hasChange && result.delta && result.synced) {
        setSyncBanner({
          kind: 'updated',
          at: Date.now(),
          delta: result.delta,
          synced: result.synced,
        });
      } else {
        setSyncBanner({ kind: 'no-change', at: Date.now() });
      }
      if (result.status) {
        setStatus(result.status);
      }
      await load();
      await refreshSyncLog();
    } catch (e) {
      setSyncBanner({ kind: 'error', at: Date.now(), message: String(e) });
    } finally {
      setSyncing(false);
    }
  }

  const filteredRepos = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();

    const filtered = repos.filter((repo) => {
      if (!normalizedQuery) {
        return true;
      }
      return (
        repo.name.toLowerCase().includes(normalizedQuery) ||
        (repo.description || '').toLowerCase().includes(normalizedQuery) ||
        (repo.primary_lang || '').toLowerCase().includes(normalizedQuery)
      );
    });

    filtered.sort((a, b) => {
      if (repoSort === 'name') {
        return a.name.localeCompare(b.name);
      }
      if (repoSort === 'stars') {
        return b.stars - a.stars;
      }
      if (repoSort === 'forks') {
        return b.forks - a.forks;
      }
      return (b.pushed_at || 0) - (a.pushed_at || 0);
    });

    return filtered;
  }, [repos, query, repoSort]);

  const stats = useMemo(() => {
    const totalStars = repos.reduce((sum, repo) => sum + repo.stars, 0);
    const totalForks = repos.reduce((sum, repo) => sum + repo.forks, 0);
    const topLangs = new Map<string, number>();
    for (const repo of repos) {
      if (!repo.primary_lang) {
        continue;
      }
      topLangs.set(repo.primary_lang, (topLangs.get(repo.primary_lang) || 0) + 1);
    }
    const languages = [...topLangs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
    return {
      totalRepos: repos.length,
      totalStars,
      totalForks,
      languages,
      trafficViewsRecent: traffic?.totals.viewsRecent || 0,
      trafficViewsCumulative: traffic?.totals.viewsCumulative || 0,
      trafficClonesRecent: traffic?.totals.clonesRecent || 0,
      trafficClonesCumulative: traffic?.totals.clonesCumulative || 0,
    };
  }, [repos, traffic]);

  const trafficByRepo = useMemo(() => {
    const map = new Map<string, RepoTraffic>();
    for (const row of traffic?.repos || []) {
      map.set(row.repo, row);
    }
    return map;
  }, [traffic]);

  const repoByName = useMemo(() => {
    const map = new Map<string, Repo>();
    for (const repo of repos) {
      map.set(repo.name, repo);
    }
    return map;
  }, [repos]);

  // Delta % current window vs previous window of same length.
  const deltaWindowDays = deltaPeriod === 'day' ? 1 : deltaPeriod === 'week' ? 7 : 30;

  // Top starred repo — provides context for the Stars KPI.
  const topStarredRepo = useMemo(() => {
    if (repos.length === 0) return null;
    return [...repos].sort((a, b) => b.stars - a.stars)[0];
  }, [repos]);

  // Push freshness scoped to the current window: median age of the last push
  // across repos that pushed within the window. Fully reactive to deltaWindowDays.
  // Freshest repo stays global (most-recent push overall) — that's a portfolio
  // anchor, not a windowed metric.
  const pushFreshness = useMemo(() => {
    const now = Math.floor(Date.now() / 1000);
    const cutoff = now - deltaWindowDays * 86400;
    const withPush = repos.filter((r) => r.pushed_at && r.pushed_at > 0);
    const inWindow = withPush.filter((r) => (r.pushed_at || 0) >= cutoff);

    let medianSec: number | null = null;
    if (inWindow.length > 0) {
      const ages = inWindow.map((r) => now - (r.pushed_at || 0)).sort((a, b) => a - b);
      const mid = Math.floor(ages.length / 2);
      medianSec = ages.length % 2 === 0 ? Math.round((ages[mid - 1] + ages[mid]) / 2) : ages[mid];
    }

    const freshest =
      withPush.length > 0
        ? [...withPush].sort((a, b) => (b.pushed_at || 0) - (a.pushed_at || 0))[0]
        : null;

    return {
      medianSec,
      freshest,
      freshestAgeSec: freshest?.pushed_at ? now - freshest.pushed_at : null,
      countInWindow: inWindow.length,
      total: withPush.length,
    };
  }, [repos, deltaWindowDays]);

  // Top repo by traffic (views + clones) within the current delta window.
  const topTrafficRepo = useMemo(() => {
    const rows = trafficSeries?.rows || [];
    if (rows.length === 0) {
      return null;
    }
    const todayIso = new Date().toISOString().slice(0, 10);
    const latest =
      rows.reduce((max, row) => (row.date <= todayIso && row.date > max ? row.date : max), '') ||
      todayIso;
    const endMs = new Date(`${latest}T00:00:00Z`).getTime();
    const startMs = endMs - (deltaWindowDays - 1) * 86400 * 1000;
    const startIso = new Date(startMs).toISOString().slice(0, 10);
    const per = new Map<string, { views: number; clones: number }>();
    for (const row of rows) {
      if (row.date < startIso || row.date > latest) continue;
      const cur = per.get(row.repo) || { views: 0, clones: 0 };
      cur.views += Number(row.viewsCount || 0);
      cur.clones += Number(row.clonesCount || 0);
      per.set(row.repo, cur);
    }
    const entries = [...per.entries()].map(([repo, v]) => ({
      repo,
      views: v.views,
      clones: v.clones,
      total: v.views + v.clones,
    }));
    entries.sort((a, b) => b.total - a.total);
    return entries[0] || null;
  }, [trafficSeries, deltaWindowDays]);

  const dailyDeltas = useMemo(() => {
    const addDays = (iso: string, delta: number) => {
      const d = new Date(`${iso}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() + delta);
      return d.toISOString().slice(0, 10);
    };

    const sumRange = (series: Array<{ date: string; count: number }>, from: string, to: string) =>
      series.reduce((acc, row) => (row.date >= from && row.date <= to ? acc + row.count : acc), 0);

    // Anchor windows on each series' latest *real* date (≤ today) so "Jour /
    // Semaine / Mois" reste significatif même quand GitHub publie avec 24-48h
    // de retard (traffic). Clamp à today: heatmap.days est paddé jusqu'au 31
    // décembre avec count=0, donc sans clamp le latest tomberait sur Dec 31.
    const todayIso = new Date().toISOString().slice(0, 10);
    const computeDelta = (series: Array<{ date: string; count: number }>) => {
      const latest =
        series.reduce(
          (max, row) => (row.date <= todayIso && row.date > max ? row.date : max),
          '',
        ) || todayIso;
      const currentEnd = latest;
      const currentStart = addDays(latest, -(deltaWindowDays - 1));
      const previousEnd = addDays(currentStart, -1);
      const previousStart = addDays(previousEnd, -(deltaWindowDays - 1));

      const current = sumRange(series, currentStart, currentEnd);
      const previous = sumRange(series, previousStart, previousEnd);
      if (previous <= 0) {
        return { current, previous, pct: current > 0 ? 100 : 0, positive: current > 0 };
      }
      const pct = ((current - previous) / previous) * 100;
      return { current, previous, pct, positive: pct >= 0 };
    };

    const contribSeries =
      (heatmap?.days || []).map((d) => ({ date: d.date, count: d.count })) || [];
    const viewsSeries = new Map<string, number>();
    const clonesSeries = new Map<string, number>();
    for (const row of trafficSeries?.rows || []) {
      viewsSeries.set(row.date, (viewsSeries.get(row.date) || 0) + row.viewsCount);
      clonesSeries.set(row.date, (clonesSeries.get(row.date) || 0) + row.clonesCount);
    }
    const toSeries = (m: Map<string, number>) =>
      [...m.entries()].map(([date, count]) => ({ date, count }));

    return {
      contrib: computeDelta(contribSeries),
      views: computeDelta(toSeries(viewsSeries)),
      clones: computeDelta(toSeries(clonesSeries)),
    };
  }, [heatmap, trafficSeries, deltaWindowDays]);

  // Aggregate views/clones per day across all repos, padded to a full calendar year
  // (same grille que la heatmap Contributions : cases vides pour les jours sans data).
  const trafficHeatmapDays = useMemo(() => {
    const views = new Map<string, number>();
    const clones = new Map<string, number>();
    const npm = new Map<string, number>();
    for (const row of trafficSeries?.rows || []) {
      views.set(row.date, (views.get(row.date) || 0) + Number(row.viewsCount || 0));
      clones.set(row.date, (clones.get(row.date) || 0) + Number(row.clonesCount || 0));
    }
    for (const row of npmDaily) {
      npm.set(row.date, (npm.get(row.date) || 0) + Number(row.count || 0));
    }

    const year = heatmap?.year || new Date().getUTCFullYear();
    const annualDates: string[] = [];
    const cursor = new Date(Date.UTC(year, 0, 1));
    const endYear = new Date(Date.UTC(year, 11, 31));
    while (cursor <= endYear) {
      annualDates.push(cursor.toISOString().slice(0, 10));
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }

    const toDays = (m: Map<string, number>) =>
      annualDates.map((date) => ({ date, count: m.get(date) || 0, color: null }));

    return {
      views: toDays(views),
      clones: toDays(clones),
      npm: toDays(npm),
    };
  }, [trafficSeries, heatmap?.year, npmDaily]);

  const sparkRows = useMemo(() => {
    const normalized = sparkFilter.trim().toLowerCase();
    const latestDate =
      trafficSeries?.rows.reduce((max, row) => (row.date > max ? row.date : max), '') ||
      toIsoDate(new Date());
    const windowDates = buildDateWindow(latestDate, sparkWindowDays);

    const pointsByRepo = new Map<string, Map<string, TrafficTimeseriesRow>>();
    for (const row of trafficSeries?.rows || []) {
      let repoMap = pointsByRepo.get(row.repo);
      if (!repoMap) {
        repoMap = new Map<string, TrafficTimeseriesRow>();
        pointsByRepo.set(row.repo, repoMap);
      }
      repoMap.set(row.date, row);
    }

    const repoNames = new Set<string>([
      ...repos.map((repo) => repo.name),
      ...(traffic?.repos || []).map((row) => row.repo),
    ]);

    const rows = [...repoNames]
      .map((repoName) => {
        const repo = repoByName.get(repoName);
        const haystack = `${repoName} ${(repo?.description || '').toLowerCase()} ${(
          repo?.primary_lang || ''
        ).toLowerCase()}`;
        if (normalized && !haystack.toLowerCase().includes(normalized)) {
          return null;
        }

        const points = pointsByRepo.get(repoName);
        const values = windowDates.map((date) => {
          const point = points?.get(date);
          return sparkMetric === 'views' ? point?.viewsCount || 0 : point?.clonesCount || 0;
        });

        const windowTotal = values.reduce((sum, value) => sum + value, 0);
        const cumulative =
          sparkMetric === 'views'
            ? trafficByRepo.get(repoName)?.viewsCumulative || 0
            : trafficByRepo.get(repoName)?.clonesCumulative || 0;
        const recent14 =
          sparkMetric === 'views'
            ? trafficByRepo.get(repoName)?.viewsRecent || 0
            : trafficByRepo.get(repoName)?.clonesRecent || 0;
        const lastDate = trafficByRepo.get(repoName)?.lastDate || null;

        if (sparkOnlyTraffic && windowTotal === 0 && cumulative === 0) {
          return null;
        }

        return {
          repoName,
          repoUrl: repo?.url || null,
          values,
          windowTotal,
          cumulative,
          recent14,
          lastDate,
        };
      })
      .filter((row): row is NonNullable<typeof row> => Boolean(row));

    rows.sort((a, b) => {
      if (sparkSort === 'window') {
        if (b.windowTotal !== a.windowTotal) {
          return b.windowTotal - a.windowTotal;
        }
        return b.cumulative - a.cumulative;
      }
      if (b.cumulative !== a.cumulative) {
        return b.cumulative - a.cumulative;
      }
      return b.windowTotal - a.windowTotal;
    });

    return { latestDate, rows };
  }, [
    repos,
    repoByName,
    sparkFilter,
    sparkMetric,
    sparkOnlyTraffic,
    sparkSort,
    sparkWindowDays,
    traffic,
    trafficByRepo,
    trafficSeries,
  ]);

  return (
    <div className="flex flex-col gap-6">
      <Section
        title={t('github.title')}
        meta={t('github.meta')}
        action={
          <Button tone="accent" onClick={() => void syncNow()} disabled={syncing}>
            {syncing ? t('github.syncing') : t('github.syncNow')}
          </Button>
        }
      >
        <div className="flex flex-wrap items-center gap-2">
          <SourceChip
            label="heatmap"
            lastSync={status?.heatmapLastSync || null}
            ttl={30 * 60}
            detail={status ? `${status.heatmapTotal} ${t('github.heatmap.totalContribs')}` : null}
          />
          <SourceChip
            label="repos"
            lastSync={status?.reposLastSync || null}
            ttl={30 * 60}
            detail={status ? `${status.repos} repos` : null}
          />
          <SourceChip
            label="traffic"
            lastSync={status?.trafficLastSync || null}
            ttl={30 * 60}
            detail={
              status ? `${status.trafficRepos} repos · ${status.trafficRows} snapshots` : null
            }
          />
        </div>

        <SyncBanner state={syncBanner} status={status} />

        <ErrorBanner>{error}</ErrorBanner>
        {!error && heatmap?.syncError ? (
          <div className="rounded-[var(--radius)] border border-[rgba(255,214,10,0.32)] bg-[rgba(255,214,10,0.08)] px-3 py-2 text-sm text-[#f6e6a4]">
            {t('github.syncError', { message: heatmap.syncError })}
          </div>
        ) : null}

        <div className="flex items-center justify-between gap-2">
          <div className="text-[11px] uppercase tracking-[0.08em] text-[var(--text-dim)]">
            {t('github.deltaVsPrev')}
          </div>
          <Segmented<'day' | 'week' | 'month'>
            value={deltaPeriod}
            options={[
              { value: 'day', label: t('common.day') },
              { value: 'week', label: t('common.week') },
              { value: 'month', label: t('common.month') },
            ]}
            onChange={setDeltaPeriod}
          />
        </div>

        <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-4">
          <Stat
            label={`${t('github.stats.contribs')} · ${deltaWindowDays}j`}
            value={numberLabel(dailyDeltas.contrib.current)}
            hint={<DeltaHint delta={dailyDeltas.contrib} period={deltaPeriod} />}
          />
          <Stat
            label={
              <span className="flex items-center gap-1">
                <span className="text-[#ffd60a]">★</span>
                <span>Stars</span>
              </span>
            }
            value={numberLabel(stats.totalStars)}
            tone="warn"
            hint={
              <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[var(--text-dim)]">
                {topStarredRepo && topStarredRepo.stars > 0 ? (
                  <span className="truncate" title={topStarredRepo.name}>
                    top&nbsp;
                    <span className="text-[var(--text-mute)]">{topStarredRepo.name}</span>
                    <span className="num">&nbsp;· ★{numberLabel(topStarredRepo.stars)}</span>
                  </span>
                ) : (
                  <span className="text-[var(--text-faint)]">aucun star</span>
                )}
                <span className="text-[var(--text-faint)]">·</span>
                <span className="num">
                  <span className="text-[var(--text-mute)]">⑂</span> {numberLabel(stats.totalForks)}{' '}
                  · {numberLabel(stats.totalRepos)} repos
                </span>
              </span>
            }
          />
          <Stat
            label={`Fraîcheur · ${deltaWindowDays}j`}
            value={
              pushFreshness.medianSec !== null
                ? relativeTime(Math.floor(Date.now() / 1000) - pushFreshness.medianSec, t)
                : '—'
            }
            hint={
              <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[var(--text-dim)]">
                {pushFreshness.medianSec !== null ? (
                  <span className="num text-[var(--text-mute)]">
                    méd · {pushFreshness.countInWindow}/{pushFreshness.total} actifs
                  </span>
                ) : (
                  <span className="text-[var(--text-faint)]">
                    aucun push sur {deltaWindowDays}j
                  </span>
                )}
                {pushFreshness.freshest && pushFreshness.freshestAgeSec !== null ? (
                  <>
                    <span className="text-[var(--text-faint)]">·</span>
                    <span className="truncate" title={pushFreshness.freshest.name}>
                      last&nbsp;
                      <span className="text-[var(--text-mute)]">{pushFreshness.freshest.name}</span>
                      <span className="num">
                        {' '}
                        ·{' '}
                        {relativeTime(
                          Math.floor(Date.now() / 1000) - pushFreshness.freshestAgeSec,
                          t,
                        )}
                      </span>
                    </span>
                  </>
                ) : null}
              </span>
            }
          />
          <NpmDownloadsStat deltaWindowDays={deltaWindowDays} />
          <Stat
            label={`Views · ${deltaWindowDays}j`}
            value={numberLabel(dailyDeltas.views.current)}
            hint={
              <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                <DeltaHint delta={dailyDeltas.views} period={deltaPeriod} />
                <span className="text-[var(--text-faint)]">·</span>
                <span className="text-[var(--text-dim)]">
                  {t('github.stats.localSum')}{' '}
                  <span className="num text-[var(--text-mute)]">
                    {numberLabel(stats.trafficViewsCumulative)}
                  </span>
                </span>
              </span>
            }
          />
          <Stat
            label={`Clones · ${deltaWindowDays}j`}
            value={numberLabel(dailyDeltas.clones.current)}
            hint={
              <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                <DeltaHint delta={dailyDeltas.clones} period={deltaPeriod} />
                <span className="text-[var(--text-faint)]">·</span>
                <span className="text-[var(--text-dim)]">
                  {t('github.stats.localSum')}{' '}
                  <span className="num text-[var(--text-mute)]">
                    {numberLabel(stats.trafficClonesCumulative)}
                  </span>
                </span>
              </span>
            }
            tone="success"
          />
          <Stat
            label={`Top repo · ${deltaWindowDays}j`}
            value={
              topTrafficRepo ? (
                <span
                  className="block max-w-full truncate text-[26px] leading-tight"
                  title={topTrafficRepo.repo}
                >
                  {topTrafficRepo.repo}
                </span>
              ) : (
                '—'
              )
            }
            tone="accent"
            hint={
              topTrafficRepo ? (
                <span className="num flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[var(--text-dim)]">
                  <span>
                    views{' '}
                    <span className="text-[var(--text-mute)]">
                      {numberLabel(topTrafficRepo.views)}
                    </span>
                  </span>
                  <span className="text-[var(--text-faint)]">·</span>
                  <span>
                    clones{' '}
                    <span className="text-[var(--text-mute)]">
                      {numberLabel(topTrafficRepo.clones)}
                    </span>
                  </span>
                </span>
              ) : (
                <span className="text-[var(--text-faint)]">aucun trafic observé</span>
              )
            }
          />
          <Stat
            label={t('github.stats.topLangs')}
            value={String(stats.languages.length || 0)}
            hint={stats.languages.map(([lang]) => lang).join(' · ') || 'n/a'}
          />
        </div>
      </Section>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Section
          title={t('github.heatmap.title', {
            year: heatmap?.year || new Date().getUTCFullYear(),
          })}
          meta={
            heatmapMetric === 'contrib'
              ? t('github.heatmap.contribMeta')
              : heatmapMetric === 'views'
                ? t('github.heatmap.viewsMeta', {
                    total: numberLabel(
                      trafficHeatmapDays.views.reduce((acc, d) => acc + d.count, 0),
                    ),
                  })
                : heatmapMetric === 'clones'
                  ? t('github.heatmap.clonesMeta', {
                      total: numberLabel(
                        trafficHeatmapDays.clones.reduce((acc, d) => acc + d.count, 0),
                      ),
                    })
                  : `npm downloads · Σ ${numberLabel(
                      trafficHeatmapDays.npm.reduce((acc, d) => acc + d.count, 0),
                    )}`
          }
        >
          <Card>
            <div className="mb-3">
              <Segmented<'contrib' | 'views' | 'clones' | 'npm'>
                value={heatmapMetric}
                options={[
                  { value: 'contrib', label: t('github.heatmap.optContrib') },
                  { value: 'views', label: t('github.heatmap.optViews') },
                  { value: 'clones', label: t('github.heatmap.optClones') },
                  { value: 'npm', label: 'npm' },
                ]}
                onChange={setHeatmapMetric}
              />
            </div>
            {heatmapMetric === 'contrib' ? (
              <Heatmap
                days={heatmap?.days || []}
                palette="github"
                totalLabel={t('github.heatmap.totalContribs')}
              />
            ) : heatmapMetric === 'views' ? (
              <Heatmap
                days={trafficHeatmapDays.views}
                palette="cyan"
                totalLabel={t('github.heatmap.totalViews')}
              />
            ) : heatmapMetric === 'clones' ? (
              <Heatmap
                days={trafficHeatmapDays.clones}
                palette="amber"
                totalLabel={t('github.heatmap.totalClones')}
              />
            ) : (
              <Heatmap days={trafficHeatmapDays.npm} palette="magenta" totalLabel="downloads" />
            )}
          </Card>
        </Section>

        <SyncLogPanel
          entries={syncLog}
          status={status}
          filter={syncLogFilter}
          onFilterChange={setSyncLogFilter}
          onRefresh={() => void refreshSyncLog()}
          onRefreshNpm={() => void refreshNpmNow()}
          onSyncGithub={() => void syncNow()}
          isSyncing={syncing}
          isRefreshingNpm={isRefreshingNpm}
          t={t}
        />
      </div>

      <Section
        title={t('github.sparklines.title')}
        meta={t('github.sparklines.meta', {
          days: sparkWindowDays,
          date: sparkRows.latestDate,
          count: sparkRows.rows.length,
          sortBy:
            sparkSort === 'window'
              ? t('github.sparklines.sortWindow')
              : t('github.sparklines.sortCumul'),
        })}
      >
        <Card>
          <Toolbar>
            <input
              className="min-w-[220px] flex-1"
              placeholder={t('github.sparklines.filter')}
              value={sparkFilter}
              onChange={(event) => setSparkFilter(event.target.value)}
            />

            <Segmented
              value={sparkMetric}
              options={[
                { value: 'clones', label: t('github.heatmap.optClones') },
                { value: 'views', label: t('github.heatmap.optViews') },
              ]}
              onChange={setSparkMetric}
            />

            <Segmented
              value={String(sparkWindowDays) as '14' | '30' | '60' | '90'}
              options={[
                { value: '14', label: t('github.sparklines.daysWindow', { n: 14 }) },
                { value: '30', label: t('github.sparklines.daysWindow', { n: 30 }) },
                { value: '60', label: t('github.sparklines.daysWindow', { n: 60 }) },
                { value: '90', label: t('github.sparklines.daysWindow', { n: 90 }) },
              ]}
              onChange={(value) => setSparkWindowDays(Number.parseInt(value, 10))}
            />

            <Segmented
              value={sparkSort}
              options={[
                { value: 'cumulative', label: t('github.sparklines.sortCumul') },
                { value: 'window', label: t('github.sparklines.sortWindow') },
              ]}
              onChange={setSparkSort}
            />

            <label className="flex items-center gap-1.5 text-[12px] text-[var(--text-mute)]">
              <input
                type="checkbox"
                checked={sparkOnlyTraffic}
                onChange={(event) => setSparkOnlyTraffic(event.target.checked)}
              />
              {t('github.sparklines.onlyTraffic')}
            </label>
          </Toolbar>

          <div className="mt-3 grid grid-cols-1 gap-1 md:grid-cols-2 xl:grid-cols-3">
            {sparkRows.rows.slice(0, 30).map((row, index) => (
              <RepoSparklineCard
                key={row.repoName}
                rank={index + 1}
                repoName={row.repoName}
                repoUrl={row.repoUrl}
                values={row.values}
                metric={sparkMetric}
                sort={sparkSort}
                windowDays={sparkWindowDays}
                windowTotal={row.windowTotal}
                cumulative={row.cumulative}
                recent14={row.recent14}
                lastDate={row.lastDate}
              />
            ))}
            {sparkRows.rows.length === 0 ? <Empty>{t('github.sparklines.empty')}</Empty> : null}
          </div>
        </Card>
      </Section>

      <Section
        title={t('github.repos.title')}
        meta={t('github.repos.meta', { filtered: filteredRepos.length, total: repos.length })}
      >
        <Card>
          <Toolbar>
            <input
              className="min-w-[220px] flex-1"
              placeholder={t('github.repos.filter')}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <Segmented
              value={repoSort}
              options={[
                { value: 'pushed', label: t('github.repos.sortRecent') },
                { value: 'stars', label: t('github.repos.sortStars') },
                { value: 'forks', label: t('github.repos.sortForks') },
                { value: 'name', label: t('github.repos.sortName') },
              ]}
              onChange={setRepoSort}
            />
          </Toolbar>

          <div className="mt-3 flex flex-col gap-2">
            {filteredRepos.slice(0, 50).map((repo) => {
              const repoTraffic = trafficByRepo.get(repo.name);
              return (
                <a
                  key={repo.name}
                  href={repo.url || '#'}
                  target="_blank"
                  rel="noreferrer"
                  className="flex flex-wrap items-start justify-between gap-3 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-1)] px-3 py-2.5 hover:border-[var(--border-strong)] hover:bg-[var(--surface-2)]"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-[14px] font-medium text-[var(--text)]">
                        {repo.name}
                      </span>
                      {repo.primary_lang ? <Chip>{repo.primary_lang}</Chip> : null}
                    </div>
                    <div className="mt-0.5 truncate text-[12px] text-[var(--text-dim)]">
                      {repo.description || '—'}
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-[var(--text-dim)]">
                      <Chip tone="accent">
                        {t('github.repos.views14d', {
                          recent: numberLabel(repoTraffic?.viewsRecent || 0),
                          total: numberLabel(repoTraffic?.viewsCumulative || 0),
                        })}
                      </Chip>
                      <Chip tone="success">
                        {t('github.repos.clones14d', {
                          recent: numberLabel(repoTraffic?.clonesRecent || 0),
                          total: numberLabel(repoTraffic?.clonesCumulative || 0),
                        })}
                      </Chip>
                      {repoTraffic?.lastDate ? (
                        <span className="num text-[var(--text-faint)]">
                          · {t('github.repos.lastSnapshot', { date: repoTraffic.lastDate })}
                        </span>
                      ) : null}
                    </div>
                  </div>
                  <div className="flex flex-col items-end gap-0.5 text-[12px] text-[var(--text-mute)]">
                    <div className="num">
                      ★ {numberLabel(repo.stars)} · ⑂ {numberLabel(repo.forks)}
                    </div>
                    <div className="text-[11px] text-[var(--text-dim)]">
                      {t('github.repos.push', { date: formatPushed(repo.pushed_at) })}
                    </div>
                  </div>
                </a>
              );
            })}

            {filteredRepos.length === 0 ? <Empty>{t('github.repos.emptyFilter')}</Empty> : null}
          </div>
        </Card>
      </Section>
    </div>
  );
}

function SourceChip({
  label,
  lastSync,
  ttl,
  detail,
}: {
  label: string;
  lastSync: number | null;
  ttl: number;
  detail: string | null;
}) {
  const { t } = useTranslation();
  const freshness = sourceFreshness(lastSync, ttl);
  const tone = freshness === 'fresh' ? 'success' : freshness === 'stale' ? 'warn' : 'neutral';
  return (
    <Chip tone={tone} title={detail || undefined}>
      <Dot tone={freshness === 'empty' ? 'neutral' : (tone as 'success' | 'warn' | 'neutral')} />
      <span className="font-medium">{label}</span>
      <span className="text-[11px] opacity-80">
        {freshness === 'empty' ? t('github.sourceChipNever') : relativeTime(lastSync, t)}
      </span>
    </Chip>
  );
}

function SyncBanner({
  state,
  status,
}: {
  state: SyncBannerState;
  status: GithubStatus | null;
}) {
  const { t } = useTranslation();
  if (state.kind === 'idle') {
    return null;
  }

  if (state.kind === 'pending') {
    return (
      <div className="flex items-center gap-2 rounded-[var(--radius)] border border-[rgba(100,210,255,0.32)] bg-[var(--accent-soft)] px-3 py-2 text-sm text-[#cfecff]">
        <span className="pulse-accent h-2 w-2 rounded-full bg-[var(--accent)]" />
        <span>{t('github.syncBanner.pending')}</span>
      </div>
    );
  }

  if (state.kind === 'no-change') {
    return (
      <div className="rounded-[var(--radius)] border border-[rgba(48,209,88,0.32)] bg-[rgba(48,209,88,0.08)] px-3 py-2 text-sm text-[#c9f3d6]">
        <div className="font-medium">{t('github.syncBanner.noChangeTitle')}</div>
        <div className="mt-0.5 text-[12px] opacity-80">
          {t('github.syncBanner.noChangeDesc')}
          {status?.latestTrafficDate
            ? t('github.syncBanner.noChangeLatest', { date: status.latestTrafficDate })
            : ''}
          .
        </div>
      </div>
    );
  }

  if (state.kind === 'updated') {
    const parts: string[] = [];
    if (state.delta.newRepos !== 0) {
      parts.push(
        t('github.syncBanner.deltaRepos', {
          sign: state.delta.newRepos > 0 ? '+' : '',
          n: state.delta.newRepos,
        }),
      );
    }
    if (state.delta.newTrafficRows !== 0) {
      parts.push(t('github.syncBanner.deltaTrafficRows', { n: state.delta.newTrafficRows }));
    }
    if (state.delta.newHeatmapDays !== 0) {
      parts.push(t('github.syncBanner.deltaHeatmapDays', { n: state.delta.newHeatmapDays }));
    }
    if (state.delta.heatmapTotalDelta !== 0) {
      parts.push(
        t('github.syncBanner.deltaContribs', {
          sign: state.delta.heatmapTotalDelta > 0 ? '+' : '',
          n: state.delta.heatmapTotalDelta,
        }),
      );
    }
    if (state.delta.latestTrafficDateChanged && status?.latestTrafficDate) {
      parts.push(t('github.syncBanner.deltaLatestTraffic', { date: status.latestTrafficDate }));
    }

    return (
      <div className="rounded-[var(--radius)] border border-[rgba(100,210,255,0.32)] bg-[var(--accent-soft)] px-3 py-2 text-sm text-[#cfecff]">
        <div className="font-medium">
          {t('github.syncBanner.updatedTitle', {
            parts: parts.join(' · ') || t('github.syncBanner.updatedNoDelta'),
          })}
        </div>
        <div className="mt-0.5 text-[12px] opacity-80">
          {t('github.syncBanner.updatedApiLine', {
            repos: state.synced.repos,
            trafficRepos: state.synced.trafficRepos,
            trafficDays: state.synced.trafficDays,
            errors: state.synced.trafficErrors,
          })}
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-[var(--radius)] border border-[rgba(255,69,58,0.32)] bg-[rgba(255,69,58,0.08)] px-3 py-2 text-sm text-[#ffc6c1]">
      <div className="font-medium">{t('github.syncBanner.errorTitle')}</div>
      <div className="mt-0.5 text-[12px] opacity-80">{state.message}</div>
    </div>
  );
}

type Translator = (key: string, vars?: Record<string, string | number>) => string;

const SYNC_KIND_LABELS: Record<SyncLogKind, string> = {
  'github-all': 'GitHub · sync complet',
  repos: 'GitHub · repos',
  traffic: 'GitHub · trafic',
  heatmap: 'GitHub · heatmap',
  npm: 'npm · downloads',
};

const SYNC_TRIGGER_LABELS: Record<SyncLogTrigger, string> = {
  manual: 'manuel',
  auto: 'auto',
  background: 'bg',
};

function syncStatusTone(status: SyncLogStatus): 'success' | 'warn' | 'danger' | 'neutral' {
  switch (status) {
    case 'ok':
      return 'success';
    case 'no-change':
      return 'neutral';
    case 'partial':
      return 'warn';
    case 'error':
      return 'danger';
  }
}

function SyncLogPanel({
  entries,
  status,
  filter,
  onFilterChange,
  onRefresh,
  onRefreshNpm,
  onSyncGithub,
  isSyncing,
  isRefreshingNpm,
  t,
}: {
  entries: SyncLogEntry[];
  status: GithubStatus | null;
  filter: 'all' | 'github' | 'npm' | 'heatmap';
  onFilterChange: (value: 'all' | 'github' | 'npm' | 'heatmap') => void;
  onRefresh: () => void;
  onRefreshNpm: () => void;
  onSyncGithub: () => void;
  isSyncing: boolean;
  isRefreshingNpm: boolean;
  t: Translator;
}) {
  const filtered = entries.filter((entry) => {
    if (filter === 'all') return true;
    if (filter === 'heatmap') return entry.kind === 'heatmap';
    if (filter === 'npm') return entry.kind === 'npm';
    return entry.kind !== 'npm' && entry.kind !== 'heatmap';
  });

  const sources: Array<{
    key: 'repos' | 'traffic' | 'heatmap' | 'npm';
    label: string;
    at: number | null;
  }> = [
    { key: 'repos', label: 'repos', at: status?.reposLastSync ?? null },
    { key: 'traffic', label: 'traffic', at: status?.trafficLastSync ?? null },
    { key: 'heatmap', label: 'heatmap', at: status?.heatmapLastSync ?? null },
    {
      key: 'npm',
      label: 'npm',
      at: deriveLatestByKind(entries, 'npm'),
    },
  ];

  return (
    <Section
      title={t('github.syncLog.title')}
      meta={t('github.syncLog.meta', { count: filtered.length })}
      action={
        <div className="flex items-center gap-2">
          <Button tone="ghost" onClick={onRefresh} title="refresh log">
            ↻
          </Button>
          <Button
            tone="ghost"
            onClick={onRefreshNpm}
            disabled={isRefreshingNpm}
            title="refresh npm"
          >
            {isRefreshingNpm ? '…' : 'npm'}
          </Button>
          <Button tone="accent" onClick={onSyncGithub} disabled={isSyncing} title="sync github">
            {isSyncing ? '…' : 'GH'}
          </Button>
        </div>
      }
    >
      <Card>
        <div className="mb-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
          {sources.map((source) => (
            <SourceFreshnessPill key={source.key} label={source.label} at={source.at} t={t} />
          ))}
        </div>

        <Toolbar>
          <Segmented<'all' | 'github' | 'npm' | 'heatmap'>
            value={filter}
            options={[
              { value: 'all', label: t('github.syncLog.filters.all') },
              { value: 'github', label: 'GitHub' },
              { value: 'heatmap', label: 'heatmap' },
              { value: 'npm', label: 'npm' },
            ]}
            onChange={onFilterChange}
          />
        </Toolbar>

        {filtered.length === 0 ? (
          <div className="mt-3">
            <Empty>{t('github.syncLog.empty')}</Empty>
          </div>
        ) : (
          <ul className="mt-3 max-h-[420px] space-y-2 overflow-y-auto pr-1">
            {filtered.map((entry) => (
              <SyncLogRow key={entry.id} entry={entry} t={t} />
            ))}
          </ul>
        )}
      </Card>
    </Section>
  );
}

function deriveLatestByKind(entries: SyncLogEntry[], kind: SyncLogKind): number | null {
  for (const entry of entries) {
    if (entry.kind === kind && entry.status !== 'error') {
      return entry.at;
    }
  }
  return null;
}

function SourceFreshnessPill({
  label,
  at,
  t,
}: {
  label: string;
  at: number | null;
  t: Translator;
}) {
  const tone: 'success' | 'warn' | 'danger' | 'neutral' = !at
    ? 'neutral'
    : Math.floor(Date.now() / 1000) - at < 60 * 60
      ? 'success'
      : Math.floor(Date.now() / 1000) - at < 24 * 3600
        ? 'warn'
        : 'danger';
  return (
    <div className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-1)] px-2.5 py-1.5">
      <div className="flex items-center gap-1.5">
        <Dot tone={tone} />
        <span className="text-[11px] uppercase tracking-[0.08em] text-[var(--text-dim)]">
          {label}
        </span>
      </div>
      <div className="mt-0.5 truncate text-[11px] text-[var(--text-mute)]">
        {at ? relativeTime(at, t) : '—'}
      </div>
    </div>
  );
}

function SyncLogRow({ entry, t }: { entry: SyncLogEntry; t: Translator }) {
  const tone = syncStatusTone(entry.status);
  const borderTone =
    tone === 'success'
      ? 'border-l-[#30d158]'
      : tone === 'warn'
        ? 'border-l-[#ffd60a]'
        : tone === 'danger'
          ? 'border-l-[#ff453a]'
          : 'border-l-[var(--border-strong)]';

  return (
    <li
      className={`rounded-[var(--radius)] border border-[var(--border)] border-l-2 bg-[var(--surface-1)] px-3 py-2 ${borderTone}`}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-[13px] font-medium text-[var(--text)]">
            {SYNC_KIND_LABELS[entry.kind] || entry.kind}
          </span>
          <Chip className="text-[10.5px]">{SYNC_TRIGGER_LABELS[entry.trigger]}</Chip>
          <Chip tone={tone} className="text-[10.5px]">
            {entry.status}
          </Chip>
        </div>
        <span
          className="num shrink-0 text-[11px] text-[var(--text-dim)]"
          title={new Date(entry.at * 1000).toLocaleString(dateLocale(currentLocale()))}
        >
          {relativeTime(entry.at, t)}
        </span>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-[var(--text-dim)]">
        {entry.durationMs !== null ? (
          <span className="num text-[var(--text-mute)]">{formatDuration(entry.durationMs)}</span>
        ) : null}
        <SyncSummary entry={entry} />
      </div>
    </li>
  );
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.round(ms / 1000)} s`;
}

function SyncSummary({ entry }: { entry: SyncLogEntry }) {
  const s = entry.summary || {};

  if (entry.status === 'error') {
    return (
      <span className="truncate text-[#ffc6c1]" title={String(s.error || '')}>
        {String(s.error || 'erreur inconnue')}
      </span>
    );
  }

  if (entry.kind === 'github-all') {
    const delta = (s.delta as Record<string, unknown>) || {};
    const synced = (s.synced as Record<string, unknown>) || {};
    const parts: string[] = [];
    if (Number(delta.newRepos) > 0) parts.push(`+${Number(delta.newRepos)} repos`);
    if (Number(delta.newTrafficRows) > 0)
      parts.push(`+${Number(delta.newTrafficRows)} traffic rows`);
    if (Number(delta.newTrafficRepos) > 0)
      parts.push(`+${Number(delta.newTrafficRepos)} traffic repos`);
    if (Number(delta.newHeatmapDays) > 0) parts.push(`+${Number(delta.newHeatmapDays)} jours`);
    if (Number(delta.heatmapTotalDelta) !== 0)
      parts.push(`Δcontribs ${Number(delta.heatmapTotalDelta)}`);
    if (Number(synced.trafficErrors) > 0)
      parts.push(`${Number(synced.trafficErrors)} erreurs trafic`);
    if (parts.length === 0)
      parts.push(`${Number(synced.repos) || 0} repos · ${Number(synced.trafficRepos) || 0} trafic`);
    return <SummaryLine parts={parts} />;
  }

  if (entry.kind === 'heatmap') {
    const parts: string[] = [];
    if (Number(s.daysDelta) > 0) parts.push(`+${Number(s.daysDelta)} jours`);
    if (Number(s.totalDelta) !== 0) parts.push(`Δcontribs ${Number(s.totalDelta)}`);
    if (s.year) parts.push(String(s.year));
    if (parts.length === 0) parts.push(`${Number(s.heatmapDays) || 0} jours en base`);
    return <SummaryLine parts={parts} />;
  }

  if (entry.kind === 'npm') {
    const parts: string[] = [];
    if (Number(s.updated) > 0) parts.push(`${Number(s.updated)} pkgs màj`);
    if (Number(s.skipped) > 0) parts.push(`${Number(s.skipped)} skip`);
    if (Number(s.notFound) > 0) parts.push(`${Number(s.notFound)} not_found`);
    if (parts.length === 0) parts.push('aucun changement');
    return <SummaryLine parts={parts} />;
  }

  return null;
}

function SummaryLine({ parts }: { parts: string[] }) {
  return (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[var(--text-mute)]">
      {parts.map((part, idx) => (
        <span key={`${idx}-${part}`} className="num">
          {part}
        </span>
      ))}
    </span>
  );
}

function RepoSparklineCard({
  rank,
  repoName,
  repoUrl,
  values,
  metric,
  sort,
  windowDays,
  windowTotal,
  cumulative,
  recent14,
  lastDate,
}: {
  rank: number;
  repoName: string;
  repoUrl: string | null;
  values: number[];
  metric: SparkMetric;
  sort: SparkSort;
  windowDays: number;
  windowTotal: number;
  cumulative: number;
  recent14: number;
  lastDate: string | null;
}) {
  const width = 80;
  const height = 20;
  const path = sparklinePath(values, width, height);
  const stroke = metric === 'clones' ? '#30d158' : '#64d2ff';
  const tooltip = `#${rank} · ${repoName} · ${metric} · ${windowDays}d ${windowTotal} · 14d ${recent14} · Σ ${cumulative}${lastDate ? ` · ${lastDate}` : ''}`;
  // Highlight the top 3 ranks visually — aligns with the “leaderboard” intent
  // that was previously carried by the Top clones cumulés section.
  const isTop = rank <= 3;
  const rankColor =
    rank === 1
      ? '#ffd60a'
      : rank === 2
        ? 'var(--text-dim)'
        : rank === 3
          ? '#c98306'
          : 'var(--text-faint)';

  // Highlight the metric that is driving the current sort. This makes the
  // Cumul/Fenêtre toggle tangible even when the top ranks dominate both
  // dimensions (same order in either sort).
  const windowActive = sort === 'window';
  const cumulativeActive = sort === 'cumulative';

  const content = (
    <div
      className="grid grid-cols-[22px_minmax(0,1fr)_auto_80px] items-center gap-2 rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-1)] px-2 py-1 text-[12px] transition hover:border-[var(--border-strong)] hover:bg-[var(--surface-2)]"
      title={tooltip}
    >
      <span
        className={`num text-[10px] tabular-nums ${isTop ? 'font-semibold' : ''}`}
        style={{ color: rankColor }}
      >
        #{rank}
      </span>
      <span className="truncate font-medium text-[var(--text)]">{repoName}</span>
      <span className="num shrink-0 text-[11px] tabular-nums">
        <span
          className={windowActive ? 'font-semibold text-[var(--text)]' : 'text-[var(--text-faint)]'}
        >
          {numberLabel(windowTotal)}
        </span>
        <span className="mx-1 text-[var(--text-faint)]">·</span>
        <span
          className={
            cumulativeActive ? 'font-semibold text-[var(--text)]' : 'text-[var(--text-faint)]'
          }
        >
          <span className="text-[var(--text-faint)]">Σ</span> {numberLabel(cumulative)}
        </span>
      </span>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="h-5 w-full"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <path d={path} fill="none" stroke={stroke} strokeWidth={1.4} />
      </svg>
    </div>
  );

  if (repoUrl) {
    return (
      <a href={repoUrl} target="_blank" rel="noreferrer" className="block">
        {content}
      </a>
    );
  }
  return content;
}

type NpmStats = {
  totals: {
    last_day: number;
    last_week: number;
    last_month: number;
    cumul_local: number;
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

function NpmDownloadsStat({ deltaWindowDays }: { deltaWindowDays: number }) {
  const [data, setData] = useState<NpmStats | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    apiGet<NpmStats>('/api/github/npm')
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch(() => {
        /* silent — keeps card in loading state */
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const periodKey: 'last_day' | 'last_week' | 'last_month' =
    deltaWindowDays === 1 ? 'last_day' : deltaWindowDays <= 7 ? 'last_week' : 'last_month';
  const headline = data ? data.totals[periodKey] : 0;
  const publishedCount = data?.published.length ?? 0;

  // Show the two non-selected periods so the user has the full picture; the
  // selected one is already the headline.
  const secondary: Array<{ label: string; value: number }> = data
    ? [
        { label: '1j', value: data.totals.last_day },
        { label: '7j', value: data.totals.last_week },
        { label: '30j', value: data.totals.last_month },
      ].filter((r) => r.label !== `${deltaWindowDays}j`)
    : [];

  const cumul = data?.totals.cumul_local ?? 0;
  const showCumul = cumul > 0;

  return (
    <Stat
      label={`npm · ${deltaWindowDays}j`}
      value={loading && !data ? '…' : numberLabel(headline)}
      hint={
        data ? (
          <div className="flex flex-col gap-0.5 text-[11px]">
            <div className="num flex flex-wrap items-center gap-x-1.5 tabular-nums text-[var(--text-dim)]">
              {secondary.map((row, i) => (
                <span key={row.label} className="inline-flex items-center gap-1">
                  {i > 0 ? <span className="text-[var(--text-faint)]">·</span> : null}
                  <span className="text-[var(--text-faint)]">{row.label}</span>
                  <span>{numberLabel(row.value)}</span>
                </span>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-x-1.5 text-[var(--text-faint)]">
              {showCumul ? (
                <span
                  className="num tabular-nums text-[var(--text-dim)]"
                  title={`Cumul local sur ${data.totals.cumul_days} j`}
                >
                  Σ {numberLabel(cumul)}
                </span>
              ) : null}
              {showCumul ? <span>·</span> : null}
              <span>
                {publishedCount} pkg{publishedCount > 1 ? 's' : ''}
              </span>
            </div>
          </div>
        ) : null
      }
    />
  );
}

function DeltaHint({
  delta,
  period,
}: {
  delta: { current: number; previous: number; pct: number; positive: boolean };
  period: 'day' | 'week' | 'month';
}) {
  const { t } = useTranslation();
  const label =
    period === 'day'
      ? t('github.deltaHint.suffixDay')
      : period === 'week'
        ? t('github.deltaHint.suffixWeek')
        : t('github.deltaHint.suffixMonth');
  if (delta.current === 0 && delta.previous === 0) {
    return <span className="text-[var(--text-dim)]">— · {label}</span>;
  }
  const sign = delta.positive ? '+' : '';
  const rounded = Math.round(delta.pct);
  const tone = delta.positive ? 'text-[#30d158]' : 'text-[#ff453a]';
  const arrow = delta.positive ? '↑' : '↓';
  return (
    <span className={tone}>
      {arrow} {sign}
      {rounded}% · {label}
    </span>
  );
}
