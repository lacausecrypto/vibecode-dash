import { useEffect, useState } from 'react';
import { apiGet, apiPost } from '../lib/api';
import { type Locale, dateLocale, useTranslation } from '../lib/i18n';
import { Button, Card, Chip, Dot, Empty, Section, Segmented, Toolbar } from './ui';

type Translator = (key: string, vars?: Record<string, string | number>) => string;

type SyncLogKind = 'repos' | 'traffic' | 'heatmap' | 'npm' | 'github-all';
type SyncLogTrigger = 'manual' | 'auto' | 'background';
type SyncLogStatus = 'ok' | 'no-change' | 'partial' | 'error';

type SyncLogEntry = {
  id: string;
  at: number;
  kind: SyncLogKind;
  trigger: SyncLogTrigger;
  status: SyncLogStatus;
  durationMs: number | null;
  summary?: Record<string, unknown>;
};

type GithubStatus = {
  heatmapLastSync: number | null;
  reposLastSync: number | null;
  trafficLastSync: number | null;
};

type SyncFilter = 'all' | 'github' | 'npm' | 'heatmap';

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

function relativeTime(ts: number | null, t: Translator): string {
  if (!ts) return t('github.sourceChipNever');
  const diff = Math.floor(Date.now() / 1000) - ts;
  if (diff < 60) return t('common.today');
  if (diff < 3600) return `${Math.floor(diff / 60)} min`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} h`;
  return t('common.daysAgo', { n: Math.floor(diff / 86400) });
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.round(ms / 1000)} s`;
}

function deriveLatestByKind(entries: SyncLogEntry[], kind: SyncLogKind): number | null {
  for (const entry of entries) {
    if (entry.kind === kind && entry.status !== 'error') return entry.at;
  }
  return null;
}

export function SyncLogSection() {
  const { t, locale } = useTranslation();
  const [entries, setEntries] = useState<SyncLogEntry[]>([]);
  const [status, setStatus] = useState<GithubStatus | null>(null);
  const [filter, setFilter] = useState<SyncFilter>('all');
  const [isSyncing, setIsSyncing] = useState(false);
  const [isRefreshingNpm, setIsRefreshingNpm] = useState(false);

  async function loadLog() {
    const data = await apiGet<{ rows: SyncLogEntry[] }>('/api/github/sync-log?limit=50').catch(
      () => ({
        rows: [] as SyncLogEntry[],
      }),
    );
    setEntries(data.rows || []);
  }

  async function loadStatus() {
    const data = await apiGet<GithubStatus>('/api/github/status').catch(() => null);
    setStatus(data);
  }

  useEffect(() => {
    void loadLog();
    void loadStatus();
  }, []);

  async function onSyncGithub() {
    if (isSyncing) return;
    setIsSyncing(true);
    try {
      await apiPost('/api/github/sync', {});
      await Promise.all([loadLog(), loadStatus()]);
    } finally {
      setIsSyncing(false);
    }
  }

  async function onRefreshNpm() {
    if (isRefreshingNpm) return;
    setIsRefreshingNpm(true);
    try {
      await apiPost('/api/github/npm/refresh', {});
      await loadLog();
    } finally {
      setIsRefreshingNpm(false);
    }
  }

  const filtered = entries.filter((entry) => {
    if (filter === 'all') return true;
    if (filter === 'heatmap') return entry.kind === 'heatmap';
    if (filter === 'npm') return entry.kind === 'npm';
    return entry.kind !== 'npm' && entry.kind !== 'heatmap';
  });

  const sources: Array<{ key: SyncLogKind; label: string; at: number | null }> = [
    { key: 'repos', label: 'repos', at: status?.reposLastSync ?? null },
    { key: 'traffic', label: 'traffic', at: status?.trafficLastSync ?? null },
    { key: 'heatmap', label: 'heatmap', at: status?.heatmapLastSync ?? null },
    { key: 'npm', label: 'npm', at: deriveLatestByKind(entries, 'npm') },
  ];

  return (
    <Section
      title={t('github.syncLog.title')}
      meta={t('github.syncLog.meta', { count: filtered.length })}
      action={
        <div className="flex items-center gap-2">
          <Button tone="ghost" onClick={() => void loadLog()} title="refresh log">
            ↻
          </Button>
          <Button
            tone="ghost"
            onClick={() => void onRefreshNpm()}
            disabled={isRefreshingNpm}
            title="refresh npm"
          >
            {isRefreshingNpm ? '…' : 'npm'}
          </Button>
          <Button
            tone="accent"
            onClick={() => void onSyncGithub()}
            disabled={isSyncing}
            title="sync github"
          >
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
          <Segmented<SyncFilter>
            value={filter}
            options={[
              { value: 'all', label: t('github.syncLog.filters.all') },
              { value: 'github', label: 'GitHub' },
              { value: 'heatmap', label: 'heatmap' },
              { value: 'npm', label: 'npm' },
            ]}
            onChange={setFilter}
          />
        </Toolbar>

        {filtered.length === 0 ? (
          <div className="mt-3">
            <Empty>{t('github.syncLog.empty')}</Empty>
          </div>
        ) : (
          <ul className="mt-3 max-h-[420px] space-y-2 overflow-y-auto pr-1">
            {filtered.map((entry) => (
              <SyncLogRow key={entry.id} entry={entry} t={t} locale={locale} />
            ))}
          </ul>
        )}
      </Card>
    </Section>
  );
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

function SyncLogRow({
  entry,
  t,
  locale,
}: {
  entry: SyncLogEntry;
  t: Translator;
  locale: Locale;
}) {
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
          title={new Date(entry.at * 1000).toLocaleString(dateLocale(locale))}
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
