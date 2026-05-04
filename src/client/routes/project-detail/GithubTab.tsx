import { useEffect, useMemo, useState } from 'react';
import {
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Heatmap } from '../../components/Heatmap';
import { HeatmapStackedBars } from '../../components/HeatmapStackedBars';
import { Card, Chip, Empty, Section, Segmented, Stat } from '../../components/ui';
import { apiGet } from '../../lib/api';
import { bucketOf } from '../../lib/cumulStacks';
import { type Locale, dateLocale, numberLocale, useTranslation } from '../../lib/i18n';

/**
 * Per-project GitHub deep-dive sub-tab. Aggregates everything we know
 * about the project's matching GitHub repo into a single page:
 *  - Repo metadata header (stars / forks / watchers / topics)
 *  - 4-KPI strip with delta vs previous window (commits / views /
 *    clones / total downloads across registries)
 *  - Activity timeline (line chart): views / clones / commits per day
 *  - Annual heatmap of composite activity for THIS repo
 *  - Per-registry cumul stacked bars (npm / pypi / cargo) when published
 *  - Comparison vs other repos (rank position for each metric)
 *  - Last 30 commits table
 *  - Raw daily traffic table (collapsible)
 *
 * Match logic: project.name → github_repos.name, case-insensitive. The
 * server's /commits endpoint does the same so the URL key stays stable
 * even when the GitHub repo uses a different case from the local
 * directory name.
 *
 * Reuses existing endpoints (no per-tab server endpoint) and filters
 * client-side by repo name. The trade-off is extra payload over the
 * wire (we receive metrics for ALL repos to display ONE), but the
 * payload is small (~50 KB for 365 d × 13 repos × 6 metrics) and the
 * fetches are cached across remounts of this tab via React's natural
 * effect re-runs gated on stable deps.
 */

// ────────── shared types (mirrored from github.tsx) ──────────

type Window = 14 | 30 | 90 | 365;

type Repo = {
  name: string;
  description: string | null;
  stars: number;
  forks: number;
  primary_lang: string | null;
  pushed_at: number | null;
  url: string | null;
  topics: string[] | null;
  is_fork: boolean;
};

type TrafficTimeseriesRow = {
  repo: string;
  date: string;
  viewsCount: number;
  viewsUniques: number;
  clonesCount: number;
  clonesUniques: number;
};

type RepoMetricsRow = {
  repo: string;
  views: number[];
  clones: number[];
  commits: number[];
  npm: number[];
  pypi: number[];
  cargo: number[];
};

type RepoMetricsResponse = {
  days: number;
  cutoff: string;
  dates: string[];
  repos: RepoMetricsRow[];
};

type CommitRow = {
  sha: string;
  repo: string;
  date: number; // unix seconds
  message: string | null;
  additions: number | null;
  deletions: number | null;
};

// ────────── orchestrator ──────────

type ProjectGithubTabProps = {
  projectName: string;
  locale: Locale;
};

