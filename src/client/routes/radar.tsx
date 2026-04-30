import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts';
import { Button, Card, Chip, Empty, ErrorBanner, Section, Segmented, Stat } from '../components/ui';
import { apiDelete, apiGet, apiPost } from '../lib/api';
import { useTranslation } from '../lib/i18n';
import { formatBinding, useBindings, useShortcut } from '../lib/shortcuts';

type Translator = (key: string, vars?: Record<string, string | number>) => string;

type ProjectSummary = { id: string; name: string; path: string; type?: string | null };

type Competitor = {
  id: string;
  project_id: string;
  name: string;
  url: string | null;
  pitch: string | null;
  strengths_json: string | null;
  weaknesses_json: string | null;
  features_json: string | null;
  last_seen: number;
  discovered_at: number;
  source: string;
};

type Insight = {
  id: string;
  type: string;
  title: string;
  body: string | null;
  related_projects_json: string | null;
  related_notes_json: string | null;
  meta_json: string | null;
  created_at: number;
  status: string | null;
};

type AgentRun = {
  ok: boolean;
  exitCode: number;
  durationMs: number;
  model: string | null;
  costUsd: number | null;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheCreateTokens: number;
    cacheReadTokens: number;
  } | null;
};

type ScanResult = { run: AgentRun; written: number; competitors: Competitor[]; stderr?: string };
type GenerateResult = { run: AgentRun; written: number; insights: Insight[]; stderr?: string };

type CompetitorsView = 'cards' | 'matrix';
type InsightsFilter = 'pending' | 'explored' | 'dismissed';

type RadarSummaryRow = {
  project_id: string;
  project_name: string;
  competitors: number;
  competitors_manual: number;
  competitors_agent: number;
  insights_pending: number;
  insights_explored: number;
  insights_dismissed: number;
  insights_market_gap: number;
  insights_overlap: number;
  insights_vault_echo: number;
  last_seen: number | null;
};

function parseList(json: string | null): string[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

function parseMetaCompetitors(json: string | null): string[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    if (parsed && typeof parsed === 'object' && Array.isArray(parsed.related_competitors)) {
      return parsed.related_competitors.filter((v: unknown): v is string => typeof v === 'string');
    }
    return [];
  } catch {
    return [];
  }
}

const INSIGHT_LABEL: Record<string, { label: string; tone: 'accent' | 'warn' | 'success' }> = {
  market_gap: { label: 'Market gap', tone: 'accent' },
  overlap: { label: 'Overlap', tone: 'warn' },
  vault_echo: { label: 'Vault echo', tone: 'success' },
};

function relativeTime(ts: number): string {
  const delta = Math.floor(Date.now() / 1000) - ts;
  if (delta < 60) return `${delta}s`;
  if (delta < 3600) return `${Math.floor(delta / 60)}m`;
  if (delta < 86400) return `${Math.floor(delta / 3600)}h`;
  return `${Math.floor(delta / 86400)}d`;
}

