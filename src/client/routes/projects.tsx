import { type HealthBreakdown, HealthBreakdownSchema, type ProjectSummary } from '@shared/types';
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { EmptyState, ErrorState, SkeletonList } from '../components/States';
import { Button, Card, Chip, Section, Segmented } from '../components/ui';
import { apiPost } from '../lib/api';
import { type Locale, numberLocale, useTranslation } from '../lib/i18n';
import { useApi } from '../lib/useApi';

type SortBy = 'recent' | 'commit' | 'health' | 'name' | 'dirty' | 'loc';
type ActivityFilter = 'all' | '7d' | '30d' | 'stale';
type ViewMode = 'list' | 'board';
type StaleBucket = 'active' | 'recent' | 'sleep' | 'stale' | 'unknown';

const LANG_COLORS: Record<string, string> = {
  ts: '#3178c6',
  tsx: '#5e5ce6',
  js: '#f1e05a',
  jsx: '#ffd60a',
  py: '#30d158',
  rs: '#dea584',
  go: '#64d2ff',
  java: '#b07219',
  kt: '#f18e33',
  swift: '#ff9500',
  rb: '#ff375f',
  php: '#4f5d95',
  cs: '#bf5af2',
  c: '#555555',
  h: '#6e6e73',
  cpp: '#5e5ce6',
  hpp: '#8e8e93',
  md: '#8e8e93',
  json: '#8a8a8e',
  yaml: '#14b8a6',
  yml: '#0d9488',
  html: '#e34c26',
  css: '#ec4899',
  scss: '#c44569',
  vue: '#30d158',
  svelte: '#ff3e00',
  sh: '#89e051',
  toml: '#9c4221',
  lua: '#000080',
  ex: '#bf5af2',
  exs: '#bf5af2',
  dart: '#00b4ab',
};

const LANG_LABEL: Record<string, string> = {
  ts: 'TS',
  tsx: 'TSX',
  js: 'JS',
  jsx: 'JSX',
  py: 'Python',
  rs: 'Rust',
  go: 'Go',
};

function langColor(ext: string): string {
  return LANG_COLORS[ext] || '#6e6e73';
}

function langLabel(ext: string): string {
  return LANG_LABEL[ext] || ext.toUpperCase();
}

function parseLanguages(json: string | null): Array<[string, number]> {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json) as Record<string, number>;
    return Object.entries(parsed)
      .filter(([, bytes]) => bytes > 0)
      .sort((a, b) => b[1] - a[1]);
  } catch {
    return [];
  }
}

function relativeDays(ts: number | null): number | null {
  if (!ts) return null;
  const now = Math.floor(Date.now() / 1000);
  return Math.floor((now - ts) / 86400);
}

function fmtDays(
  days: number | null,
  t: (key: string, vars?: Record<string, string | number>) => string,
): string {
  if (days === null) return t('projects.row.noCommit');
  if (days <= 0) return t('common.today');
  if (days === 1) return t('common.yesterday');
  if (days < 7) return t('common.daysAgo', { n: days });
  if (days < 30) return t('common.weeksAgo', { n: Math.floor(days / 7) });
  if (days < 365) return t('common.monthsAgo', { n: Math.floor(days / 30) });
  return t('common.yearsAgo', { n: Math.floor(days / 365) });
}

function healthTone(score: number): 'success' | 'warn' | 'danger' | 'neutral' {
  if (score >= 60) return 'success';
  if (score >= 30) return 'warn';
  if (score > 0) return 'danger';
  return 'neutral';
}

function healthColor(score: number): string {
  if (score >= 60) return '#30d158';
  if (score >= 30) return '#ffd60a';
  if (score > 0) return '#ff453a';
  return 'var(--text-faint)';
}

function staleBucketOf(days: number | null): StaleBucket {
  if (days === null) return 'unknown';
  if (days > 180) return 'stale';
  if (days <= 7) return 'active';
  if (days <= 30) return 'recent';
  return 'sleep';
}

function numberFmt(value: number, locale: Locale = 'fr'): string {
  return Intl.NumberFormat(numberLocale(locale)).format(Math.round(value));
}