export function ProjectGithubTab({ projectName, locale }: ProjectGithubTabProps) {
  const { t } = useTranslation();
  const [window, setWindow] = useState<Window>(30);

  // Repo lookup is one-shot — repo metadata doesn't change with the
  // window selector.
  const [repos, setRepos] = useState<Repo[] | null>(null);
  // Traffic timeseries: 365 d so the heatmap covers the year regardless
  // of the smaller selected window. The KPIs + chart re-slice this.
  const [traffic, setTraffic] = useState<TrafficTimeseriesRow[] | null>(null);
  // Repo-metrics — re-fetched on window change because the array length
  // depends on `?days=N`. The other endpoints are window-agnostic.
  const [metrics, setMetrics] = useState<RepoMetricsResponse | null>(null);
  const [commits, setCommits] = useState<CommitRow[] | null>(null);
  // Settings → displayAliases. Settings → projectName → GitHub repo
  // name mapping; we need it to resolve the URL-routed local project
  // name (e.g. "Dashboard") to its actual GitHub repo (e.g.
  // "vibecode-dash") before any fetch keyed on the repo name. Without
  // this the per-project tab silently shows "no repo found" for any
  // project whose folder name diverges from the GitHub repo and whose
  // suffix doesn't match either.
  const [aliases, setAliases] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  // Resolve the alias up-front. `displayAliases` maps canonical local
  // name → display/actual name, which here is the GitHub repo name.
  // Case-insensitive lookup so the keys don't need to match the project
  // folder casing exactly.
  const resolvedRepoName = useMemo(() => {
    const direct = aliases[projectName];
    if (direct) return direct;
    const lowerKey = Object.keys(aliases).find(
      (k) => k.toLowerCase() === projectName.toLowerCase(),
    );
    return lowerKey ? aliases[lowerKey] : projectName;
  }, [aliases, projectName]);

  // 1-shot fetches at mount. Settings is fetched first because the
  // commits endpoint URL depends on the resolved repo name; firing all
  // four in parallel is the easy default but would race against the
  // alias resolution and call /commits on the unresolved name. Two
  // sequential phases keeps the code simple and avoids that race.
  useEffect(() => {
    let cancelled = false;
    apiGet<{ displayAliases?: Record<string, string> }>('/api/settings')
      .then((settings) => {
        if (cancelled) return;
        setAliases(settings.displayAliases ?? {});
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      apiGet<Repo[]>('/api/github/repos'),
      apiGet<{ days: number; cutoff: string; rows: TrafficTimeseriesRow[] }>(
        '/api/github/traffic/timeseries?days=365',
      ),
      apiGet<{ rows: CommitRow[] }>(
        `/api/github/repos/${encodeURIComponent(resolvedRepoName)}/commits?limit=30`,
      ),
    ])
      .then(([reposData, trafficData, commitsData]) => {
        if (cancelled) return;
        setRepos(reposData);
        setTraffic(trafficData.rows);
        setCommits(commitsData.rows);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [resolvedRepoName]);

  // Window-dependent fetch — re-runs only when `window` changes.
  useEffect(() => {
    let cancelled = false;
    apiGet<RepoMetricsResponse>(`/api/github/repo-metrics?days=${window}`)
      .then((data) => {
        if (!cancelled) setMetrics(data);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [window]);

  // Find the matching GitHub repo for this project. We try in order:
  //   1. The alias-resolved name (case-insensitive exact match) —
  //      authoritative when the user has configured an alias.
  //   2. The raw project name (case-insensitive exact match) — covers
  //      the no-alias case where local folder == GitHub repo.
  //   3. Suffix match `endsWith(-name)` — heuristic fallback for
  //      conventions like local `auth` → GitHub `mycompany-auth`.
  const repo = useMemo<Repo | null>(() => {
    if (!repos) return null;
    const lowerResolved = resolvedRepoName.toLowerCase();
    const lowerProject = projectName.toLowerCase();
    return (
      repos.find((r) => r.name.toLowerCase() === lowerResolved) ??
      repos.find((r) => r.name.toLowerCase() === lowerProject) ??
      repos.find((r) => r.name.toLowerCase().endsWith(`-${lowerProject}`)) ??
      null
    );
  }, [repos, projectName, resolvedRepoName]);

  if (error) {
    return (
      <Section title={t('projects.detail.github.title')}>
        <Card>
          <Empty>{t('projects.detail.github.error', { error })}</Empty>
        </Card>
      </Section>
    );
  }

  if (repos !== null && !repo) {
    // Repos loaded but no match — clear empty state, not a half-rendered page.
    return (
      <Section
        title={t('projects.detail.github.title')}
        meta={t('projects.detail.github.notFoundMeta', { name: projectName })}
      >
        <Card>
          <Empty>{t('projects.detail.github.notFound', { name: projectName })}</Empty>
        </Card>
      </Section>
    );
  }

  const repoName = repo?.name ?? projectName;
  const repoMetrics = metrics?.repos.find((r) => r.repo.toLowerCase() === repoName.toLowerCase());
  const repoTraffic = (traffic ?? []).filter(
    (r) => r.repo.toLowerCase() === repoName.toLowerCase(),
  );

  return (
    <div className="flex flex-col gap-4">
      <GhRepoHeader repo={repo} t={t} locale={locale} />

      <Section
        title={t('projects.detail.github.kpiTitle')}
        meta={t('projects.detail.github.kpiMeta', { window })}
        action={
          <Segmented<string>
            value={String(window)}
            options={[
              { value: '14', label: t('common.daysAgo', { n: 14 }) },
              { value: '30', label: t('common.daysAgo', { n: 30 }) },
              { value: '90', label: t('common.daysAgo', { n: 90 }) },
              { value: '365', label: t('common.daysAgo', { n: 365 }) },
            ]}
            onChange={(v) => setWindow(Number.parseInt(v, 10) as Window)}
          />
        }
      >
        <GhKpiStrip metrics={repoMetrics} window={window} locale={locale} t={t} />
      </Section>

      <Section
        title={t('projects.detail.github.timelineTitle')}
        meta={t('projects.detail.github.timelineMeta')}
      >
        <Card>
          <GhTimelineChart
            metrics={repoMetrics}
            dates={metrics?.dates ?? []}
            locale={locale}
            t={t}
          />
        </Card>
      </Section>

      <Section
        title={t('projects.detail.github.heatmapTitle')}
        meta={t('projects.detail.github.heatmapMeta')}
      >
        <Card>
          <GhActivityHeatmap traffic={traffic ?? []} repoName={repoName} t={t} />
        </Card>
      </Section>

      {/* Downloads cumul — only renders when the repo is published on at
          least one registry (sum > 0). Otherwise the card stays out of
          the page entirely (less noise on JS-only repos that don't push
          to npm). */}
      <GhDownloadsSection metrics={repoMetrics} dates={metrics?.dates ?? []} t={t} />

      <Section
        title={t('projects.detail.github.compareTitle')}
        meta={t('projects.detail.github.compareMeta', { window })}
      >
        <Card>
          <GhComparison allRepos={metrics?.repos ?? []} repoName={repoName} locale={locale} t={t} />
        </Card>
      </Section>

      <Section
        title={t('projects.detail.github.commitsTitle', { n: commits?.length ?? 0 })}
        meta={t('projects.detail.github.commitsMeta')}
      >
        <Card>
          <GhCommitsList commits={commits ?? []} repoUrl={repo?.url ?? null} locale={locale} />
        </Card>
      </Section>

      <Section
        title={t('projects.detail.github.rawTitle')}
        meta={t('projects.detail.github.rawMeta')}
      >
        <Card>
          <GhRawTable
            traffic={repoTraffic}
            metrics={repoMetrics}
            dates={metrics?.dates ?? []}
            locale={locale}
            t={t}
          />
        </Card>
      </Section>
    </div>
  );
}

// ────────── header ──────────

function GhRepoHeader({
  repo,
  t,
  locale,
}: {
  repo: Repo | null;
  t: (k: string, v?: Record<string, string | number>) => string;
  locale: Locale;
}) {
  if (!repo) {
    return (
      <Card>
        <Empty>{t('projects.detail.github.headerLoading')}</Empty>
      </Card>
    );
  }
  const nLocale = numberLocale(locale);
  const dtLocale = dateLocale(locale);
  const pushedRel = repo.pushed_at
    ? new Date(repo.pushed_at * 1000).toLocaleDateString(dtLocale, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      })
    : '—';
  return (
    <Card>
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-baseline gap-2">
          {repo.url ? (
            <a
              href={repo.url}
              target="_blank"
              rel="noreferrer noopener"
              className="text-[15px] font-semibold text-[var(--text)] hover:text-[var(--accent)]"
            >
              {repo.name}
            </a>
          ) : (
            <span className="text-[15px] font-semibold text-[var(--text)]">{repo.name}</span>
          )}
          {repo.primary_lang ? <Chip>{repo.primary_lang}</Chip> : null}
          {repo.is_fork ? <Chip tone="warn">{t('projects.detail.github.forkBadge')}</Chip> : null}
        </div>
        {repo.description ? (
          <p className="text-[12.5px] leading-snug text-[var(--text-mute)]">{repo.description}</p>
        ) : null}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[12px] text-[var(--text-dim)]">
          <span>
            ⭐{' '}
            <span className="num text-[var(--text)]">
              {Intl.NumberFormat(nLocale).format(repo.stars)}
            </span>
          </span>
          <span>
            ⑂{' '}
            <span className="num text-[var(--text)]">
              {Intl.NumberFormat(nLocale).format(repo.forks)}
            </span>
          </span>
          <span>
            {t('projects.detail.github.lastPush')}{' '}
            <span className="text-[var(--text-mute)]">{pushedRel}</span>
          </span>
        </div>
        {repo.topics && repo.topics.length > 0 ? (
          <div className="flex flex-wrap gap-1">
            {repo.topics.slice(0, 12).map((topic) => (
              <span
                key={topic}
                className="rounded-full bg-[var(--surface-2)] px-1.5 py-0.5 text-[10px] text-[var(--text-faint)]"
              >
                #{topic}
              </span>
            ))}
          </div>
        ) : null}
      </div>
    </Card>
  );
}

// ────────── KPI strip ──────────

function sum(arr: number[] | undefined): number {
  return (arr ?? []).reduce((s, n) => s + n, 0);
}

function deltaPct(now: number, prev: number): { sign: '+' | '-' | '='; pct: number } {
  if (prev === 0 && now === 0) return { sign: '=', pct: 0 };
  if (prev === 0) return { sign: '+', pct: 100 };
  const d = ((now - prev) / prev) * 100;
  if (Math.abs(d) < 0.5) return { sign: '=', pct: 0 };
  return { sign: d > 0 ? '+' : '-', pct: Math.abs(Math.round(d)) };
}

function GhKpiStrip({
  metrics,
  window,
  locale,
  t,
}: {
  metrics: RepoMetricsRow | undefined;
  window: number;
  locale: Locale;
  t: (k: string, v?: Record<string, string | number>) => string;
}) {
  const nLocale = numberLocale(locale);

  // Window split: the API returns `days` items (the active window). For
  // delta vs previous, we compare the LATEST half against the PREVIOUS
  // half of the same length — same semantics as a "vs previous N d"
  // comparison. Cleaner than re-fetching with offset since the data is
  // already in memory.
  const half = Math.floor(window / 2);
  const half1 = (arr?: number[]) => sum(arr?.slice(0, half));
  const half2 = (arr?: number[]) => sum(arr?.slice(half));

  const commits = sum(metrics?.commits);
  const commitsDelta = deltaPct(half2(metrics?.commits), half1(metrics?.commits));
  const views = sum(metrics?.views);
  const viewsDelta = deltaPct(half2(metrics?.views), half1(metrics?.views));
  const clones = sum(metrics?.clones);
  const clonesDelta = deltaPct(half2(metrics?.clones), half1(metrics?.clones));
  const downloads = sum(metrics?.npm) + sum(metrics?.pypi) + sum(metrics?.cargo);

  const fmt = (n: number) => Intl.NumberFormat(nLocale).format(n);
  const renderDelta = (d: { sign: '+' | '-' | '='; pct: number }) => {
    if (d.sign === '=') return null;
    const color = d.sign === '+' ? '#30d158' : '#ff453a';
    return (
      <span className="text-[10px]" style={{ color }}>
        {d.sign}
        {d.pct}%
      </span>
    );
  };

  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
      <Stat
        label={t('projects.detail.github.kpi.commits')}
        value={fmt(commits)}
        hint={renderDelta(commitsDelta) ?? undefined}
      />
      <Stat
        label={t('projects.detail.github.kpi.views')}
        value={fmt(views)}
        hint={renderDelta(viewsDelta) ?? undefined}
      />
      <Stat
        label={t('projects.detail.github.kpi.clones')}
        value={fmt(clones)}
        hint={renderDelta(clonesDelta) ?? undefined}
      />
      <Stat
        label={t('projects.detail.github.kpi.downloads')}
        value={fmt(downloads)}
        hint={t('projects.detail.github.kpi.downloadsHint')}
      />
    </div>
  );
}

// ────────── timeline chart ──────────

function GhTimelineChart({
  metrics,
  dates,
  locale,
  t,
}: {
  metrics: RepoMetricsRow | undefined;
  dates: string[];
  locale: Locale;
  t: (k: string, v?: Record<string, string | number>) => string;
}) {
  if (!metrics || dates.length === 0) {
    return <Empty>{t('projects.detail.github.timelineEmpty')}</Empty>;
  }
  const dtLocale = dateLocale(locale);
  const data = dates.map((date, i) => ({
    date,
    views: metrics.views[i] ?? 0,
    clones: metrics.clones[i] ?? 0,
    commits: metrics.commits[i] ?? 0,
  }));
  const tickFmt = (d: string) => {
    const day = new Date(`${d}T00:00:00Z`);
    return day.toLocaleDateString(dtLocale, { day: '2-digit', month: 'short' });
  };
  return (
    <div className="h-64 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
          <CartesianGrid stroke="rgba(255,255,255,0.05)" vertical={false} />
          <XAxis
            dataKey="date"
            tickFormatter={tickFmt}
            stroke="var(--text-faint)"
            tickLine={false}
            interval="preserveStartEnd"
            minTickGap={28}
          />
          <YAxis stroke="var(--text-faint)" tickLine={false} width={36} />
          <Tooltip
            contentStyle={{
              backgroundColor: '#0b0d11',
              border: '1px solid rgba(255,255,255,0.1)',
              borderRadius: 10,
              color: '#f5f5f7',
            }}
            labelFormatter={(d) =>
              new Date(`${d}T00:00:00Z`).toLocaleDateString(dtLocale, {
                weekday: 'short',
                day: '2-digit',
                month: 'short',
              })
            }
          />
          <Legend wrapperStyle={{ fontSize: 11 }} />
          <Line
            type="monotone"
            dataKey="views"
            name={t('projects.detail.github.kpi.views')}
            stroke="#64d2ff"
            strokeWidth={1.6}
            dot={false}
          />
          <Line
            type="monotone"
            dataKey="clones"
            name={t('projects.detail.github.kpi.clones')}
            stroke="#30d158"
            strokeWidth={1.6}
            dot={false}
          />
          <Line
            type="monotone"
            dataKey="commits"
            name={t('projects.detail.github.kpi.commits')}
            stroke="#ffd60a"
            strokeWidth={1.6}
            dot={false}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

// ────────── activity heatmap ──────────

function GhActivityHeatmap({
  traffic,
  repoName,
  t,
}: {
  traffic: TrafficTimeseriesRow[];
  repoName: string;
  t: (k: string, v?: Record<string, string | number>) => string;
}) {
  // Composite activity per day for THIS repo: views + clones, normalised
  // so the heatmap palette ranges meaningfully even on low-volume repos.
  // Year-grid is from Jan 1 of the current year to today (clamped) — same
  // convention as Overview.
  const data = useMemo(() => {
    const repoLower = repoName.toLowerCase();
    const byDate = new Map<string, number>();
    for (const row of traffic) {
      if (row.repo.toLowerCase() !== repoLower) continue;
      const v = Number(row.viewsCount || 0) + Number(row.clonesCount || 0);
      byDate.set(row.date, (byDate.get(row.date) || 0) + v);
    }
    const year = new Date().getUTCFullYear();
    const days: Array<{ date: string; count: number; color: null }> = [];
    const cursor = new Date(Date.UTC(year, 0, 1));
    const end = new Date(Date.UTC(year, 11, 31));
    while (cursor <= end) {
      const iso = cursor.toISOString().slice(0, 10);
      days.push({ date: iso, count: byDate.get(iso) || 0, color: null });
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    const total = days.reduce((s, d) => s + d.count, 0);
    return { days, total };
  }, [traffic, repoName]);

  if (data.total === 0) {
    return <Empty>{t('projects.detail.github.heatmapEmpty')}</Empty>;
  }

  return (
    <Heatmap
      days={data.days}
      palette="cyan"
      totalLabel={t('projects.detail.github.heatmapTotalLabel')}
      totalValue={data.total}
    />
  );
}

// ────────── downloads cumul ──────────

function GhDownloadsSection({
  metrics,
  dates,
  t,
}: {
  metrics: RepoMetricsRow | undefined;
  dates: string[];
  t: (k: string, v?: Record<string, string | number>) => string;
}) {
  const npmSum = sum(metrics?.npm);
  const pypiSum = sum(metrics?.pypi);
  const cargoSum = sum(metrics?.cargo);
  if (npmSum + pypiSum + cargoSum === 0) {
    // Nothing published anywhere — skip the section entirely so the page
    // doesn't carry a misleading empty downloads card on JS-app-only or
    // private repos.
    return null;
  }
  const stacked = dates.map((date, i) => ({
    date,
    values: {
      ...(metrics?.npm[i] ? { npm: metrics.npm[i] } : {}),
      ...(metrics?.pypi[i] ? { pypi: metrics.pypi[i] } : {}),
      ...(metrics?.cargo[i] ? { cargo: metrics.cargo[i] } : {}),
    },
  }));
  const total = npmSum + pypiSum + cargoSum;

  return (
    <Section
      title={t('projects.detail.github.downloadsTitle')}
      meta={t('projects.detail.github.downloadsMeta', {
        npm: npmSum,
        pypi: pypiSum,
        cargo: cargoSum,
      })}
    >
      <Card>
        <HeatmapStackedBars
          daily={stacked}
          groupBy="week"
          cumulative
          colorMap={{ npm: '#bf5af2', pypi: '#3776ab', cargo: '#dea584' }}
          totalLabel={t('projects.detail.github.downloadsTotalLabel')}
          totalValue={total}
          pendingBucket={bucketOf(new Date().toISOString().slice(0, 10), 'week')}
          height={200}
        />
      </Card>
    </Section>
  );
}

// ────────── comparison ──────────

function GhComparison({
  allRepos,
  repoName,
  locale,
  t,
}: {
  allRepos: RepoMetricsRow[];
  repoName: string;
  locale: Locale;
  t: (k: string, v?: Record<string, string | number>) => string;
}) {
  const nLocale = numberLocale(locale);
  if (allRepos.length === 0) {
    return <Empty>{t('projects.detail.github.compareEmpty')}</Empty>;
  }
  const lower = repoName.toLowerCase();

  // Compute rank for each metric: for `views`, sort all repos by total
  // views desc, find this repo's position. Returns { rank, total, max }
  // so the bar can render this repo's value relative to the leader.
  function rank(metricKey: 'views' | 'clones' | 'commits' | 'downloads') {
    const totals = allRepos.map((r) => ({
      repo: r.repo,
      value:
        metricKey === 'downloads' ? sum(r.npm) + sum(r.pypi) + sum(r.cargo) : sum(r[metricKey]),
    }));
    totals.sort((a, b) => b.value - a.value);
    const max = totals[0]?.value ?? 0;
    const idx = totals.findIndex((t) => t.repo.toLowerCase() === lower);
    const ours = totals[idx];
    return {
      rank: idx + 1, // 1-indexed
      total: allRepos.length,
      value: ours?.value ?? 0,
      max,
    };
  }

  const rows = [
    { key: 'views' as const, label: t('projects.detail.github.kpi.views') },
    { key: 'clones' as const, label: t('projects.detail.github.kpi.clones') },
    { key: 'commits' as const, label: t('projects.detail.github.kpi.commits') },
    { key: 'downloads' as const, label: t('projects.detail.github.kpi.downloads') },
  ].map((r) => ({ ...r, ...rank(r.key) }));

  return (
    <div className="flex flex-col gap-2.5">
      {rows.map((row) => {
        const pct = row.max > 0 ? (row.value / row.max) * 100 : 0;
        return (
          <div key={row.key} className="flex flex-col gap-1">
            <div className="flex items-baseline justify-between text-[12px]">
              <span className="text-[var(--text-mute)]">{row.label}</span>
              <span className="text-[var(--text-dim)]">
                <span className="num text-[var(--text)]">
                  {Intl.NumberFormat(nLocale).format(row.value)}
                </span>{' '}
                · {t('projects.detail.github.compareRank', { rank: row.rank, total: row.total })}
              </span>
            </div>
            <div className="h-2 w-full overflow-hidden rounded-full bg-[var(--surface-2)]">
              <div
                className="h-full rounded-full"
                style={{
                  width: `${Math.max(2, pct)}%`,
                  background:
                    row.rank === 1
                      ? '#ffd60a'
                      : row.rank <= 3
                        ? '#30d158'
                        : row.rank <= Math.ceil(row.total / 2)
                          ? '#64d2ff'
                          : 'var(--text-faint)',
                }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ────────── commits list ──────────

function GhCommitsList({
  commits,
  repoUrl,
  locale,
}: {
  commits: CommitRow[];
  repoUrl: string | null;
  locale: Locale;
}) {
  const dtLocale = dateLocale(locale);
  if (commits.length === 0) {
    return <Empty>—</Empty>;
  }
  return (
    <div className="overflow-x-auto rounded-[var(--radius-sm)] border border-[var(--border)]">
      <table className="w-full min-w-[480px] border-collapse text-[12px]">
        <thead>
          <tr className="bg-[var(--surface-2)] text-[var(--text-mute)]">
            <th className="px-2 py-1.5 text-left font-medium">SHA</th>
            <th className="px-2 py-1.5 text-left font-medium">Date</th>
            <th className="px-2 py-1.5 text-left font-medium">Message</th>
          </tr>
        </thead>
        <tbody>
          {commits.map((c) => {
            const sha = c.sha.slice(0, 7);
            const date = new Date(c.date * 1000).toLocaleDateString(dtLocale, {
              year: 'numeric',
              month: 'short',
              day: '2-digit',
            });
            const msg = (c.message ?? '').split('\n')[0];
            const commitUrl = repoUrl ? `${repoUrl}/commit/${c.sha}` : null;
            return (
              <tr key={c.sha} className="border-t border-[var(--border)]">
                <td className="px-2 py-1.5 font-mono text-[11px] text-[var(--text-mute)]">
                  {commitUrl ? (
                    <a
                      href={commitUrl}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="hover:text-[var(--accent)]"
                    >
                      {sha}
                    </a>
                  ) : (
                    sha
                  )}
                </td>
                <td className="px-2 py-1.5 text-[var(--text-faint)]">{date}</td>
                <td className="px-2 py-1.5 text-[var(--text)]">{msg || '—'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ────────── raw daily table ──────────

function GhRawTable({
  traffic,
  metrics,
  dates,
  locale,
  t,
}: {
  traffic: TrafficTimeseriesRow[];
  metrics: RepoMetricsRow | undefined;
  dates: string[];
  locale: Locale;
  t: (k: string, v?: Record<string, string | number>) => string;
}) {
  const nLocale = numberLocale(locale);
  // Build a per-date map from the traffic timeseries (which carries
  // uniques) since metrics only has counts.
  const trafficByDate = useMemo(() => {
    const m = new Map<string, TrafficTimeseriesRow>();
    for (const row of traffic) m.set(row.date, row);
    return m;
  }, [traffic]);
  // Display the LAST 30 days from the metrics window (descending). If
  // the window is < 30 d we show what we have.
  const rowDates = useMemo(() => {
    return [...dates].reverse().slice(0, 30);
  }, [dates]);

  if (rowDates.length === 0 || !metrics) {
    return <Empty>{t('projects.detail.github.rawEmpty')}</Empty>;
  }

  const fmt = (n: number) => (n === 0 ? '—' : Intl.NumberFormat(nLocale).format(n));
  const dateIndex = new Map(dates.map((d, i) => [d, i]));

  return (
    <div className="overflow-x-auto rounded-[var(--radius-sm)] border border-[var(--border)]">
      <table className="w-full min-w-[640px] border-collapse text-[12px]">
        <thead>
          <tr className="bg-[var(--surface-2)] text-[var(--text-mute)]">
            <th className="px-2 py-1.5 text-left font-medium">Date</th>
            <th className="px-2 py-1.5 text-right font-medium">Views</th>
            <th className="px-2 py-1.5 text-right font-medium">Uniques</th>
            <th className="px-2 py-1.5 text-right font-medium">Clones</th>
            <th className="px-2 py-1.5 text-right font-medium">Uniques</th>
            <th className="px-2 py-1.5 text-right font-medium">Commits</th>
            <th className="px-2 py-1.5 text-right font-medium">npm</th>
            <th className="px-2 py-1.5 text-right font-medium">pypi</th>
            <th className="px-2 py-1.5 text-right font-medium">cargo</th>
          </tr>
        </thead>
        <tbody>
          {rowDates.map((date) => {
            const idx = dateIndex.get(date) ?? -1;
            const traf = trafficByDate.get(date);
            return (
              <tr key={date} className="border-t border-[var(--border)]">
                <td className="px-2 py-1.5 font-mono text-[11px] text-[var(--text-faint)]">
                  {date}
                </td>
                <td className="num px-2 py-1.5 text-right tabular-nums text-[var(--text)]">
                  {fmt(metrics.views[idx] ?? 0)}
                </td>
                <td className="num px-2 py-1.5 text-right tabular-nums text-[var(--text-mute)]">
                  {fmt(Number(traf?.viewsUniques ?? 0))}
                </td>
                <td className="num px-2 py-1.5 text-right tabular-nums text-[var(--text)]">
                  {fmt(metrics.clones[idx] ?? 0)}
                </td>
                <td className="num px-2 py-1.5 text-right tabular-nums text-[var(--text-mute)]">
                  {fmt(Number(traf?.clonesUniques ?? 0))}
                </td>
                <td className="num px-2 py-1.5 text-right tabular-nums text-[var(--text)]">
                  {fmt(metrics.commits[idx] ?? 0)}
                </td>
                <td className="num px-2 py-1.5 text-right tabular-nums text-[var(--text-mute)]">
                  {fmt(metrics.npm[idx] ?? 0)}
                </td>
                <td className="num px-2 py-1.5 text-right tabular-nums text-[var(--text-mute)]">
                  {fmt(metrics.pypi[idx] ?? 0)}
                </td>
                <td className="num px-2 py-1.5 text-right tabular-nums text-[var(--text-mute)]">
                  {fmt(metrics.cargo[idx] ?? 0)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