function formatError(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

export default function RadarRoute() {
  const { t } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(() =>
    searchParams.get('projectId'),
  );
  const [competitorsView, setCompetitorsView] = useState<CompetitorsView>('cards');
  const [insightsFilter, setInsightsFilter] = useState<InsightsFilter>('pending');
  const [competitors, setCompetitors] = useState<Competitor[]>([]);
  const [insights, setInsights] = useState<Insight[]>([]);
  const [scanning, setScanning] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastRun, setLastRun] = useState<{
    kind: 'scan' | 'generate';
    run: AgentRun;
    written: number;
  } | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [summary, setSummary] = useState<RadarSummaryRow[]>([]);
  const [addOpen, setAddOpen] = useState(false);
  const [manualName, setManualName] = useState('');
  const [manualUrl, setManualUrl] = useState('');
  const [manualPitch, setManualPitch] = useState('');
  const manualNameRef = useRef<HTMLInputElement | null>(null);
  const bindings = useBindings();

  useEffect(() => {
    if (addOpen) manualNameRef.current?.focus();
  }, [addOpen]);

  useEffect(() => {
    apiGet<ProjectSummary[]>('/api/projects')
      .then(setProjects)
      .catch((e) => setError(formatError(e)));
  }, []);

  const loadRadar = useCallback(async (projectId: string | null, status: InsightsFilter) => {
    try {
      if (projectId) {
        const [c, i] = await Promise.all([
          apiGet<Competitor[]>(`/api/projects/${projectId}/competitors`),
          apiGet<Insight[]>(`/api/insights?projectId=${projectId}&status=${status}`),
        ]);
        setCompetitors(c);
        setInsights(i);
      } else {
        const [s, i] = await Promise.all([
          apiGet<RadarSummaryRow[]>('/api/radar/summary'),
          apiGet<Insight[]>(`/api/insights?status=${status}&limit=200`),
        ]);
        setSummary(s);
        setCompetitors([]);
        setInsights(i);
      }
      setError(null);
    } catch (e) {
      setError(formatError(e));
    }
  }, []);

  useEffect(() => {
    void loadRadar(selectedProjectId, insightsFilter);
  }, [selectedProjectId, insightsFilter, loadRadar]);

  const selectedProject = useMemo(
    () => projects.find((p) => p.id === selectedProjectId) || null,
    [projects, selectedProjectId],
  );

  const stats = useMemo(() => {
    const manualCount = competitors.filter((c) => c.source === 'manual').length;
    const agentCount = competitors.length - manualCount;
    const byType = {
      market_gap: insights.filter((i) => i.type === 'market_gap').length,
      overlap: insights.filter((i) => i.type === 'overlap').length,
      vault_echo: insights.filter((i) => i.type === 'vault_echo').length,
    };
    const lastSeen = competitors.reduce((acc, c) => Math.max(acc, c.last_seen), 0);
    return { manualCount, agentCount, byType, lastSeen };
  }, [competitors, insights]);

  async function handleScan() {
    if (!selectedProjectId) return;
    setScanning(true);
    setError(null);
    try {
      const res = await apiPost<ScanResult>(
        `/api/projects/${selectedProjectId}/competitors/scan`,
        {},
      );
      setCompetitors(res.competitors);
      setLastRun({ kind: 'scan', run: res.run, written: res.written });
      if (res.stderr) setError(t('radar.lastRun.scanPartial', { stderr: res.stderr }));
    } catch (e) {
      setError(formatError(e));
    } finally {
      setScanning(false);
    }
  }

  async function handleGenerate() {
    if (!selectedProjectId) return;
    setGenerating(true);
    setError(null);
    try {
      const res = await apiPost<GenerateResult>(
        `/api/projects/${selectedProjectId}/insights/generate`,
        {},
      );
      setInsights(res.insights.filter((i) => i.status === 'pending'));
      setLastRun({ kind: 'generate', run: res.run, written: res.written });
      if (res.stderr) setError(t('radar.lastRun.generatePartial', { stderr: res.stderr }));
    } catch (e) {
      setError(formatError(e));
    } finally {
      setGenerating(false);
    }
  }

  async function handleAddManual(event: React.FormEvent) {
    event.preventDefault();
    if (!selectedProjectId || !manualName.trim()) return;
    try {
      await apiPost(`/api/projects/${selectedProjectId}/competitors`, {
        name: manualName.trim(),
        url: manualUrl.trim() || null,
        pitch: manualPitch.trim() || null,
      });
      setManualName('');
      setManualUrl('');
      setManualPitch('');
      setAddOpen(false);
      await loadRadar(selectedProjectId, insightsFilter);
    } catch (e) {
      setError(formatError(e));
    }
  }

  async function handleDeleteCompetitor(id: string, name: string) {
    if (!window.confirm(t('radar.confirm.delete', { name }))) return;
    try {
      await apiDelete(`/api/competitors/${id}`);
      if (selectedProjectId) await loadRadar(selectedProjectId, insightsFilter);
    } catch (e) {
      setError(formatError(e));
    }
  }

  async function handleInsightStatus(id: string, status: 'pending' | 'explored' | 'dismissed') {
    try {
      await apiPost(`/api/insights/${id}/status`, { status });
      setInsights((rows) => rows.filter((r) => r.id !== id));
    } catch (e) {
      setError(formatError(e));
    }
  }

  function showPromotedToast(path: string) {
    setToast(t('radar.toast.noteCreated', { path }));
    setTimeout(() => setToast(null), 3500);
  }

  // Customisable shortcuts — bindings live in localStorage, editable in /settings.
  useShortcut(
    'radar.scan',
    () => {
      if (selectedProjectId && !scanning) void handleScan();
    },
    Boolean(selectedProjectId),
  );
  useShortcut(
    'radar.generate',
    () => {
      if (selectedProjectId && !generating) void handleGenerate();
    },
    Boolean(selectedProjectId),
  );
  useShortcut(
    'radar.toggleMatrix',
    () => {
      if (selectedProjectId) setCompetitorsView((v) => (v === 'cards' ? 'matrix' : 'cards'));
    },
    Boolean(selectedProjectId),
  );

  function switchProject(value: string | null) {
    setSelectedProjectId(value);
    const next = new URLSearchParams(searchParams);
    if (value) next.set('projectId', value);
    else next.delete('projectId');
    setSearchParams(next, { replace: true });
  }

  const globalMode = !selectedProjectId;

  // Project picker rendered as the top Section's action — replaces the
  // bespoke <header> bar that didn't match the rest of the dashboard.
  // The "open project" link sits in the meta line below so it stays
  // visible without taking action-row width when a project is picked.
  const projectPicker = (
    <select
      value={selectedProjectId || '__all__'}
      onChange={(e) => switchProject(e.target.value === '__all__' ? null : e.target.value)}
      className="!py-1 !text-[12px]"
      aria-label={t('radar.allProjects')}
    >
      <option value="__all__">{t('radar.allProjects')}</option>
      {projects.map((p) => (
        <option key={p.id} value={p.id}>
          {p.name}
        </option>
      ))}
    </select>
  );

  // Compact run-summary line inserted into the Actions Section meta —
  // surfaces the latest scan/generate cost+duration without taking a
  // full row of toolbar real estate. Returns null when nothing to show
  // so the meta falls back to the static description.
  const lastRunMeta = lastRun ? (
    <span className="flex flex-wrap items-center gap-1.5 text-[11px]">
      <Chip tone={lastRun.run.ok ? 'success' : 'danger'}>
        {t('radar.lastRun.chip', {
          kind: lastRun.kind,
          written: lastRun.written,
          seconds: Math.round(lastRun.run.durationMs / 100) / 10,
        })}
      </Chip>
      {lastRun.run.usage ? (
        <span className="num text-[var(--text-dim)]">
          {t('radar.lastRun.tokens', {
            input: lastRun.run.usage.inputTokens,
            output: lastRun.run.usage.outputTokens,
          })}
        </span>
      ) : null}
      {lastRun.run.model ? (
        <span className="text-[var(--text-faint)]">· {lastRun.run.model}</span>
      ) : null}
    </span>
  ) : null;

  return (
    <div className="flex flex-col gap-4">
      {/* ============== Header Section — title + project picker ==============
          Standard <Section> layout matching every other dashboard page
          (overview/projects/github/usage). Project picker lives in the
          action slot; "open project" link is folded into the meta line
          when a project is selected. Error/toast banners live inside so
          they sit immediately under the title and don't stretch full-width
          across the page like an unrelated banner would. */}
      <Section
        title={t('radar.title')}
        meta={
          <span className="flex flex-wrap items-center gap-1.5">
            <span>{t('radar.subtitle')}</span>
            {selectedProject ? (
              <>
                <span aria-hidden="true">·</span>
                <Link
                  to={`/projects/${selectedProject.id}`}
                  className="text-[var(--accent)] hover:underline"
                >
                  {t('radar.openProject')}
                </Link>
              </>
            ) : null}
          </span>
        }
        action={projectPicker}
      >
        {error ? <ErrorBanner>{error}</ErrorBanner> : null}
        {toast ? (
          <output className="block rounded-[var(--radius-sm)] border border-[rgba(48,209,88,0.35)] bg-[rgba(48,209,88,0.08)] px-3 py-1.5 text-[12px] text-[var(--text)]">
            {toast}
          </output>
        ) : null}
      </Section>

      {/* ============== Project mode: KPI strip + actions + 2-col main ============== */}
      {!globalMode ? (
        <>
          {/* KPI strip — 4 main metrics. "Last scan" relegated to the
              Section meta (right side) instead of being a 5th equal Stat,
              so the eye lands on the 4 numbers that actually matter. */}
          <Section
            title={t('radar.kpi.title')}
            meta={
              <span className="flex flex-wrap items-center gap-1.5">
                <span>
                  {t('radar.stats.sourceHint', {
                    agent: stats.agentCount,
                    manual: stats.manualCount,
                  })}
                </span>
                <span aria-hidden="true">·</span>
                <span>
                  {t('radar.stats.lastScan')}{' '}
                  {stats.lastSeen > 0 ? (
                    <span
                      className="text-[var(--text)]"
                      title={new Date(stats.lastSeen * 1000).toLocaleString()}
                    >
                      {relativeTime(stats.lastSeen)}
                    </span>
                  ) : (
                    <span className="text-[var(--text-faint)]">{t('radar.stats.neverRan')}</span>
                  )}
                </span>
              </span>
            }
          >
            {/* Same pattern as the cross-project Overview: 2 context KPIs
                stacked on the left, insights-mix donut on the right. The
                previous flat 4-card strip clipped/wrapped long labels in
                narrow grid cells (cf. "COMPETITOR / S" wrap on tablet). */}
            <div className="grid grid-cols-1 gap-3 lg:grid-cols-[1fr_2fr]">
              <div className="grid grid-cols-2 gap-2 sm:gap-3 lg:grid-cols-1">
                <Stat
                  label={t('radar.stats.competitors')}
                  value={competitors.length}
                  hint={t('radar.stats.sourceHint', {
                    agent: stats.agentCount,
                    manual: stats.manualCount,
                  })}
                />
                <Stat
                  label={t('radar.global.totalInsights')}
                  value={stats.byType.market_gap + stats.byType.overlap + stats.byType.vault_echo}
                />
              </div>
              <Card>
                <RadarInsightsDonut
                  t={t}
                  slices={[
                    {
                      key: 'marketGap',
                      label: t('radar.stats.marketGaps'),
                      value: stats.byType.market_gap,
                      color: '#0a84ff',
                    },
                    {
                      key: 'overlap',
                      label: t('radar.stats.overlaps'),
                      value: stats.byType.overlap,
                      color: '#ffd60a',
                    },
                    {
                      key: 'vaultEcho',
                      label: t('radar.stats.vaultEchoes'),
                      value: stats.byType.vault_echo,
                      color: '#30d158',
                    },
                  ]}
                />
              </Card>
            </div>
          </Section>

          {/* Actions Section — Scan + Generate as the section action,
              last-run chip in the meta. The "Add manual" toggle lives
              inside as a Card-wrapped disclosure: when open, the form
              renders in the same Card so the visual frame matches the
              rest of the dashboard's form treatment. */}
          <Section
            title={t('radar.actions.title')}
            meta={lastRunMeta ?? t('radar.actions.meta')}
            action={
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  tone="primary"
                  onClick={() => void handleScan()}
                  disabled={scanning}
                  title={t('radar.actions.scanTitle')}
                >
                  {scanning ? t('radar.actions.scanning') : t('radar.actions.scan')}
                  <kbd className="ml-1.5 text-[10px] opacity-60">
                    {formatBinding(bindings['radar.scan'])}
                  </kbd>
                </Button>
                <Button
                  tone="primary"
                  onClick={() => void handleGenerate()}
                  disabled={generating}
                  title={t('radar.actions.generateTitle')}
                >
                  {generating ? t('radar.actions.generating') : t('radar.actions.generate')}
                  <kbd className="ml-1.5 text-[10px] opacity-60">
                    {formatBinding(bindings['radar.generate'])}
                  </kbd>
                </Button>
              </div>
            }
          >
            <Card>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-[12px] text-[var(--text-dim)]">
                  {t('radar.actions.manualHint')}
                </span>
                <Button
                  tone="ghost"
                  onClick={() => setAddOpen((v) => !v)}
                  title={t('radar.actions.addManualTitle')}
                  className="!py-1 !text-[12px]"
                >
                  {addOpen ? t('radar.actions.cancelAdd') : t('radar.actions.addManual')}
                </Button>
              </div>
              {addOpen ? (
                <form
                  onSubmit={handleAddManual}
                  className="mt-3 grid grid-cols-1 gap-2 md:grid-cols-[minmax(160px,1fr)_minmax(180px,1fr)_minmax(200px,2fr)_auto]"
                >
                  <input
                    ref={manualNameRef}
                    value={manualName}
                    onChange={(e) => setManualName(e.target.value)}
                    placeholder={t('radar.form.namePlaceholder')}
                    className="!py-1 !text-[12px]"
                    required
                  />
                  <input
                    type="url"
                    value={manualUrl}
                    onChange={(e) => setManualUrl(e.target.value)}
                    placeholder={t('radar.form.urlPlaceholder')}
                    className="!py-1 !text-[12px]"
                  />
                  <input
                    value={manualPitch}
                    onChange={(e) => setManualPitch(e.target.value)}
                    placeholder={t('radar.form.pitchPlaceholder')}
                    className="!py-1 !text-[12px]"
                  />
                  <Button tone="primary" type="submit" className="!py-1 !text-[12px]">
                    {t('radar.actions.add')}
                  </Button>
                </form>
              ) : null}
            </Card>
          </Section>

          {/* 2-col: competitors (left) + insights (right). xl: side-by-side,
              below xl: stacked. Each column is its own Section so titles
              and Segmented controls stay visually anchored. */}
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <Section
              title={t('radar.competitors.sectionTitle', { n: competitors.length })}
              meta={t('radar.stats.sourceHint', {
                agent: stats.agentCount,
                manual: stats.manualCount,
              })}
              action={
                <Segmented
                  value={competitorsView}
                  options={[
                    { value: 'cards' as CompetitorsView, label: t('radar.competitors.viewCards') },
                    {
                      value: 'matrix' as CompetitorsView,
                      label: t('radar.competitors.viewMatrix'),
                    },
                  ]}
                  onChange={setCompetitorsView}
                />
              }
            >
              {competitors.length === 0 ? (
                <Empty>
                  <div className="flex flex-col items-center gap-2">
                    <span>{t('radar.competitors.emptyHint')}</span>
                    <div className="flex flex-wrap items-center justify-center gap-2">
                      <Button
                        tone="primary"
                        onClick={() => void handleScan()}
                        disabled={scanning}
                        className="!py-1 !text-[12px]"
                      >
                        {scanning ? t('radar.actions.scanning') : t('radar.actions.scan')}
                      </Button>
                      <Button
                        tone="ghost"
                        onClick={() => setAddOpen(true)}
                        className="!py-1 !text-[12px]"
                      >
                        {t('radar.actions.addManual')}
                      </Button>
                    </div>
                  </div>
                </Empty>
              ) : competitorsView === 'matrix' ? (
                <FeaturesMatrix competitors={competitors} t={t} />
              ) : (
                <div className="flex flex-col gap-2">
                  {competitors.map((c) => (
                    <CompetitorCard
                      key={c.id}
                      competitor={c}
                      onDelete={() => void handleDeleteCompetitor(c.id, c.name)}
                      t={t}
                    />
                  ))}
                </div>
              )}
            </Section>

            <Section
              title={t('radar.insights.sectionTitle', { n: insights.length })}
              meta={t('radar.insights.metaDetailed', {
                gap: stats.byType.market_gap,
                overlap: stats.byType.overlap,
                echo: stats.byType.vault_echo,
              })}
              action={
                <Segmented
                  value={insightsFilter}
                  options={[
                    {
                      value: 'pending' as InsightsFilter,
                      label: t('radar.insights.filterPending'),
                    },
                    {
                      value: 'explored' as InsightsFilter,
                      label: t('radar.insights.filterExplored'),
                    },
                    {
                      value: 'dismissed' as InsightsFilter,
                      label: t('radar.insights.filterDismissed'),
                    },
                  ]}
                  onChange={setInsightsFilter}
                />
              }
            >
              {insights.length === 0 ? (
                <Empty>
                  {insightsFilter === 'pending' ? (
                    <div className="flex flex-col items-center gap-2">
                      <span>{t('radar.insights.emptyPendingProject')}</span>
                      <Button
                        tone="primary"
                        onClick={() => void handleGenerate()}
                        disabled={generating}
                        className="!py-1 !text-[12px]"
                      >
                        {generating ? t('radar.actions.generating') : t('radar.actions.generate')}
                      </Button>
                    </div>
                  ) : insightsFilter === 'explored' ? (
                    t('radar.insights.emptyExplored')
                  ) : (
                    t('radar.insights.emptyDismissed')
                  )}
                </Empty>
              ) : (
                <div className="flex flex-col gap-2">
                  {insights.map((i) => (
                    <InsightCard
                      key={i.id}
                      insight={i}
                      projects={projects}
                      showProject={false}
                      filter={insightsFilter}
                      onExplored={() => void handleInsightStatus(i.id, 'explored')}
                      onDismissed={() => void handleInsightStatus(i.id, 'dismissed')}
                      onRestore={() => void handleInsightStatus(i.id, 'pending')}
                      onPromoted={showPromotedToast}
                      t={t}
                    />
                  ))}
                </div>
              )}
            </Section>
          </div>
        </>
      ) : (
        /* ============== Global mode: cross-project overview ==============
           Stats + active projects table from GlobalSummary, then the
           cross-project insights feed below. Both components are now
           proper Sections (handled inside GlobalSummary + here). */
        <>
          <GlobalSummary
            summary={summary}
            onPick={(id) => switchProject(id)}
            t={t}
            scanKey={formatBinding(bindings['radar.scan'])}
          />

          <Section
            title={t('radar.insights.sectionTitle', { n: insights.length })}
            meta={t('radar.insights.metaGlobal')}
            action={
              <Segmented
                value={insightsFilter}
                options={[
                  {
                    value: 'pending' as InsightsFilter,
                    label: t('radar.insights.filterPending'),
                  },
                  {
                    value: 'explored' as InsightsFilter,
                    label: t('radar.insights.filterExplored'),
                  },
                  {
                    value: 'dismissed' as InsightsFilter,
                    label: t('radar.insights.filterDismissed'),
                  },
                ]}
                onChange={setInsightsFilter}
              />
            }
          >
            {insights.length === 0 ? (
              <Empty>
                {insightsFilter === 'pending'
                  ? t('radar.insights.emptyPendingGlobal')
                  : insightsFilter === 'explored'
                    ? t('radar.insights.emptyExplored')
                    : t('radar.insights.emptyDismissed')}
              </Empty>
            ) : (
              <div className="flex flex-col gap-2">
                {insights.map((i) => (
                  <InsightCard
                    key={i.id}
                    insight={i}
                    projects={projects}
                    showProject={true}
                    filter={insightsFilter}
                    onExplored={() => void handleInsightStatus(i.id, 'explored')}
                    onDismissed={() => void handleInsightStatus(i.id, 'dismissed')}
                    onRestore={() => void handleInsightStatus(i.id, 'pending')}
                    onPromoted={showPromotedToast}
                    t={t}
                  />
                ))}
              </div>
            )}
          </Section>
        </>
      )}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────

function GlobalSummary({
  summary,
  onPick,
  t,
  scanKey,
}: {
  summary: RadarSummaryRow[];
  onPick: (projectId: string) => void;
  t: Translator;
  scanKey: string;
}) {
  const totals = useMemo(() => {
    const t = summary.reduce(
      (acc, r) => {
        acc.competitors += r.competitors;
        acc.pending += r.insights_pending;
        acc.explored += r.insights_explored;
        acc.market_gap += r.insights_market_gap;
        acc.overlap += r.insights_overlap;
        acc.vault_echo += r.insights_vault_echo;
        return acc;
      },
      { competitors: 0, pending: 0, explored: 0, market_gap: 0, overlap: 0, vault_echo: 0 },
    );
    return { ...t, projects: summary.length };
  }, [summary]);

  if (summary.length === 0) {
    return (
      <Section title={t('radar.global.emptyTitle')} meta={t('radar.global.emptyMeta')}>
        <Empty>{t('radar.global.emptyBody', { scanKey })}</Empty>
      </Section>
    );
  }

  return (
    <>
      {/* Stats Section — context KPIs on the left, insights breakdown
          donut on the right. Donut + center total + side legend tells the
          insight-mix story at a glance; the previous flat 6-stat strip
          buried the breakdown under uniform cards (and clipped labels in
          narrow cells). */}
      <Section title={t('radar.global.statsTitle')} meta={t('radar.global.statsMeta')}>
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-[1fr_2fr]">
          {/* 3 cards always fill the row evenly: 3-up on mobile/tablet
              (no awkward orphan in a 2-col grid), then stacked vertically
              when the parent splits into [stats | donut] at lg. */}
          <div className="grid grid-cols-3 gap-2 sm:gap-3 lg:grid-cols-1">
            <Stat label={t('radar.stats.activeProjects')} value={totals.projects} />
            <Stat label={t('radar.stats.competitors')} value={totals.competitors} />
            <Stat
              label={t('radar.global.totalInsights')}
              value={
                totals.pending +
                totals.explored +
                totals.market_gap +
                totals.overlap +
                totals.vault_echo
              }
            />
          </div>
          <Card>
            <RadarInsightsDonut
              t={t}
              slices={[
                {
                  key: 'pending',
                  label: t('radar.stats.pending'),
                  value: totals.pending,
                  color: '#64d2ff',
                },
                {
                  key: 'marketGap',
                  label: t('radar.stats.marketGaps'),
                  value: totals.market_gap,
                  color: '#0a84ff',
                },
                {
                  key: 'overlap',
                  label: t('radar.stats.overlaps'),
                  value: totals.overlap,
                  color: '#ffd60a',
                },
                {
                  key: 'vaultEcho',
                  label: t('radar.stats.vaultEchoes'),
                  value: totals.vault_echo,
                  color: '#30d158',
                },
                {
                  key: 'explored',
                  label: t('radar.global.exploredLabel'),
                  value: totals.explored,
                  color: '#8e8e93',
                },
              ]}
            />
          </Card>
        </div>
      </Section>

      <Section
        title={t('radar.global.activeSection', { n: summary.length })}
        meta={t('radar.global.activeMeta')}
      >
        <div className="overflow-x-auto rounded-[var(--radius-sm)] border border-[var(--border)]">
          <table className="w-full min-w-[640px] border-collapse text-[12px]">
            <thead>
              <tr className="bg-[var(--surface-2)] text-[var(--text-mute)]">
                <th className="px-2 py-1.5 text-left font-medium">
                  {t('radar.global.colProject')}
                </th>
                <th
                  className="px-2 py-1.5 text-right font-medium"
                  title={t('radar.global.colCompetitorsTitle')}
                >
                  {t('radar.global.colCompetitorsShort')}
                </th>
                <th
                  className="px-2 py-1.5 text-right font-medium"
                  title={t('radar.global.colPendingTitle')}
                >
                  {t('radar.global.colPending')}
                </th>
                <th
                  className="px-2 py-1.5 text-right font-medium"
                  title={t('radar.global.colGapTitle')}
                >
                  {t('radar.global.colGap')}
                </th>
                <th
                  className="px-2 py-1.5 text-right font-medium"
                  title={t('radar.global.colOverlapTitle')}
                >
                  {t('radar.global.colOverlap')}
                </th>
                <th
                  className="px-2 py-1.5 text-right font-medium"
                  title={t('radar.global.colEchoTitle')}
                >
                  {t('radar.global.colEcho')}
                </th>
                <th
                  className="px-2 py-1.5 text-right font-medium"
                  title={t('radar.global.colExploredTitle')}
                >
                  {t('radar.global.colExplored')}
                </th>
                <th className="px-2 py-1.5 text-right font-medium">
                  {t('radar.global.colLastScan')}
                </th>
                {/* Empty header above the row chevron so column count
                    stays consistent with tbody rows. */}
                <th aria-hidden="true" className="w-6" />
              </tr>
            </thead>
            <tbody>
              {summary.map((r) => (
                <tr
                  key={r.project_id}
                  onClick={() => onPick(r.project_id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      onPick(r.project_id);
                    }
                  }}
                  tabIndex={0}
                  className="group cursor-pointer border-t border-[var(--border)] hover:bg-[var(--surface-2)] focus:bg-[var(--surface-2)] focus:outline-none"
                >
                  <td className="px-2 py-1.5">
                    <span className="font-medium text-[var(--text)]">{r.project_name}</span>
                    {r.competitors_manual > 0 ? (
                      <span className="ml-2 text-[10px] text-[var(--text-faint)]">
                        {t('radar.global.manualCount', { n: r.competitors_manual })}
                      </span>
                    ) : null}
                  </td>
                  <td className="px-2 py-1.5 text-right num text-[var(--text-mute)]">
                    {r.competitors || '—'}
                  </td>
                  <td
                    className={`px-2 py-1.5 text-right num ${
                      r.insights_pending > 0 ? 'text-[#64d2ff]' : 'text-[var(--text-faint)]'
                    }`}
                  >
                    {r.insights_pending || '—'}
                  </td>
                  <td className="px-2 py-1.5 text-right num text-[var(--text-mute)]">
                    {r.insights_market_gap || '—'}
                  </td>
                  <td className="px-2 py-1.5 text-right num text-[var(--text-mute)]">
                    {r.insights_overlap || '—'}
                  </td>
                  <td className="px-2 py-1.5 text-right num text-[var(--text-mute)]">
                    {r.insights_vault_echo || '—'}
                  </td>
                  <td className="px-2 py-1.5 text-right num text-[var(--text-faint)]">
                    {r.insights_explored || '—'}
                  </td>
                  <td className="px-2 py-1.5 text-right num text-[var(--text-faint)]">
                    {r.last_seen ? relativeTime(r.last_seen) : '—'}
                  </td>
                  {/* Chevron — visual signal that the row is navigable.
                      Faint by default, brightens on row hover via `group`
                      so it doesn't add noise on a long table at rest. */}
                  <td
                    aria-hidden="true"
                    className="w-6 px-1 text-right text-[14px] text-[var(--text-faint)] transition-colors group-hover:text-[var(--text-dim)]"
                  >
                    ›
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>
    </>
  );
}

type DonutSlice = { key: string; label: string; value: number; color: string };

/**
 * Donut chart showing the mix of insight types. Each slice colour-coded
 * by tone; center label = total; side legend lists each category with
 * absolute count + share %. Caller passes the slice list so per-project
 * (3 types) and global (5 types) views share the same component without
 * dragging irrelevant zero-rows into each other's legend.
 *
 * Empty state: when every count is zero we render a neutral placeholder
 * ring + helper copy instead of an unreadable Pie with no data — Recharts
 * draws a single 0%-slice that looks broken otherwise.
 */
function RadarInsightsDonut({
  slices,
  t,
}: {
  slices: DonutSlice[];
  t: Translator;
}) {
  const total = slices.reduce((acc, s) => acc + s.value, 0);

  if (total === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 py-6 text-center text-[12px] text-[var(--text-dim)]">
        <div
          aria-hidden="true"
          className="h-24 w-24 rounded-full border-[10px] border-[var(--border)]"
        />
        <span>{t('radar.global.donutEmpty')}</span>
      </div>
    );
  }

  // Recharts ignores zero-value slices but emits warnings — strip them.
  const data = slices.filter((s) => s.value > 0);

  return (
    <div className="flex flex-row items-center gap-3 sm:items-stretch">
      {/* Compact donut on mobile (28×28 ≈ 112 px), grows on sm+. The
          legend sits to its right at every viewport — earlier full-width
          stack on mobile pushed the chart to take half the screen. */}
      <div className="relative h-28 w-28 shrink-0 sm:h-44 sm:w-44">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={data}
              dataKey="value"
              nameKey="label"
              innerRadius="62%"
              outerRadius="92%"
              paddingAngle={1.5}
              stroke="rgba(11,13,17,0.85)"
              strokeWidth={1.5}
              isAnimationActive={false}
            >
              {data.map((d) => (
                <Cell key={d.key} fill={d.color} />
              ))}
            </Pie>
            <Tooltip
              cursor={false}
              wrapperStyle={{ outline: 'none' }}
              contentStyle={{
                backgroundColor: '#0b0d11',
                border: '1px solid rgba(255,255,255,0.1)',
                borderRadius: 10,
                color: '#f5f5f7',
                fontSize: 12,
                padding: '6px 10px',
              }}
              formatter={(value, _name, item) => {
                const n = Number(value ?? 0);
                const share = total > 0 ? Math.round((n / total) * 100) : 0;
                const label = String(
                  (item as { payload?: { label?: string } } | undefined)?.payload?.label ?? '—',
                );
                return [`${n} · ${share}%`, label];
              }}
            />
          </PieChart>
        </ResponsiveContainer>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span className="num text-[18px] font-semibold leading-none text-[var(--text)] sm:text-[26px]">
            {total}
          </span>
          <span className="mt-0.5 text-[9px] uppercase tracking-[0.08em] text-[var(--text-dim)] sm:mt-1 sm:text-[10.5px]">
            {t('radar.global.donutCenter')}
          </span>
        </div>
      </div>

      {/* Legend with counts + shares. min-w-0 + truncate handles long
          labels on narrow screens; zero-count rows dimmed so the legend
          matches what the donut actually draws. */}
      <ul className="grid min-w-0 flex-1 grid-cols-1 gap-0.5 text-[11.5px] sm:gap-1 sm:text-[12px] lg:grid-cols-1">
        {slices.map((s) => {
          const share = total > 0 ? Math.round((s.value / total) * 100) : 0;
          const dim = s.value === 0;
          return (
            <li
              key={s.key}
              className={`flex items-center justify-between gap-2 rounded-[var(--radius-sm)] px-1.5 py-0.5 sm:px-2 sm:py-1 ${dim ? 'opacity-50' : ''}`}
            >
              <span className="flex min-w-0 items-center gap-1.5 sm:gap-2">
                <span
                  aria-hidden="true"
                  className="h-2 w-2 shrink-0 rounded-full"
                  style={{ backgroundColor: s.color }}
                />
                <span className="truncate text-[var(--text-dim)]">{s.label}</span>
              </span>
              <span className="flex shrink-0 items-baseline gap-1.5">
                <span className="num font-medium text-[var(--text)]">{s.value}</span>
                <span className="text-[10.5px] text-[var(--text-faint)]">{share}%</span>
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function FeaturesMatrix({ competitors, t }: { competitors: Competitor[]; t: Translator }) {
  const featureSetsByCompetitor = competitors.map((c) => {
    const list = parseList(c.features_json)
      .map((f) => f.trim())
      .filter(Boolean);
    const set = new Set(list.map((f) => f.toLowerCase()));
    const displayByKey = new Map<string, string>();
    for (const f of list) displayByKey.set(f.toLowerCase(), f);
    return { id: c.id, name: c.name, set, displayByKey };
  });

  const featureAgg = new Map<string, { display: string; count: number }>();
  for (const entry of featureSetsByCompetitor) {
    for (const key of entry.set) {
      const existing = featureAgg.get(key);
      const display = entry.displayByKey.get(key) || key;
      if (existing) existing.count += 1;
      else featureAgg.set(key, { display, count: 1 });
    }
  }

  const sortedFeatures = [...featureAgg.entries()].sort((a, b) => {
    if (b[1].count !== a[1].count) return b[1].count - a[1].count;
    return a[1].display.localeCompare(b[1].display);
  });

  if (sortedFeatures.length === 0) {
    return <Empty>{t('radar.matrix.empty')}</Empty>;
  }

  return (
    <div className="overflow-x-auto rounded-[var(--radius-sm)] border border-[var(--border)]">
      <table className="w-full border-collapse text-[12px]">
        <thead>
          <tr className="bg-[var(--surface-2)] text-[var(--text-mute)]">
            <th className="sticky left-0 z-10 bg-[var(--surface-2)] px-2 py-1.5 text-left font-medium">
              {t('radar.matrix.feature')}
            </th>
            <th className="px-2 py-1.5 text-center font-medium" title={t('radar.matrix.coverage')}>
              #
            </th>
            {competitors.map((c) => (
              <th key={c.id} className="px-2 py-1.5 text-left font-medium" title={c.name}>
                <span className="inline-block max-w-[120px] truncate align-bottom">{c.name}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sortedFeatures.map(([key, { display, count }]) => (
            <tr key={key} className="border-t border-[var(--border)]">
              <td className="sticky left-0 z-10 bg-[var(--surface-1)] px-2 py-1.5 text-[var(--text)]">
                {display}
              </td>
              <td className="px-2 py-1.5 text-center num text-[var(--text-dim)]">{count}</td>
              {featureSetsByCompetitor.map((entry) => (
                <td key={entry.id} className="px-2 py-1.5 text-center">
                  {entry.set.has(key) ? (
                    <span className="text-[#30d158]">✓</span>
                  ) : (
                    <span className="text-[var(--text-faint)]">·</span>
                  )}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CompetitorCard({
  competitor,
  onDelete,
  t,
}: {
  competitor: Competitor;
  onDelete: () => void;
  t: Translator;
}) {
  const strengths = parseList(competitor.strengths_json);
  const weaknesses = parseList(competitor.weaknesses_json);
  const features = parseList(competitor.features_json);
  const domain = competitor.url
    ? competitor.url.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '')
    : null;

  // The `group` class on the outer Card lets us scope hover-reveal of
  // the delete button: idle = invisible (no UI noise on a list of 20+
  // cards), hover/focus-within = visible. Touch users still get it via
  // focus-within once they tap any field. Always reachable by keyboard.
  return (
    <Card className="group !p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 flex-col gap-0.5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[13px] font-semibold text-[var(--text)]">{competitor.name}</span>
            <Chip tone={competitor.source === 'agent' ? 'accent' : 'neutral'}>
              {competitor.source}
            </Chip>
            <span
              className="text-[10px] text-[var(--text-faint)]"
              title={t('radar.competitors.lastSeenTitle', {
                date: new Date(competitor.last_seen * 1000).toLocaleString(),
              })}
            >
              {relativeTime(competitor.last_seen)}
            </span>
          </div>
          {competitor.url ? (
            <a
              href={competitor.url}
              target="_blank"
              rel="noreferrer noopener"
              className="truncate text-[11px] text-[var(--accent)] hover:underline"
              title={competitor.url}
            >
              {domain} ↗
            </a>
          ) : null}
          {competitor.pitch ? (
            <p className="mt-0.5 text-[12px] leading-relaxed text-[var(--text-dim)]">
              {competitor.pitch}
            </p>
          ) : null}
        </div>
        <button
          type="button"
          onClick={onDelete}
          className="-mr-1 -mt-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-[var(--radius-sm)] text-[15px] leading-none text-[var(--text-faint)] opacity-0 transition-opacity hover:bg-[rgba(255,69,58,0.12)] hover:text-[var(--danger)] focus-visible:opacity-100 group-hover:opacity-100"
          aria-label={t('radar.competitors.deleteLabel', { name: competitor.name })}
          title={t('radar.competitors.deleteTitle')}
        >
          ×
        </button>
      </div>

      {features.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-1">
          {features.map((f) => (
            <Chip key={f} tone="neutral">
              {f}
            </Chip>
          ))}
        </div>
      ) : null}

      {strengths.length > 0 || weaknesses.length > 0 ? (
        <div className="mt-2 grid grid-cols-1 gap-1.5 text-[11px] md:grid-cols-2">
          {strengths.length > 0 ? <BulletList tone="success" label="+" items={strengths} /> : null}
          {weaknesses.length > 0 ? <BulletList tone="warn" label="−" items={weaknesses} /> : null}
        </div>
      ) : null}
    </Card>
  );
}

function BulletList({
  tone,
  label,
  items,
}: {
  tone: 'success' | 'warn';
  label: string;
  items: string[];
}) {
  const dotColor = tone === 'success' ? 'text-[#30d158]' : 'text-[#ffd60a]';
  return (
    <ul className="flex flex-col gap-0.5">
      {items.map((it) => (
        <li key={it} className="flex items-start gap-1.5">
          <span className={`${dotColor} shrink-0 font-semibold`} aria-hidden="true">
            {label}
          </span>
          <span className="text-[var(--text-mute)]">{it}</span>
        </li>
      ))}
    </ul>
  );
}

function InsightCard({
  insight,
  projects,
  showProject,
  filter,
  onExplored,
  onDismissed,
  onRestore,
  onPromoted,
  t,
}: {
  insight: Insight;
  projects: ProjectSummary[];
  showProject: boolean;
  filter: InsightsFilter;
  onExplored: () => void;
  onDismissed: () => void;
  onRestore: () => void;
  onPromoted: (path: string) => void;
  t: Translator;
}) {
  const meta = INSIGHT_LABEL[insight.type] || { label: insight.type, tone: 'neutral' as const };
  const notes = parseList(insight.related_notes_json);
  const comps = parseMetaCompetitors(insight.meta_json);
  const projectIds = parseList(insight.related_projects_json);
  const project = projectIds[0] ? projects.find((p) => p.id === projectIds[0]) : null;
  const [promoting, setPromoting] = useState(false);

  async function handlePromote() {
    setPromoting(true);
    try {
      const res = await apiPost<{ ok: boolean; path: string }>(
        `/api/insights/${insight.id}/promote`,
        {},
      );
      if (res.ok) onPromoted(res.path);
    } catch {
      /* swallow */
    } finally {
      setPromoting(false);
    }
  }

  return (
    <Card className="!p-3">
      <header className="mb-2 flex flex-wrap items-center gap-2 text-[11px]">
        <Chip tone={meta.tone}>{meta.label}</Chip>
        {showProject && project ? (
          <Link
            to={`/radar?projectId=${project.id}`}
            className="text-[var(--accent)] hover:underline"
          >
            {project.name}
          </Link>
        ) : null}
        <span className="ml-auto text-[10px] text-[var(--text-faint)]">
          {relativeTime(insight.created_at)}
        </span>
      </header>

      <h3 className="text-[13px] font-semibold leading-snug text-[var(--text)]">{insight.title}</h3>

      {insight.body ? (
        <p className="mt-1 text-[12px] leading-relaxed text-[var(--text-mute)]">{insight.body}</p>
      ) : null}

      {notes.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-1 text-[11px]">
          {notes.map((n) => (
            <Chip key={n} tone="neutral" title={n}>
              [[{n}]]
            </Chip>
          ))}
        </div>
      ) : null}

      {comps.length > 0 ? (
        <div className="mt-1 text-[11px] text-[var(--text-dim)]">
          {t('radar.insights.vs', { names: comps.join(' · ') })}
        </div>
      ) : null}

      <footer className="mt-3 flex flex-wrap items-center justify-end gap-1.5 border-t border-[var(--border)] pt-2">
        {filter === 'pending' ? (
          <>
            {/* Promote = primary action: writes Concepts/radar/<slug>.md
                in the vault (irreversible-feeling). Mark explored / dismiss
                are secondary triage actions on the same row but visually
                quieter so the eye lands on Promote first. */}
            <Button
              tone="ghost"
              onClick={onDismissed}
              className="!py-1 !text-[11px] !text-[var(--text-dim)] hover:!text-[#ff453a]"
              title={t('radar.insights.markDismissed')}
            >
              {t('radar.insights.markDismissed')}
            </Button>
            <Button tone="ghost" onClick={onExplored} className="!py-1 !text-[11px]">
              {t('radar.insights.markExplored')}
            </Button>
            <Button
              tone="primary"
              onClick={() => void handlePromote()}
              disabled={promoting}
              className="!py-1 !text-[11px]"
              title={t('radar.insights.promoteTitle')}
            >
              {promoting ? t('radar.insights.promoteBusy') : t('radar.insights.promote')}
            </Button>
          </>
        ) : (
          <Button tone="ghost" onClick={onRestore} className="!py-1 !text-[11px]">
            {t('radar.insights.restore')}
          </Button>
        )}
      </footer>
    </Card>
  );
}