function compactLoc(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)} M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)} k`;
  return String(value);
}

export default function ProjectsRoute() {
  const { t } = useTranslation();
  const { status, data, error, reload } = useApi<ProjectSummary[]>('/api/projects');
  const projects = data ?? [];
  const loading = status === 'loading';

  const [rescanResult, setRescanResult] = useState<string | null>(null);
  const [rescanRunning, setRescanRunning] = useState(false);
  const [query, setQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState('all');
  const [sortBy, setSortBy] = useState<SortBy>('recent');
  const [activityFilter, setActivityFilter] = useState<ActivityFilter>('all');
  const [healthFloor, setHealthFloor] = useState(0);
  const [view, setView] = useState<ViewMode>('list');
  const [showInsights, setShowInsights] = useState(true);
  const searchRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== '/') return;
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName || '';
      if (target?.isContentEditable || tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
        return;
      }
      event.preventDefault();
      searchRef.current?.focus();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  async function rescanAll() {
    if (rescanRunning) return;
    setRescanResult(null);
    setRescanRunning(true);
    try {
      const result = await apiPost<{ scanned: number; durationMs: number }>('/api/projects/rescan');
      setRescanResult(t('projects.scannedMsg', { count: result.scanned, ms: result.durationMs }));
      reload();
    } catch (e) {
      setRescanResult(`${t('common.empty')} ${String(e)}`);
    } finally {
      setRescanRunning(false);
    }
  }

  function resetFilters() {
    setQuery('');
    setTypeFilter('all');
    setSortBy('recent');
    setActivityFilter('all');
    setHealthFloor(0);
  }

  const projectTypes = useMemo(() => {
    const set = new Set(projects.map((p) => p.type));
    return ['all', ...Array.from(set).sort()];
  }, [projects]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const rows = projects.filter((p) => {
      if (typeFilter !== 'all' && p.type !== typeFilter) return false;
      if (p.health_score < healthFloor) return false;
      if (activityFilter !== 'all') {
        const days = relativeDays(p.last_commit_at);
        if (activityFilter === '7d' && (days === null || days > 7)) return false;
        if (activityFilter === '30d' && (days === null || days > 30)) return false;
        if (activityFilter === 'stale' && (days === null || days <= 180)) {
          if (days !== null) return false;
        }
      }
      if (!q) return true;
      return (
        p.name.toLowerCase().includes(q) ||
        p.path.toLowerCase().includes(q) ||
        p.type.toLowerCase().includes(q)
      );
    });

    rows.sort((a, b) => {
      if (sortBy === 'name') return a.name.localeCompare(b.name);
      if (sortBy === 'health') return b.health_score - a.health_score;
      if (sortBy === 'dirty') return b.uncommitted - a.uncommitted;
      if (sortBy === 'loc') return (b.loc || 0) - (a.loc || 0);
      if (sortBy === 'commit') return (b.last_commit_at || 0) - (a.last_commit_at || 0);
      return b.last_modified - a.last_modified;
    });
    return rows;
  }, [projects, query, typeFilter, healthFloor, activityFilter, sortBy]);

  const stats = useMemo(() => {
    const active7 = projects.filter((p) => {
      const d = relativeDays(p.last_commit_at);
      return d !== null && d <= 7;
    }).length;
    const avgHealth =
      projects.length > 0
        ? Math.round(projects.reduce((s, p) => s + p.health_score, 0) / projects.length)
        : 0;
    const dirty = projects.filter((p) => p.uncommitted > 0).length;
    const totalLoc = projects.reduce((s, p) => s + (p.loc || 0), 0);
    const uniqueLangs = new Set<string>();
    for (const p of projects) {
      for (const [ext] of parseLanguages(p.languages_json)) {
        uniqueLangs.add(ext);
      }
    }
    return {
      total: projects.length,
      shown: filtered.length,
      active7,
      avgHealth,
      dirty,
      totalLoc,
      langs: uniqueLangs.size,
    };
  }, [projects, filtered]);

  const insights = useMemo(() => {
    const langBytes = new Map<string, number>();
    const typeCount = new Map<string, number>();
    let totalBytes = 0;

    for (const p of projects) {
      typeCount.set(p.type, (typeCount.get(p.type) || 0) + 1);
      for (const [ext, bytes] of parseLanguages(p.languages_json)) {
        langBytes.set(ext, (langBytes.get(ext) || 0) + bytes);
        totalBytes += bytes;
      }
    }

    const topLangs = [...langBytes.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([ext, bytes]) => ({
        ext,
        bytes,
        share: totalBytes > 0 ? bytes / totalBytes : 0,
      }));

    const types = [...typeCount.entries()].sort((a, b) => b[1] - a[1]);

    const dirtyLeaders = projects
      .filter((p) => p.uncommitted > 0)
      .sort((a, b) => b.uncommitted - a.uncommitted)
      .slice(0, 3);

    const buckets: Record<StaleBucket, number> = {
      active: 0,
      recent: 0,
      sleep: 0,
      stale: 0,
      unknown: 0,
    };
    for (const p of projects) {
      const d = relativeDays(p.last_commit_at);
      buckets[staleBucketOf(d)] += 1;
    }

    return { topLangs, types, dirtyLeaders, buckets };
  }, [projects]);

  const bucketGroups = useMemo(() => {
    const groups: Record<StaleBucket, ProjectSummary[]> = {
      active: [],
      recent: [],
      sleep: [],
      stale: [],
      unknown: [],
    };
    for (const p of filtered) {
      const d = relativeDays(p.last_commit_at);
      groups[staleBucketOf(d)].push(p);
    }
    return groups;
  }, [filtered]);

  const hasActiveFilters =
    query.trim().length > 0 ||
    typeFilter !== 'all' ||
    activityFilter !== 'all' ||
    healthFloor > 0 ||
    sortBy !== 'recent';

  return (
    <div className="flex flex-col gap-4">
      <Section
        title={t('projects.title')}
        meta={t('projects.meta')}
        action={
          <Button tone="accent" onClick={() => void rescanAll()} disabled={rescanRunning}>
            {rescanRunning ? t('projects.rescanning') : t('projects.rescan')}
          </Button>
        }
      >
        {rescanResult ? (
          <div className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-1)] px-3 py-1.5 text-[12px] text-[var(--text-mute)]">
            {rescanResult}
          </div>
        ) : null}

        {status === 'error' ? <ErrorState message={error.message} onRetry={reload} /> : null}

        <StatStrip stats={stats} />
      </Section>

      {projects.length > 0 ? (
        <Section
          title={t('projects.insights.title')}
          meta={t('projects.insights.meta')}
          action={
            <Button tone="ghost" onClick={() => setShowInsights((v) => !v)}>
              {showInsights ? t('common.collapse') : t('common.expand')}
            </Button>
          }
        >
          {showInsights ? (
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
              <LanguagesCard top={insights.topLangs} />
              <TypesCard types={insights.types} total={stats.total} />
              <DirtyLeadersCard leaders={insights.dirtyLeaders} />
              <StalenessCard buckets={insights.buckets} total={stats.total} />
            </div>
          ) : null}
        </Section>
      ) : null}

      <Section
        title={t('projects.filters.title')}
        meta={
          <span>
            {t('common.searchFocus', { key: '/' })} ·{' '}
            {t('projects.filters.meta', { filtered: filtered.length, total: stats.total })}
          </span>
        }
      >
        <Card>
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative w-full sm:min-w-[220px] sm:flex-1">
              <input
                id="project-search"
                ref={searchRef}
                className="w-full rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-1)] px-3 py-1.5 text-[13px] text-[var(--text)] placeholder:text-[var(--text-faint)] focus:border-[var(--accent)] focus:outline-none"
                placeholder={t('projects.filters.placeholder')}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
              {query ? (
                <button
                  type="button"
                  onClick={() => setQuery('')}
                  aria-label={t('common.clear')}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-[11px] text-[var(--text-faint)] hover:text-[var(--text)]"
                >
                  ×
                </button>
              ) : null}
            </div>

            <Segmented<ActivityFilter>
              value={activityFilter}
              options={[
                { value: 'all', label: t('common.all') },
                { value: '7d', label: t('projects.filters.activity7d') },
                { value: '30d', label: t('projects.filters.activity30d') },
                { value: 'stale', label: t('projects.filters.activityStale') },
              ]}
              onChange={setActivityFilter}
            />

            <select
              value={typeFilter}
              onChange={(event) => setTypeFilter(event.target.value)}
              className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-1)] px-2 py-1.5 text-[12px] text-[var(--text)]"
            >
              {projectTypes.map((type) => (
                <option key={type} value={type}>
                  {type === 'all' ? t('common.allTypes') : type}
                </option>
              ))}
            </select>

            <select
              value={sortBy}
              onChange={(event) => setSortBy(event.target.value as SortBy)}
              className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-1)] px-2 py-1.5 text-[12px] text-[var(--text)]"
            >
              <option value="recent">{t('projects.filters.sortModified')}</option>
              <option value="commit">{t('projects.filters.sortCommit')}</option>
              <option value="health">{t('projects.filters.sortHealth')}</option>
              <option value="dirty">{t('projects.filters.sortDirty')}</option>
              <option value="loc">{t('projects.filters.sortLoc')}</option>
              <option value="name">{t('projects.filters.sortName')}</option>
            </select>

            <div className="flex items-center gap-1.5 text-[11px] text-[var(--text-dim)]">
              <span className="uppercase tracking-[0.08em]">{t('projects.filters.health')}</span>
              <input
                id="health-floor"
                type="range"
                min={0}
                max={100}
                step={5}
                value={healthFloor}
                onChange={(event) => setHealthFloor(Number(event.target.value))}
                className="w-20 accent-[var(--accent)]"
              />
              <span className="num text-[11px] text-[var(--text)]">{healthFloor}+</span>
            </div>

            <Segmented<ViewMode>
              value={view}
              options={[
                { value: 'list', label: t('projects.filters.viewList') },
                { value: 'board', label: t('projects.filters.viewBoard') },
              ]}
              onChange={setView}
            />

            <Button tone="ghost" onClick={resetFilters} disabled={!hasActiveFilters}>
              {t('common.reset')}
            </Button>
          </div>
        </Card>
      </Section>

      <Section
        title={view === 'list' ? t('projects.list.title') : t('projects.list.boardTitle')}
        meta={
          loading
            ? t('common.loading')
            : view === 'list'
              ? t('projects.list.metaCount', { count: filtered.length })
              : t('projects.list.metaBoardCount', { count: filtered.length })
        }
      >
        {loading ? <SkeletonList rows={5} rowClassName="h-14 rounded-xl" /> : null}

        {!loading && status === 'success' && projects.length === 0 ? (
          <EmptyState
            title={t('projects.list.emptyTitle')}
            description={t('projects.list.emptyDesc')}
            action={
              <Button tone="accent" onClick={() => void rescanAll()} disabled={rescanRunning}>
                {rescanRunning ? t('projects.scanInProgress') : t('projects.list.emptyAction')}
              </Button>
            }
          />
        ) : null}

        {!loading && projects.length > 0 && filtered.length === 0 ? (
          <EmptyState
            title={t('projects.list.filteredEmptyTitle')}
            description={t('projects.list.filteredEmptyDesc')}
            action={
              hasActiveFilters ? (
                <Button tone="ghost" onClick={resetFilters}>
                  {t('common.resetFilters')}
                </Button>
              ) : null
            }
          />
        ) : null}

        {!loading && filtered.length > 0 && view === 'list' ? (
          <div className="flex flex-col gap-1.5">
            {filtered.map((project) => (
              <ProjectRow key={project.id} project={project} />
            ))}
          </div>
        ) : null}

        {!loading && filtered.length > 0 && view === 'board' ? (
          <div
            className="grid gap-3"
            style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}
          >
            {(['active', 'recent', 'sleep', 'stale', 'unknown'] as const).map((bucket) => (
              <BoardColumn
                key={bucket}
                bucket={bucket}
                projects={bucketGroups[bucket]}
                total={filtered.length}
              />
            ))}
          </div>
        ) : null}
      </Section>
    </div>
  );
}

function StatStrip({
  stats,
}: {
  stats: {
    total: number;
    shown: number;
    active7: number;
    avgHealth: number;
    dirty: number;
    totalLoc: number;
    langs: number;
  };
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-1 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-1)] px-4 py-2.5">
      <InlineStat label={t('projects.stats.total')} value={String(stats.total)} color="#64d2ff" />
      <InlineStat
        label={t('projects.stats.shown')}
        value={String(stats.shown)}
        color="var(--text)"
      />
      <InlineStat
        label={t('projects.stats.active7d')}
        value={String(stats.active7)}
        color={stats.active7 > 0 ? '#30d158' : 'var(--text-dim)'}
      />
      <InlineStat
        label={t('projects.stats.dirty')}
        value={String(stats.dirty)}
        color={stats.dirty > 0 ? '#ff9500' : 'var(--text-dim)'}
      />
      <InlineStat
        label={t('projects.stats.avgHealth')}
        value={`${stats.avgHealth}/100`}
        color="#ffd60a"
      />
      <InlineStat
        label={t('projects.stats.loc')}
        value={compactLoc(stats.totalLoc)}
        color="#bf5af2"
      />
      <InlineStat
        label={t('projects.stats.languages')}
        value={String(stats.langs)}
        color="#5e5ce6"
      />
    </div>
  );
}

function InlineStat({
  label,
  value,
  color,
}: {
  label: string;
  value: string;
  color: string;
}) {
  return (
    <div className="flex items-baseline gap-1.5">
      <span className="text-[10px] uppercase tracking-[0.08em] text-[var(--text-dim)]">
        {label}
      </span>
      <span className="num text-[16px] font-semibold" style={{ color }}>
        {value}
      </span>
    </div>
  );
}

function LanguagesCard({
  top,
}: {
  top: Array<{ ext: string; bytes: number; share: number }>;
}) {
  const { t } = useTranslation();
  if (top.length === 0) {
    return (
      <Card>
        <CardTitle>{t('projects.stats.languages')}</CardTitle>
        <p className="text-[12px] text-[var(--text-faint)]">
          {t('projects.insights.languagesEmpty')}
        </p>
      </Card>
    );
  }
  const totalBytes = top.reduce((sum, lang) => sum + lang.bytes, 0);
  const segments = top.map((lang) => ({
    value: lang.bytes,
    color: langColor(lang.ext),
    label: langLabel(lang.ext),
    share: lang.share,
  }));
  const topLang = top[0];
  return (
    <Card>
      <CardTitle>{t('projects.insights.topLanguages')}</CardTitle>
      <div className="mt-3 flex items-center gap-3">
        <Donut
          segments={segments}
          size={96}
          thickness={12}
          centerPrimary={`${Math.round(topLang.share * 100)}%`}
          centerSecondary={langLabel(topLang.ext)}
          centerColor={langColor(topLang.ext)}
          ariaTitle={`${t('projects.insights.topLanguages')} · ${totalBytes} B`}
        />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          {segments.map((seg) => (
            <LegendRow
              key={seg.label}
              color={seg.color}
              label={seg.label}
              value={`${Math.round(seg.share * 100)}%`}
            />
          ))}
        </div>
      </div>
    </Card>
  );
}

const TYPE_COLORS: Record<string, string> = {
  node: '#30d158',
  git: '#64d2ff',
  rust: '#ff9500',
  python: '#5e5ce6',
  go: '#0a84ff',
  mixed: '#bf5af2',
  other: '#8e8e93',
};

function typeColor(type: string): string {
  return TYPE_COLORS[type] || '#8e8e93';
}

function TypesCard({ types, total }: { types: Array<[string, number]>; total: number }) {
  const { t } = useTranslation();
  if (types.length === 0) {
    return (
      <Card>
        <CardTitle>{t('projects.insights.projectTypes')}</CardTitle>
        <p className="text-[12px] text-[var(--text-faint)]">—</p>
      </Card>
    );
  }
  const segments = types.map(([type, count]) => ({
    value: count,
    color: typeColor(type),
    label: type,
    share: total > 0 ? count / total : 0,
    count,
  }));
  const topType = segments[0];
  return (
    <Card>
      <CardTitle>{t('projects.insights.projectTypes')}</CardTitle>
      <div className="mt-3 flex items-center gap-3">
        <Donut
          segments={segments}
          size={96}
          thickness={12}
          centerPrimary={String(total)}
          centerSecondary={t('common.projects')}
          centerColor={topType.color}
          ariaTitle={`${t('projects.insights.projectTypes')} · ${total}`}
        />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          {segments.map((seg) => (
            <LegendRow
              key={seg.label}
              color={seg.color}
              label={seg.label}
              value={`${seg.count} · ${Math.round(seg.share * 100)}%`}
            />
          ))}
        </div>
      </div>
    </Card>
  );
}

function DirtyLeadersCard({ leaders }: { leaders: ProjectSummary[] }) {
  const { t } = useTranslation();
  return (
    <Card>
      <CardTitle>{t('projects.insights.dirtyLeaders')}</CardTitle>
      <div className="mt-2 flex flex-col gap-1">
        {leaders.length === 0 ? (
          <span className="text-[12px] text-[var(--text-faint)]">
            {t('projects.insights.noDirty')}
          </span>
        ) : (
          leaders.map((p) => (
            <Link
              key={p.id}
              to={`/projects/${p.id}`}
              className="group flex items-center gap-2 rounded-[var(--radius-sm)] px-1.5 py-1 hover:bg-[var(--surface-2)]"
            >
              <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full bg-[#ff9500]" />
              <span className="min-w-0 flex-1 truncate text-[12.5px] text-[var(--text)] group-hover:text-[var(--accent)]">
                {p.name}
              </span>
              <span className="num shrink-0 rounded-full bg-[rgba(255,149,0,0.12)] px-2 py-0.5 text-[11px] font-medium text-[#ff9500] tabular-nums">
                {p.uncommitted}
              </span>
            </Link>
          ))
        )}
      </div>
    </Card>
  );
}

const BUCKET_META: Record<StaleBucket, { color: string }> = {
  active: { color: '#30d158' },
  recent: { color: '#64d2ff' },
  sleep: { color: '#ffd60a' },
  stale: { color: '#ff453a' },
  unknown: { color: '#8e8e93' },
};

function StalenessCard({
  buckets,
  total,
}: {
  buckets: Record<StaleBucket, number>;
  total: number;
}) {
  const { t } = useTranslation();
  const order: StaleBucket[] = ['active', 'recent', 'sleep', 'stale', 'unknown'];
  const segments = order
    .filter((key) => buckets[key] > 0)
    .map((key) => {
      const count = buckets[key];
      return {
        key,
        value: count,
        color: BUCKET_META[key].color,
        label: t(`projects.insights.buckets.${key}`),
        hint: t(`projects.insights.buckets.${key}Hint`),
        share: total > 0 ? count / total : 0,
        count,
      };
    });
  const activeCount = buckets.active;
  const activeShare = total > 0 ? activeCount / total : 0;
  return (
    <Card>
      <CardTitle>{t('projects.insights.staleness')}</CardTitle>
      <div className="mt-3 flex items-center gap-3">
        <Donut
          segments={
            segments.length > 0 ? segments : [{ value: 1, color: 'rgba(255,255,255,0.08)' }]
          }
          size={96}
          thickness={12}
          centerPrimary={`${Math.round(activeShare * 100)}%`}
          centerSecondary={t('projects.insights.buckets.active').toLowerCase()}
          centerColor={BUCKET_META.active.color}
          ariaTitle={`${t('projects.insights.staleness')} · ${total}`}
        />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          {order.map((key) => {
            const count = buckets[key];
            const share = total > 0 ? (count / total) * 100 : 0;
            return (
              <LegendRow
                key={key}
                color={BUCKET_META[key].color}
                label={t(`projects.insights.buckets.${key}`)}
                hint={t(`projects.insights.buckets.${key}Hint`)}
                value={`${count} · ${Math.round(share)}%`}
                muted={count === 0}
              />
            );
          })}
        </div>
      </div>
    </Card>
  );
}

function CardTitle({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-[10.5px] uppercase tracking-[0.1em] text-[var(--text-dim)]">{children}</h3>
  );
}

type DonutSegment = { value: number; color: string };

function Donut({
  segments,
  size = 96,
  thickness = 12,
  gap = 3,
  centerPrimary,
  centerSecondary,
  centerColor,
  ariaTitle,
}: {
  segments: DonutSegment[];
  size?: number;
  thickness?: number;
  gap?: number;
  centerPrimary?: string;
  centerSecondary?: string;
  centerColor?: string;
  ariaTitle?: string;
}) {
  const radius = (size - thickness) / 2;
  const cx = size / 2;
  const cy = size / 2;
  const circumference = 2 * Math.PI * radius;
  const visible = segments.filter((s) => s.value > 0);
  const total = visible.reduce((sum, seg) => sum + seg.value, 0);

  const arcs: Array<{ color: string; dashArray: string; dashOffset: number }> = [];

  if (total > 0 && visible.length > 0) {
    const singleSegment = visible.length === 1;
    const effectiveGap = singleSegment ? 0 : gap;
    const usable = Math.max(0, circumference - effectiveGap * visible.length);
    let cursor = 0;
    for (const seg of visible) {
      const len = Math.max(0, (seg.value / total) * usable);
      const dashOffset = (circumference - cursor) % circumference;
      arcs.push({
        color: seg.color,
        dashArray: `${len} ${circumference - len}`,
        dashOffset,
      });
      cursor += len + effectiveGap;
    }
  }

  return (
    <div
      className="relative shrink-0"
      style={{ width: size, height: size }}
      role="img"
      aria-label={ariaTitle}
    >
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        aria-hidden="true"
        focusable="false"
      >
        <g transform={`rotate(-90 ${cx} ${cy})`}>
          <circle
            cx={cx}
            cy={cy}
            r={radius}
            fill="none"
            stroke="rgba(255,255,255,0.05)"
            strokeWidth={thickness}
          />
          {arcs.map((arc, i) => (
            <circle
              // biome-ignore lint/suspicious/noArrayIndexKey: segments are order-stable within a render
              key={i}
              cx={cx}
              cy={cy}
              r={radius}
              fill="none"
              stroke={arc.color}
              strokeWidth={thickness}
              strokeDasharray={arc.dashArray}
              strokeDashoffset={arc.dashOffset}
              strokeLinecap="butt"
            />
          ))}
        </g>
      </svg>
      {centerPrimary ? (
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center leading-tight">
          <span
            className="num text-[16px] font-semibold tabular-nums"
            style={{ color: centerColor || 'var(--text)' }}
          >
            {centerPrimary}
          </span>
          {centerSecondary ? (
            <span className="text-[9px] uppercase tracking-[0.08em] text-[var(--text-dim)]">
              {centerSecondary}
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function LegendRow({
  color,
  label,
  value,
  hint,
  muted,
}: {
  color: string;
  label: string;
  value: string;
  hint?: string;
  muted?: boolean;
}) {
  return (
    <div
      className="flex min-w-0 items-center gap-1.5 text-[11.5px]"
      style={{ opacity: muted ? 0.45 : 1 }}
    >
      <span
        aria-hidden="true"
        className="h-1.5 w-1.5 shrink-0 rounded-full"
        style={{ backgroundColor: color }}
      />
      <span className="shrink-0 text-[var(--text)]">{label}</span>
      {hint ? (
        <span
          className="min-w-0 truncate text-[9.5px] uppercase tracking-wider text-[var(--text-faint)]"
          title={hint}
        >
          {hint}
        </span>
      ) : null}
      <span className="num ml-auto shrink-0 text-[11px] text-[var(--text-dim)] tabular-nums">
        {value}
      </span>
    </div>
  );
}

function LangBar({
  languages,
  width = 96,
}: {
  languages: Array<[string, number]>;
  width?: number;
}) {
  if (languages.length === 0) {
    return <div className="h-1 w-[96px] rounded-full bg-[rgba(255,255,255,0.05)]" />;
  }
  const total = languages.reduce((s, [, b]) => s + b, 0);
  const top = languages.slice(0, 5);
  const topSum = top.reduce((s, [, b]) => s + b, 0);
  const rest = Math.max(0, total - topSum);
  return (
    <div
      className="flex h-1 overflow-hidden rounded-full bg-[rgba(255,255,255,0.05)]"
      style={{ width }}
    >
      {top.map(([ext, bytes]) => (
        <span
          key={ext}
          title={`${langLabel(ext)} · ${Math.round((bytes / total) * 100)}%`}
          style={{
            width: `${(bytes / total) * 100}%`,
            backgroundColor: langColor(ext),
          }}
        />
      ))}
      {rest > 0 ? (
        <span
          title={`autres · ${Math.round((rest / total) * 100)}%`}
          style={{
            width: `${(rest / total) * 100}%`,
            backgroundColor: 'rgba(255,255,255,0.12)',
          }}
        />
      ) : null}
    </div>
  );
}

function HealthBadge({
  project,
  tone,
}: {
  project: ProjectSummary;
  tone: 'success' | 'warn' | 'danger' | 'neutral';
}) {
  const { t } = useTranslation();
  const breakdown = useMemo(
    () => parseHealthBreakdown(project.health_breakdown_json),
    [project.health_breakdown_json],
  );

  // Inline `title` = native tooltip that works everywhere without JS popover
  // state. Hover on the chip reveals the full factor breakdown.
  const title = breakdown
    ? Object.values(breakdown.factors)
        .sort((a, b) => b.weight - a.weight)
        .map((f) => {
          const pct = Math.round(f.value * 100);
          const w = Math.round(f.weight * 100);
          return `${f.label} · ${pct}% (w=${w}%) — ${f.reason}`;
        })
        .join('\n')
    : 'Score legacy — rescan pour regénérer le breakdown.';

  return (
    <span title={title} className="inline-flex">
      <Chip tone={tone}>
        {t('common.health')} {project.health_score}
      </Chip>
    </span>
  );
}

function parseHealthBreakdown(raw: string | null | undefined): HealthBreakdown | null {
  if (!raw) return null;
  try {
    return HealthBreakdownSchema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

const ProjectRow = memo(function ProjectRow({ project }: { project: ProjectSummary }) {
  const { t } = useTranslation();
  const days = relativeDays(project.last_commit_at);
  const tone = healthTone(project.health_score);
  const languages = parseLanguages(project.languages_json);
  const topLangs = languages.slice(0, 3).map(([ext]) => ext);

  return (
    <Link
      to={`/projects/${project.id}`}
      className="group block rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-1)] px-3 py-2 transition hover:border-[var(--border-strong)] hover:bg-[var(--surface-2)]"
    >
      {/* Two-zone layout: identity (left) + metrics (right). On mobile
          we force a column stack — every row gets exactly 2 visual lines
          regardless of whether git_branch is set, so card heights are
          uniform across the list. From sm+ we revert to a single-row
          flex with wrap for the original dense desktop look. */}
      <div className="flex flex-col gap-1.5 sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-3 sm:gap-y-1">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 sm:flex-1">
          <span
            aria-hidden="true"
            className="h-1.5 w-1.5 shrink-0 rounded-full"
            style={{ backgroundColor: healthColor(project.health_score) }}
          />
          <span className="truncate text-[13.5px] font-medium text-[var(--text)] group-hover:text-white">
            {project.name}
          </span>
          <span className="shrink-0 rounded-full border border-[var(--border)] px-1.5 py-0 text-[9.5px] uppercase tracking-wider text-[var(--text-faint)]">
            {project.type}
          </span>
          {project.git_branch ? (
            <span className="shrink-0 text-[10.5px] text-[var(--text-faint)]">
              <span aria-hidden="true">⎇</span> {project.git_branch}
            </span>
          ) : null}
          <span className="hidden min-w-0 flex-1 truncate text-[11px] text-[var(--text-dim)] md:inline">
            {project.path}
          </span>
        </div>

        <div className="flex shrink-0 items-center gap-2 sm:ml-auto">
          <LangBar languages={languages} width={96} />
          {topLangs.length > 0 ? (
            <span className="hidden text-[10px] uppercase tracking-wider text-[var(--text-faint)] sm:inline">
              {topLangs.map(langLabel).join(' · ')}
            </span>
          ) : null}
          {project.loc ? (
            <span className="num hidden w-14 text-right text-[11px] text-[var(--text-dim)] tabular-nums sm:inline">
              {compactLoc(project.loc)}
            </span>
          ) : null}
          <HealthBadge project={project} tone={tone} />
          {project.uncommitted > 0 ? (
            <Chip tone="warn">
              {project.uncommitted} {t('common.dirty')}
            </Chip>
          ) : null}
          <span className="num ml-auto w-20 shrink-0 text-right text-[11px] text-[var(--text-dim)] tabular-nums sm:ml-0">
            {fmtDays(days, t)}
          </span>
        </div>
      </div>
    </Link>
  );
});

function BoardColumn({
  bucket,
  projects,
  total,
}: {
  bucket: StaleBucket;
  projects: ProjectSummary[];
  total: number;
}) {
  const { t } = useTranslation();
  const meta = BUCKET_META[bucket];
  const share = total > 0 ? (projects.length / total) * 100 : 0;
  return (
    <div className="flex min-h-[200px] min-w-0 flex-col gap-2 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-1)]/60 p-2.5">
      <div className="flex min-w-0 flex-col gap-0.5">
        <div className="flex min-w-0 items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-1.5">
            <span
              aria-hidden="true"
              className="h-1.5 w-1.5 shrink-0 rounded-full"
              style={{ backgroundColor: meta.color }}
            />
            <span className="truncate text-[12px] font-medium text-[var(--text)]">
              {t(`projects.insights.buckets.${bucket}`)}
            </span>
          </div>
          <span className="num shrink-0 text-[11px] text-[var(--text-dim)] tabular-nums">
            {projects.length}
            <span className="ml-1 text-[var(--text-faint)]">· {Math.round(share)}%</span>
          </span>
        </div>
        <span
          className="truncate text-[10px] uppercase tracking-wider text-[var(--text-faint)]"
          title={t(`projects.insights.buckets.${bucket}Hint`)}
        >
          {t(`projects.insights.buckets.${bucket}Hint`)}
        </span>
      </div>
      {projects.length === 0 ? (
        <span className="py-3 text-center text-[11px] text-[var(--text-faint)]">—</span>
      ) : (
        <div className="flex flex-col gap-1">
          {projects.map((p) => (
            <ProjectMiniCard key={p.id} project={p} />
          ))}
        </div>
      )}
    </div>
  );
}

function ProjectMiniCard({ project }: { project: ProjectSummary }) {
  const { t } = useTranslation();
  const days = relativeDays(project.last_commit_at);
  const languages = parseLanguages(project.languages_json);
  return (
    <Link
      to={`/projects/${project.id}`}
      className="group flex flex-col gap-1 rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-1)] px-2 py-1.5 transition hover:border-[var(--border-strong)] hover:bg-[var(--surface-2)]"
    >
      <div className="flex items-center gap-1.5">
        <span
          aria-hidden="true"
          className="h-1.5 w-1.5 shrink-0 rounded-full"
          style={{ backgroundColor: healthColor(project.health_score) }}
        />
        <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-[var(--text)] group-hover:text-white">
          {project.name}
        </span>
        <span className="shrink-0 text-[9.5px] uppercase tracking-wider text-[var(--text-faint)]">
          {project.type}
        </span>
      </div>
      <LangBar languages={languages} width={180} />
      <div className="flex items-center justify-between text-[10.5px] text-[var(--text-dim)]">
        <span className="num tabular-nums">h {project.health_score}</span>
        {project.uncommitted > 0 ? (
          <span className="num text-[#ff9500] tabular-nums">
            {project.uncommitted} {t('common.dirty')}
          </span>
        ) : null}
        {project.loc ? <span className="num tabular-nums">{compactLoc(project.loc)}</span> : null}
        <span className="num tabular-nums">{fmtDays(days, t)}</span>
      </div>
    </Link>
  );
}
