import { useEffect, useMemo, useState } from 'react';
import { Heatmap } from '../components/Heatmap';
import { HeatmapStackedBars } from '../components/HeatmapStackedBars';
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
import type { StackedDailyRow } from '../lib/cumulStacks';
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
  // Surfaced by server from github_repos.topics_json (parsed at response
  // time). Empty array if none; optional for backward-compat with cached
  // responses from older servers.
  topics?: string[];
  is_fork?: boolean;
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

type RepoMetricsRow = {
  repo: string;
  // 4 parallel arrays, each of length `days`, aligned on the same date list.
  // Missing days are zero-filled server-side so bar widths stay consistent
  // across repos.
  views: number[];
  clones: number[];
  commits: number[];
  npm: number[];
};

type RepoMetricsResponse = {
  days: number;
  cutoff: string;
  dates: string[];
  repos: RepoMetricsRow[];
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

/**
 * Returns the most recent date in `series` that isn't a "pending" zero.
 *
 * Why this exists: GitHub traffic is aggregated at UTC midnight with ~24h
 * latency. A sync run mid-day writes a `today` row at 0 because GitHub hasn't
 * aggregated yet. KPIs anchored naively on `max(date <= today)` then flash
 * `-100%` and promote the wrong repo as "top" until GitHub catches up.
 *
 * When `skipPendingToday` is set and today's summed value is zero while a
 * prior non-zero day exists, fall back to the last day we actually have data
 * for. Contribution-style series (zero-commit days are genuinely zero, not
 * pending) should pass `skipPendingToday = false`.
 */
function latestRealDate(
  series: Iterable<{ date: string; value: number }>,
  todayIso: string,
  skipPendingToday: boolean,
): string {
  let maxDate = '';
  let todaySum = 0;
  let fallback = '';
  for (const row of series) {
    if (row.date > todayIso) continue;
    if (row.date > maxDate) maxDate = row.date;
    if (row.date === todayIso) {
      todaySum += row.value;
    } else if (row.value > 0 && row.date > fallback) {
      fallback = row.date;
    }
  }
  const latest = maxDate || todayIso;
  if (skipPendingToday && latest === todayIso && todaySum === 0 && fallback) {
    return fallback;
  }
  return latest;
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

// Traffic freshness traffic-light for a repo. lastDate is the newest traffic
// snapshot GitHub has for that repo; a missing or old date means traction
// has gone dark. Tones mirror the Dot component's palette.
function trafficFreshnessTone(lastDate: string | null | undefined): 'success' | 'warn' | 'danger' {
  if (!lastDate) return 'danger';
  const last = new Date(`${lastDate}T00:00:00Z`).getTime();
  const now = Date.now();
  if (Number.isNaN(last)) return 'danger';
  const ageDays = Math.max(0, (now - last) / 86_400_000);
  if (ageDays < 3) return 'success';
  if (ageDays < 7) return 'warn';
  return 'danger';
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
  const [repoMetrics, setRepoMetrics] = useState<RepoMetricsResponse | null>(null);
  // Kept as a string key so it slots into Segmented<T extends string>.
  // Coerced to number at the fetch boundary and when the children need it.
  const [repoMetricsDays, setRepoMetricsDays] = useState<'14' | '30' | '90' | '365'>('14');
  const repoMetricsDaysNum = Number(repoMetricsDays);
  const [status, setStatus] = useState<GithubStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncBanner, setSyncBanner] = useState<SyncBannerState>({ kind: 'idle' });
  const [, setNowTick] = useState(0);
  // Default to 'stars' so the most starred repos lead the module — matches
  // the user's expectation that the Repos section opens on the top 3 stars,
  // mirroring the sparklines module's collapsed-by-default UX.
  const [repoSort, setRepoSort] = useState<RepoSort>('stars');
  // Collapsed by default, mirrors the sparklines module: 3 visible rows,
  // expand to 30. Cap of 30 keeps DOM bounded on big accounts.
  const [reposExpanded, setReposExpanded] = useState(false);
  const [query, setQuery] = useState('');
  const [sparkMetric, setSparkMetric] = useState<SparkMetric>('clones');
  const [sparkWindowDays, setSparkWindowDays] = useState<number>(30);
  const [sparkSort, setSparkSort] = useState<SparkSort>('cumulative');
  const [sparkFilter, setSparkFilter] = useState('');
  const [sparkOnlyTraffic, setSparkOnlyTraffic] = useState(true);
  // Collapsed by default — module shows only the top 3 to keep the page
  // scannable. The user clicks "Voir les autres" to reveal the long tail
  // (capped at 30 below). The toggle is intentionally NOT persisted across
  // reloads: a fresh page should start clean, the user re-opens if useful.
  const [sparkExpanded, setSparkExpanded] = useState(false);
  const [heatmapMetric, setHeatmapMetric] = useState<'contrib' | 'views' | 'clones' | 'npm'>(
    'contrib',
  );
  const [heatmapView, setHeatmapView] = useState<'grid' | 'line'>('grid');
  // Granularity for the cumulative stacked-bars view. Defaults to month —
  // 12 columns reads cleanly. 'day' is dense (365 thin bars) but useful for
  // recent activity; 'week' (~52 bars) catches the weekly cadence; 'biweekly'
  // (14 j, ~26 bars) smooths it; 'quarter' compresses to 4 chunky bars.
  const [heatmapBucket, setHeatmapBucket] = useState<
    'day' | 'week' | 'biweekly' | 'month' | 'quarter'
  >('month');
  const [npmDaily, setNpmDaily] = useState<Array<{ date: string; count: number }>>([]);
  // Per-repo per-day npm downloads for the cumulative stacked-bars view.
  // Loaded in parallel with the other GitHub fetches; falls back to the
  // aggregate `npmDaily` shape (single "all" series) when this is empty
  // (e.g. fresh install before the npm sync ran).
  const [npmDailyByRepo, setNpmDailyByRepo] = useState<
    Array<{ date: string; repo: string; downloads: number }>
  >([]);
  const [deltaPeriod, setDeltaPeriod] = useState<'day' | 'week' | 'month' | 'all'>('week');

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
        npmByRepoData,
      ] = await Promise.all([
        apiGet<HeatmapResponse>('/api/github/heatmap'),
        apiGet<Repo[]>('/api/github/repos'),
        apiGet<TrafficResponse>('/api/github/traffic?days=14'),
        // 365 days so the annual cumulative-by-repo stacked bars (Courbe view)
        // covers every month of the displayed year, not just the recent quarter.
        apiGet<TrafficTimeseriesResponse>('/api/github/traffic/timeseries?days=365'),
        apiGet<GithubStatus>('/api/github/status'),
        apiGet<{ rows: Array<{ date: string; downloads: number }> }>('/api/github/npm/daily').catch(
          () => ({ rows: [] }),
        ),
        // Per-repo per-day npm for the cumulative stacked bars. Same window
        // as traffic timeseries. Failure is non-fatal: the chart silently
        // falls back to the single-key "all" series built from npmDaily.
        apiGet<{ rows: Array<{ date: string; repo: string; downloads: number }> }>(
          '/api/github/npm/daily-by-repo?days=365',
        ).catch(() => ({ rows: [] })),
      ]);
      setHeatmap(heatmapData);
      setRepos(reposData);
      setTraffic(trafficData);
      setTrafficSeries(trafficSeriesData);
      setStatus(statusData);
      setNpmDaily(npmDailyData.rows.map((r) => ({ date: r.date, count: r.downloads })));
      setNpmDailyByRepo(npmByRepoData.rows);
    } catch (e) {
      setError(String(e));
    }
  }

  useEffect(() => {
    void load();
  }, []);

  useEffect(() => {
    const id = setInterval(() => setNowTick((n) => n + 1), 30_000);
    return () => clearInterval(id);
  }, []);

  // Repo-metrics fetch is decoupled from the main load() because the user
  // toggles the window (14/30/90/365) independently — no need to re-fetch
  // repos/traffic/heatmap every time the mini-chart range changes.
  useEffect(() => {
    let cancelled = false;
    apiGet<RepoMetricsResponse>(`/api/github/repo-metrics?days=${repoMetricsDays}`)
      .then((data) => {
        if (!cancelled) setRepoMetrics(data);
      })
      .catch(() => {
        if (!cancelled) setRepoMetrics(null);
      });
    return () => {
      cancelled = true;
    };
  }, [repoMetricsDays]);

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

  // Per-repo 14-day sparkline arrays, anchored on today (UTC). Missing days
  // become zeros so all repos share the same x-scale and shapes are visually
  // comparable. Built from the already-fetched 120-day timeseries, so no
  // extra request.
  const repoMetricsByName = useMemo(() => {
    const map = new Map<string, RepoMetricsRow>();
    if (!repoMetrics) return map;
    for (const row of repoMetrics.repos) map.set(row.repo, row);
    return map;
  }, [repoMetrics]);

  const trafficSparkByRepo = useMemo(() => {
    const out = new Map<string, { views: number[]; clones: number[] }>();
    if (!trafficSeries) return out;
    const todayIso = toIsoDate(new Date());
    const dateWindow = buildDateWindow(todayIso, 14);
    const perRepoDate = new Map<string, Map<string, { v: number; c: number }>>();
    for (const row of trafficSeries.rows) {
      let m = perRepoDate.get(row.repo);
      if (!m) {
        m = new Map();
        perRepoDate.set(row.repo, m);
      }
      const prev = m.get(row.date);
      m.set(row.date, {
        v: (prev?.v ?? 0) + (row.viewsCount ?? 0),
        c: (prev?.c ?? 0) + (row.clonesCount ?? 0),
      });
    }
    for (const [repo, dateMap] of perRepoDate) {
      out.set(repo, {
        views: dateWindow.map((d) => dateMap.get(d)?.v ?? 0),
        clones: dateWindow.map((d) => dateMap.get(d)?.c ?? 0),
      });
    }
    return out;
  }, [trafficSeries]);

  const repoByName = useMemo(() => {
    const map = new Map<string, Repo>();
    for (const repo of repos) {
      map.set(repo.name, repo);
    }
    return map;
  }, [repos]);

  // Delta % current window vs previous window of same length.
  // 'all' collapses the window to "since the earliest data point" — 10 years
  // is more than enough for any portfolio the dashboard handles today.
  // Cutoffs computed with this value effectively include everything.
  const deltaWindowDays =
    deltaPeriod === 'day'
      ? 1
      : deltaPeriod === 'week'
        ? 7
        : deltaPeriod === 'month'
          ? 30
          : 10 * 365;
  const isAllTime = deltaPeriod === 'all';
  // Suffix shown in Stat labels: "· 30 j" becomes "· all" in all-time mode.
  const deltaLabelSuffix = isAllTime ? t('common.allTime') : `${deltaWindowDays}j`;

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
    const todayIso = toIsoDate(new Date());
    // Anchor on the last day with real traffic so a freshly-synced, still-
    // aggregating today doesn't surface a zero-everywhere "top" repo.
    const perDate = new Map<string, number>();
    for (const row of rows) {
      const cur = perDate.get(row.date) || 0;
      perDate.set(row.date, cur + Number(row.viewsCount || 0) + Number(row.clonesCount || 0));
    }
    const latest = latestRealDate(
      [...perDate.entries()].map(([date, value]) => ({ date, value })),
      todayIso,
      true,
    );
    const startIso = addUtcDays(latest, -(deltaWindowDays - 1));
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
    // Drop repos with zero traffic: a 1-day window where every repo is zero
    // would still promote entries[0] as the "top", which is misleading.
    const nonZero = entries.filter((e) => e.total > 0);
    nonZero.sort((a, b) => b.total - a.total);
    return nonZero[0] || null;
  }, [trafficSeries, deltaWindowDays]);

  const dailyDeltas = useMemo(() => {
    const sumRange = (series: Array<{ date: string; count: number }>, from: string, to: string) =>
      series.reduce((acc, row) => (row.date >= from && row.date <= to ? acc + row.count : acc), 0);

    const todayIso = toIsoDate(new Date());
    const computeDelta = (
      series: Array<{ date: string; count: number }>,
      skipPendingToday = false,
    ) => {
      const latest = latestRealDate(
        series.map((r) => ({ date: r.date, value: r.count })),
        todayIso,
        skipPendingToday,
      );
      const currentEnd = latest;
      const currentStart = addUtcDays(latest, -(deltaWindowDays - 1));
      const previousEnd = addUtcDays(currentStart, -1);
      const previousStart = addUtcDays(previousEnd, -(deltaWindowDays - 1));

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
      views: computeDelta(toSeries(viewsSeries), true),
      clones: computeDelta(toSeries(clonesSeries), true),
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

  /**
   * Per-repo per-day series for the cumulative stacked-bars view (Courbe).
   * Only views / clones expose a per-repo breakdown via the timeseries
   * endpoint. Contribs (heatmap) and aggregated npm/daily collapse to a
   * single synthetic "all" key — the stacked component degrades to a
   * monochrome column histogram in that case, which still reads correctly.
   */
  const trafficStackedDaily = useMemo(() => {
    const views: StackedDailyRow[] = [];
    const clones: StackedDailyRow[] = [];
    if (trafficSeries) {
      const viewsBag = new Map<string, Record<string, number>>();
      const clonesBag = new Map<string, Record<string, number>>();
      for (const row of trafficSeries.rows) {
        if (row.viewsCount && row.viewsCount > 0) {
          const m = viewsBag.get(row.date) ?? {};
          m[row.repo] = (m[row.repo] ?? 0) + Number(row.viewsCount);
          viewsBag.set(row.date, m);
        }
        if (row.clonesCount && row.clonesCount > 0) {
          const m = clonesBag.get(row.date) ?? {};
          m[row.repo] = (m[row.repo] ?? 0) + Number(row.clonesCount);
          clonesBag.set(row.date, m);
        }
      }
      for (const [date, values] of viewsBag) views.push({ date, values });
      for (const [date, values] of clonesBag) clones.push({ date, values });
      views.sort((a, b) => a.date.localeCompare(b.date));
      clones.sort((a, b) => a.date.localeCompare(b.date));
    }
    const contribDaily: StackedDailyRow[] = (heatmap?.days ?? [])
      .filter((d) => d.count > 0)
      .map((d) => ({ date: d.date, values: { all: d.count } }));

    // npm: prefer the per-repo breakdown when available so the cumulative
    // stacked bars colour-segment by package. Falls back to the aggregated
    // single-key "all" series from `npmDaily` when the per-repo endpoint
    // returned [] (typical on a fresh install before the npm sync ran).
    let npmStackedDaily: StackedDailyRow[];
    if (npmDailyByRepo.length > 0) {
      const npmBag = new Map<string, Record<string, number>>();
      for (const row of npmDailyByRepo) {
        if (!row.downloads || row.downloads <= 0) continue;
        const m = npmBag.get(row.date) ?? {};
        m[row.repo] = (m[row.repo] ?? 0) + Number(row.downloads);
        npmBag.set(row.date, m);
      }
      npmStackedDaily = [...npmBag.entries()]
        .map(([date, values]) => ({ date, values }))
        .sort((a, b) => a.date.localeCompare(b.date));
    } else {
      npmStackedDaily = npmDaily
        .filter((d) => d.count > 0)
        .map((d) => ({ date: d.date, values: { all: d.count } }));
    }

    return { views, clones, contrib: contribDaily, npm: npmStackedDaily };
  }, [trafficSeries, heatmap?.days, npmDaily, npmDailyByRepo]);

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
          <Segmented<'day' | 'week' | 'month' | 'all'>
            value={deltaPeriod}
            options={[
              { value: 'day', label: t('common.day') },
              { value: 'week', label: t('common.week') },
              { value: 'month', label: t('common.month') },
              { value: 'all', label: t('common.allTime') },
            ]}
            onChange={setDeltaPeriod}
          />
        </div>

        <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-4">
          <Stat
            label={`${t('github.stats.contribs')} · ${deltaLabelSuffix}`}
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
            label={`Fraîcheur · ${deltaLabelSuffix}`}
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
                    aucun push sur {deltaLabelSuffix}
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
          <NpmDownloadsStat
            deltaWindowDays={deltaWindowDays}
            isAllTime={isAllTime}
            labelSuffix={deltaLabelSuffix}
          />
          <Stat
            label={`Views · ${deltaLabelSuffix}`}
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
            label={`Clones · ${deltaLabelSuffix}`}
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
            label={`Top repo · ${deltaLabelSuffix}`}
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
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
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
              <div className="flex flex-wrap items-center gap-2">
                {/* Granularity picker for the cumulative stacked-bars view.
                    Hidden when grid is selected since the grid is always daily. */}
                {heatmapView === 'line' ? (
                  <Segmented<'day' | 'week' | 'biweekly' | 'month' | 'quarter'>
                    value={heatmapBucket}
                    options={[
                      { value: 'day', label: t('github.heatmap.bucketDay') },
                      { value: 'week', label: t('github.heatmap.bucketWeek') },
                      { value: 'biweekly', label: t('github.heatmap.bucketBiweekly') },
                      { value: 'month', label: t('github.heatmap.bucketMonth') },
                      { value: 'quarter', label: t('github.heatmap.bucketQuarter') },
                    ]}
                    onChange={setHeatmapBucket}
                  />
                ) : null}
                <Segmented<'grid' | 'line'>
                  value={heatmapView}
                  options={[
                    { value: 'grid', label: t('github.heatmap.viewGrid') },
                    { value: 'line', label: t('github.heatmap.viewLine') },
                  ]}
                  onChange={setHeatmapView}
                />
              </div>
            </div>
            {(() => {
              // Single source of (days, palette, label, stackedDaily) — both
              // views share the exact same input so switching grid↔line never
              // diverges. `stackedDaily` is only consumed by the cumulative
              // bars view; the grid view ignores it.
              const config =
                heatmapMetric === 'contrib'
                  ? {
                      days: heatmap?.days || [],
                      stackedDaily: trafficStackedDaily.contrib,
                      palette: 'github' as const,
                      label: t('github.heatmap.totalContribs'),
                    }
                  : heatmapMetric === 'views'
                    ? {
                        days: trafficHeatmapDays.views,
                        stackedDaily: trafficStackedDaily.views,
                        palette: 'cyan' as const,
                        label: t('github.heatmap.totalViews'),
                      }
                    : heatmapMetric === 'clones'
                      ? {
                          days: trafficHeatmapDays.clones,
                          stackedDaily: trafficStackedDaily.clones,
                          palette: 'amber' as const,
                          label: t('github.heatmap.totalClones'),
                        }
                      : {
                          days: trafficHeatmapDays.npm,
                          stackedDaily: trafficStackedDaily.npm,
                          palette: 'magenta' as const,
                          label: 'downloads',
                        };
              if (heatmapView === 'grid') {
                return (
                  <Heatmap days={config.days} palette={config.palette} totalLabel={config.label} />
                );
              }
              // Cumulative stacked bars per project, granularity from the
              // user's bucket toggle. The X axis runs from Jan 1 of the
              // displayed year to TODAY (clamped) — past today is the future,
              // we don't render forward-extrapolated buckets that would just
              // carry the cumul flat and look like duplicate columns.
              const year = heatmap?.year || new Date().getUTCFullYear();
              const todayIso = new Date().toISOString().slice(0, 10);
              const yearEnd = `${year}-12-31`;
              const toDate = todayIso < yearEnd ? todayIso : yearEnd;
              return (
                <HeatmapStackedBars
                  daily={config.stackedDaily}
                  fromDate={`${year}-01-01`}
                  toDate={toDate}
                  groupBy={heatmapBucket}
                  cumulative
                  scheme={config.palette}
                  totalLabel={config.label}
                />
              );
            })()}
          </Card>
        </Section>
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
              className="w-full sm:min-w-[220px] sm:flex-1"
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

          {(() => {
            // Collapse-by-default. Show top 3 unless the user explicitly
            // expands (then show up to 30). The cap of 30 stays in place to
            // bound DOM size on accounts with hundreds of forks.
            const COLLAPSED_COUNT = 3;
            const EXPANDED_COUNT = 30;
            const totalAvailable = Math.min(sparkRows.rows.length, EXPANDED_COUNT);
            const visibleRows = sparkExpanded
              ? sparkRows.rows.slice(0, EXPANDED_COUNT)
              : sparkRows.rows.slice(0, COLLAPSED_COUNT);
            const hiddenCount = totalAvailable - visibleRows.length;
            return (
              <>
                <div className="mt-3 grid grid-cols-1 gap-1 md:grid-cols-2 xl:grid-cols-3">
                  {visibleRows.map((row, index) => (
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
                  {sparkRows.rows.length === 0 ? (
                    <Empty>{t('github.sparklines.empty')}</Empty>
                  ) : null}
                </div>
                {/* Expand/collapse trigger. Hidden when there's nothing more
                    to show (≤ COLLAPSED_COUNT rows) so the button never
                    promises content that doesn't exist. */}
                {totalAvailable > COLLAPSED_COUNT ? (
                  <div className="mt-2 flex justify-center">
                    <Button
                      tone="ghost"
                      onClick={() => setSparkExpanded((v) => !v)}
                      className="!py-1 !text-[11px]"
                    >
                      {sparkExpanded
                        ? t('github.sparklines.collapse')
                        : t('github.sparklines.expand', { n: hiddenCount })}
                    </Button>
                  </div>
                ) : null}
              </>
            );
          })()}
        </Card>
      </Section>

      <Section
        title={t('github.repos.title')}
        meta={t('github.repos.meta', { filtered: filteredRepos.length, total: repos.length })}
      >
        <Card>
          <Toolbar>
            <input
              className="w-full sm:min-w-[220px] sm:flex-1"
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
            {/* Unified window selector for the 4 per-repo mini bar charts
                (NPM / views / clones / commits). Re-fetches a single endpoint
                that returns all 4 zero-filled vectors per repo. */}
            <Segmented<'14' | '30' | '90' | '365'>
              value={repoMetricsDays}
              options={[
                { value: '14', label: t('common.daysAgo', { n: 14 }) },
                { value: '30', label: t('common.daysAgo', { n: 30 }) },
                { value: '90', label: t('common.daysAgo', { n: 90 }) },
                { value: '365', label: t('common.daysAgo', { n: 365 }) },
              ]}
              onChange={setRepoMetricsDays}
            />
          </Toolbar>

          {(() => {
            // Same collapse pattern as the sparklines module above: top 3 by
            // default, expand to 30 max. The 30-cap mirrors the previous
            // "slice(0, 50)" behaviour scaled down to keep parity with the
            // sparklines section the user explicitly asked us to mirror.
            const COLLAPSED_COUNT = 3;
            const EXPANDED_COUNT = 30;
            const totalAvailable = Math.min(filteredRepos.length, EXPANDED_COUNT);
            const visibleRepos = reposExpanded
              ? filteredRepos.slice(0, EXPANDED_COUNT)
              : filteredRepos.slice(0, COLLAPSED_COUNT);
            const hiddenCount = totalAvailable - visibleRepos.length;
            return (
              <>
                <div className="mt-3 grid grid-cols-1 gap-2 lg:grid-cols-2">
                  {visibleRepos.map((repo) => {
                    const repoTraffic = trafficByRepo.get(repo.name);
                    const freshness = trafficFreshnessTone(repoTraffic?.lastDate);
                    const metrics = repoMetricsByName.get(repo.name);
                    const emptyVec: number[] = new Array(repoMetricsDaysNum).fill(0);
                    return (
                      <a
                        key={repo.name}
                        href={repo.url || '#'}
                        target="_blank"
                        rel="noreferrer"
                        className="flex flex-col gap-2 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-1)] px-3 py-2.5 hover:border-[var(--border-strong)] hover:bg-[var(--surface-2)]"
                      >
                        {/* Header row : freshness dot + name + lang + fork chip +
                            stars/forks + relative push date. Push date has full
                            ISO in title attribute for exact-date hover. */}
                        <div className="flex items-start justify-between gap-3">
                          <div className="flex min-w-0 items-center gap-2">
                            <Dot tone={freshness} />
                            <span className="truncate text-[14px] font-medium text-[var(--text)]">
                              {repo.name}
                            </span>
                            {repo.primary_lang ? <Chip>{repo.primary_lang}</Chip> : null}
                            {repo.is_fork ? <Chip tone="warn">fork</Chip> : null}
                          </div>
                          <div className="flex flex-col items-end gap-0.5 text-[12px] text-[var(--text-mute)]">
                            <div className="num whitespace-nowrap">
                              ★ {numberLabel(repo.stars)} · ⑂ {numberLabel(repo.forks)}
                            </div>
                            <div
                              className="whitespace-nowrap text-[11px] text-[var(--text-dim)]"
                              title={formatPushed(repo.pushed_at)}
                            >
                              {t('github.repos.pushedRelative', {
                                rel: relativeTime(repo.pushed_at, t),
                              })}
                            </div>
                          </div>
                        </div>

                        {/* Description + topics */}
                        <div>
                          <div className="line-clamp-2 text-[12px] text-[var(--text-dim)]">
                            {repo.description || '—'}
                          </div>
                          {repo.topics && repo.topics.length > 0 ? (
                            <div className="mt-1 flex flex-wrap gap-1">
                              {repo.topics.slice(0, 5).map((topic) => (
                                <span
                                  key={topic}
                                  className="inline-block rounded-full bg-[var(--surface-2)] px-1.5 py-0.5 text-[10px] text-[var(--text-faint)]"
                                >
                                  #{topic}
                                </span>
                              ))}
                            </div>
                          ) : null}
                        </div>

                        {/* 4 mini bar-charts on the same window: NPM / views /
                            clones / commits. Each normalised on its own max so
                            shapes are readable even on low-volume repos. */}
                        <div className="grid grid-cols-4 gap-2 border-t border-[var(--border)] pt-2">
                          <RepoMiniBarChart
                            label={t('github.repos.npmCell')}
                            values={metrics?.npm || emptyVec}
                            color="#ff2d95"
                          />
                          <RepoMiniBarChart
                            label={t('github.repos.viewsCell')}
                            values={metrics?.views || emptyVec}
                            color="#64d2ff"
                          />
                          <RepoMiniBarChart
                            label={t('github.repos.clonesCell')}
                            values={metrics?.clones || emptyVec}
                            color="#30d158"
                          />
                          <RepoMiniBarChart
                            label={t('github.repos.commitsCell')}
                            values={metrics?.commits || emptyVec}
                            color="#ffd60a"
                          />
                        </div>

                        {/* Footer : last traffic snapshot date + viewsUniques for
                            audience quality signal. Kept subtle. */}
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-0 text-[10.5px] text-[var(--text-faint)]">
                          {repoTraffic?.lastDate ? (
                            <span className="num">
                              {t('github.repos.lastSnapshot', { date: repoTraffic.lastDate })}
                            </span>
                          ) : null}
                          {repoTraffic && repoTraffic.viewsUniquesRecent > 0 ? (
                            <>
                              <span>·</span>
                              <span className="num">
                                {t('github.repos.uniques', {
                                  n: numberLabel(repoTraffic.viewsUniquesRecent),
                                })}
                              </span>
                            </>
                          ) : null}
                        </div>
                      </a>
                    );
                  })}

                  {filteredRepos.length === 0 ? (
                    <Empty>{t('github.repos.emptyFilter')}</Empty>
                  ) : null}
                </div>
                {/* Expand/collapse trigger. Hidden when ≤ COLLAPSED_COUNT
                    rows are available so the button never promises content
                    that doesn't exist. */}
                {totalAvailable > COLLAPSED_COUNT ? (
                  <div className="mt-2 flex justify-center">
                    <Button
                      tone="ghost"
                      onClick={() => setReposExpanded((v) => !v)}
                      className="!py-1 !text-[11px]"
                    >
                      {reposExpanded
                        ? t('github.repos.collapse')
                        : t('github.repos.expand', { n: hiddenCount })}
                    </Button>
                  </div>
                ) : null}
              </>
            );
          })()}
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

/**
 * Inline traffic cell for a repo card (views OR clones).
 * Layout: label + big number on top, 14-day sparkline middle, uniques +
 * cumulative total bottom. Fixed sparkline viewBox so cards align no matter
 * the repo's magnitude (scale is intentionally relative-per-repo so shapes
 * are readable even on low-traffic repos).
 */
type Translator = (key: string, vars?: Record<string, string | number>) => string;
function RepoTrafficCell({
  label,
  recent,
  uniques,
  cumul,
  sparkPath,
  stroke,
  t,
}: {
  label: string;
  recent: number | undefined;
  uniques: number | undefined;
  cumul: number | undefined;
  sparkPath: string;
  stroke: string;
  t: Translator;
}) {
  return (
    <div className="min-w-0">
      <div className="flex items-baseline gap-2">
        <span className="text-[10px] uppercase tracking-[0.08em] text-[var(--text-dim)]">
          {label}
        </span>
        <span className="num text-[14px] font-medium text-[var(--text)]">
          {numberLabel(recent || 0)}
        </span>
      </div>
      <svg
        viewBox="0 0 100 22"
        preserveAspectRatio="none"
        className="my-1 h-[22px] w-full"
        aria-hidden="true"
      >
        {sparkPath ? (
          <path d={sparkPath} fill="none" stroke={stroke} strokeWidth={1.2} />
        ) : (
          <line
            x1={0}
            y1={11}
            x2={100}
            y2={11}
            stroke="var(--border)"
            strokeDasharray="2 2"
            strokeWidth={0.6}
          />
        )}
      </svg>
      <div className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0 text-[10.5px] text-[var(--text-faint)]">
        <span className="num">{t('github.repos.uniques', { n: numberLabel(uniques || 0) })}</span>
        <span>·</span>
        <span className="num">Σ {numberLabel(cumul || 0)}</span>
      </div>
    </div>
  );
}

/**
 * Compact vertical bar chart for a repo card — 4 of these stack into the
 * NPM / Views / Clones / Commits grid. Each bar is one day, normalized to
 * the series' own max so the shape is readable regardless of magnitude.
 * Scales automatically at any window size (14 → 365 days): bars get thinner
 * as the window widens, viewBox+preserveAspectRatio does the rest.
 */
function RepoMiniBarChart({
  label,
  values,
  color,
}: {
  label: string;
  values: number[];
  color: string;
}) {
  const total = values.reduce((acc, v) => acc + (v || 0), 0);
  const max = values.reduce((acc, v) => Math.max(acc, v || 0), 0);
  const viewW = Math.max(1, values.length);
  const viewH = 22;
  // One bar per data point: width = column width minus 15% gutter so bars
  // don't fuse into a solid block at 14/30 day windows. Baseline y = viewH.
  const barW = 0.85;
  const barOffset = (1 - barW) / 2;
  return (
    <div className="min-w-0">
      <div className="flex items-baseline justify-between gap-1">
        <span className="text-[9.5px] uppercase tracking-[0.08em] text-[var(--text-dim)]">
          {label}
        </span>
        <span className="num text-[11px] font-medium text-[var(--text)]">{numberLabel(total)}</span>
      </div>
      <svg
        viewBox={`0 0 ${viewW} ${viewH}`}
        preserveAspectRatio="none"
        className="mt-1 h-[22px] w-full"
        aria-hidden="true"
      >
        {max === 0 ? (
          <line
            x1={0}
            y1={viewH - 1}
            x2={viewW}
            y2={viewH - 1}
            stroke="var(--border)"
            strokeDasharray="2 2"
            strokeWidth={0.6}
            vectorEffect="non-scaling-stroke"
          />
        ) : (
          values
            .map((v, i) => {
              const h = max > 0 ? ((v || 0) / max) * viewH : 0;
              // Keyed by day offset. Bar positions are strictly time-aligned
              // and stable within a single render (no filtering, no reorder),
              // so the index is a correct key here. We pre-skip zero-height
              // bars after building the list so the key set stays stable.
              return { i, h };
            })
            .filter((b) => b.h > 0)
            .map(({ i, h }) => (
              <rect
                key={`d${i}`}
                x={i + barOffset}
                y={viewH - h}
                width={barW}
                height={h}
                fill={color}
                opacity={0.85}
              />
            ))
        )}
      </svg>
    </div>
  );
}

function NpmDownloadsStat({
  deltaWindowDays,
  isAllTime,
  labelSuffix,
}: {
  deltaWindowDays: number;
  isAllTime: boolean;
  labelSuffix: string;
}) {
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
  // In all-time mode the headline is the cumulative local total, not a
  // rolling window — otherwise the card would show "30j" numbers while every
  // other Stat shows all-time.
  const headline = data ? (isAllTime ? data.totals.cumul_local : data.totals[periodKey]) : 0;
  const publishedCount = data?.published.length ?? 0;

  // Secondary breakdown: in all-time, surface the three rolling windows for
  // context; otherwise show the two non-selected periods.
  const secondary: Array<{ label: string; value: number }> = data
    ? isAllTime
      ? [
          { label: '1j', value: data.totals.last_day },
          { label: '7j', value: data.totals.last_week },
          { label: '30j', value: data.totals.last_month },
        ]
      : [
          { label: '1j', value: data.totals.last_day },
          { label: '7j', value: data.totals.last_week },
          { label: '30j', value: data.totals.last_month },
        ].filter((r) => r.label !== `${deltaWindowDays}j`)
    : [];

  const cumul = data?.totals.cumul_local ?? 0;
  // All-time already puts cumul in the headline — no need to repeat it.
  const showCumul = cumul > 0 && !isAllTime;

  return (
    <Stat
      label={`npm · ${labelSuffix}`}
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
  period: 'day' | 'week' | 'month' | 'all';
}) {
  const { t } = useTranslation();
  // All-time has no "previous period" to compare to — showing a Δ here would
  // be fabricated. Render just the cumulative label.
  if (period === 'all') {
    return <span className="text-[var(--text-dim)]">Σ · {t('common.allTime')}</span>;
  }
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
