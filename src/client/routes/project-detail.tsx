import { marked } from 'marked';
import { useEffect, useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { Heatmap } from '../components/Heatmap';
import { Button, Card, Chip, Empty, ErrorBanner, Section, Stat } from '../components/ui';
import { apiGet, apiPost, getApiAuthHeader } from '../lib/api';
import { type Locale, dateLocale, numberLocale, useTranslation } from '../lib/i18n';
import {
  type CostBreakdown,
  DEV_HOURLY_RATE_EUR,
  type DevEffortEstimate,
  USD_TO_EUR,
  computeCost,
  estimateDevEffort,
  formatEur,
  formatEurPerMillion,
  formatHours,
} from '../lib/pricing';

marked.setOptions({ gfm: true, breaks: false });

type ProjectDetail = {
  id: string;
  name: string;
  path: string;
  type: string;
  description: string | null;
  readme_path: string | null;
  health_score: number;
  last_modified: number;
  last_commit_at: number | null;
  git_branch: string | null;
  git_remote: string | null;
  uncommitted: number;
  loc: number | null;
  languages_json: string | null;
};

type ProjectUsage = {
  projectKey: string;
  projectPath: string | null;
  projectId: string | null;
  projectName: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheCreate: number;
  cacheRead: number;
  totalTokens: number;
  assistantMessages: number;
  userMessages: number;
  messageCount: number;
  sessions: number;
  avgOutputTokens: number;
  cacheReuseRatio: number;
  lastTs: number | null;
  accruedEur?: number;
  firstSeenTs?: number | null;
  lastSeenTs?: number | null;
  activeDays?: number;
  models: Array<{ model: string; messages: number; tokens: number }>;
  tools: Array<{ name: string; count: number }>;
};

type ProjectUsageResponse = {
  rows: ProjectUsage[];
};

type DailyUsageRow = {
  date: string;
  source: 'claude' | 'codex';
  inputTokens: number;
  outputTokens: number;
  cacheCreate: number;
  cacheRead: number;
  totalTokens: number;
  messages: number;
  sessions: number;
  costUsd: number;
};

type DailyUsageResponse = { rows: DailyUsageRow[] };

export default function ProjectDetailRoute() {
  const { t, locale } = useTranslation();
  const { id } = useParams();
  const [project, setProject] = useState<ProjectDetail | null>(null);
  const [readme, setReadme] = useState<string>('');
  const [usage, setUsage] = useState<ProjectUsage | null>(null);
  const [dailyUsage, setDailyUsage] = useState<DailyUsageRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  async function load(projectId: string) {
    try {
      setError(null);
      const detail = await apiGet<ProjectDetail>(`/api/projects/${projectId}`);
      setProject(detail);

      try {
        const authHeader = await getApiAuthHeader();
        const res = await fetch(`/api/projects/${projectId}/readme`, {
          headers: authHeader,
          credentials: 'same-origin',
        });
        setReadme(res.ok ? await res.text() : '');
      } catch {
        setReadme('');
      }

      try {
        const from = new Date();
        from.setUTCDate(from.getUTCDate() - 365);
        const fromIso = from.toISOString().slice(0, 10);
        const usageData = await apiGet<ProjectUsageResponse>(
          `/api/usage/by-project?projectId=${encodeURIComponent(projectId)}&from=${fromIso}&limit=1`,
        );
        setUsage(usageData.rows?.[0] || null);

        const dailyData = await apiGet<DailyUsageResponse>(
          `/api/usage/by-project/daily?projectId=${encodeURIComponent(projectId)}&from=${fromIso}`,
        );
        setDailyUsage(dailyData.rows || []);
      } catch {
        setUsage(null);
        setDailyUsage([]);
      }
    } catch (e) {
      setError(String(e));
    }
  }

  useEffect(() => {
    if (id) {
      void load(id);
    }
  }, [id]);

  async function rescan() {
    if (!id) {
      return;
    }
    await apiPost(`/api/projects/rescan/${id}`);
    await load(id);
  }

  const cost = useMemo<CostBreakdown | null>(() => {
    if (!usage) {
      return null;
    }
    const claudeShareTokens = usage.models
      .filter((m) => !/gpt|o3|o4/i.test(m.model))
      .reduce((a, m) => a + m.tokens, 0);
    const codexShareTokens =
      usage.models.length > 0
        ? usage.models.reduce((a, m) => a + m.tokens, 0) - claudeShareTokens
        : 0;
    return computeCost({
      models: usage.models.map((m) => ({
        model: m.model,
        tokens: m.tokens,
        source: /gpt|o3|o4/i.test(m.model) ? 'codex' : 'claude',
      })),
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheRead,
      cacheWriteTokens: usage.cacheCreate,
      defaultSource: codexShareTokens > claudeShareTokens ? 'codex' : 'claude',
    });
  }, [usage]);

  const effort = useMemo<DevEffortEstimate | null>(() => {
    if (!usage) {
      return null;
    }
    return estimateDevEffort(
      {
        outputTokens: usage.outputTokens,
        messages: usage.messageCount,
        sessions: usage.sessions,
        activeDays: usage.activeDays ?? 0,
      },
      { hourlyRateEur: DEV_HOURLY_RATE_EUR },
    );
  }, [usage]);

  const heatmapDays = useMemo(() => {
    const year = new Date().getUTCFullYear();
    const cursor = new Date(Date.UTC(year, 0, 1));
    const end = new Date(Date.UTC(year, 11, 31));
    const byDate = new Map<string, number>();
    for (const row of dailyUsage) {
      byDate.set(row.date, (byDate.get(row.date) || 0) + row.totalTokens);
    }
    const days: { date: string; count: number; color: null }[] = [];
    while (cursor <= end) {
      const iso = cursor.toISOString().slice(0, 10);
      days.push({ date: iso, count: byDate.get(iso) || 0, color: null });
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    return days;
  }, [dailyUsage]);

  if (!id) {
    return (
      <Section title={t('projects.detail.invalid')}>
        <Empty>{t('projects.detail.noId')}</Empty>
      </Section>
    );
  }

  if (error) {
    return (
      <Section title={t('projects.detail.project')}>
        <ErrorBanner>{error}</ErrorBanner>
      </Section>
    );
  }

  if (!project) {
    return (
      <Section title={t('projects.detail.project')} meta={t('projects.detail.loading')}>
        <Empty>—</Empty>
      </Section>
    );
  }

  const languages = safeParseJson(project.languages_json);
  const hasUsage = usage && usage.totalTokens > 0;
  const realEur = usage?.accruedEur ?? 0;
  const devEur = effort?.midEur ?? 0;
  const paygEur = cost?.totalEur ?? 0;
  const savingsEur = paygEur - realEur;
  const leverageAbo = realEur > 0.001 ? paygEur / realEur : 0;
  const leverageDev = realEur > 0.001 ? devEur / realEur : 0;
  const cachePct = Math.round((usage?.cacheReuseRatio || 0) * 100);

  const languageEntries = Object.entries((languages as Record<string, number>) || {}).sort(
    ([, a], [, b]) => b - a,
  );
  const topLangs = languageEntries.slice(0, 3).map(([ext]) => ext);
  const gitRemoteShort = project.git_remote
    ? project.git_remote
        .replace(/^(https?:\/\/|git@)/, '')
        .replace(/\.git$/, '')
        .replace(':', '/')
    : null;

  return (
    <ProjectDetailLayout
      project={project}
      usage={usage}
      cost={cost}
      effort={effort}
      hasUsage={!!hasUsage}
      realEur={realEur}
      devEur={devEur}
      paygEur={paygEur}
      savingsEur={savingsEur}
      leverageAbo={leverageAbo}
      leverageDev={leverageDev}
      cachePct={cachePct}
      heatmapDays={heatmapDays}
      readme={readme}
      languageEntries={languageEntries}
      topLangs={topLangs}
      gitRemoteShort={gitRemoteShort}
      locale={locale}
      t={t}
      onRescan={() => void rescan()}
    />
  );
}

// ═════════════════════ Layout orchestrator ═════════════════════

type PanelTab = 'overview' | 'costs' | 'activity' | 'knowledge' | 'readme';

const TAB_DEFS: Array<{ id: PanelTab; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'costs', label: 'Coûts' },
  { id: 'activity', label: 'Activité' },
  { id: 'knowledge', label: 'Knowledge' },
  { id: 'readme', label: 'README' },
];

function ProjectDetailLayout(props: {
  project: ProjectDetail;
  usage: ProjectUsage | null;
  cost: CostBreakdown | null;
  effort: DevEffortEstimate | null;
  hasUsage: boolean;
  realEur: number;
  devEur: number;
  paygEur: number;
  savingsEur: number;
  leverageAbo: number;
  leverageDev: number;
  cachePct: number;
  heatmapDays: Array<{ date: string; count: number; color: null }>;
  readme: string;
  languageEntries: Array<[string, number]>;
  topLangs: string[];
  gitRemoteShort: string | null;
  locale: Locale;
  t: TFunc;
  onRescan: () => void;
}) {
  const { project, usage, cost, effort, hasUsage, t } = props;
  const [params, setParams] = useSearchParams();
  const activeTab: PanelTab = (params.get('tab') as PanelTab) || 'overview';

  function setTab(next: PanelTab) {
    const p = new URLSearchParams(params);
    p.set('tab', next);
    setParams(p, { replace: true });
  }

  return (
    <div className="flex flex-col gap-4">
      <HeroBar
        project={project}
        hasUsage={hasUsage}
        usage={usage}
        topLangs={props.topLangs}
        gitRemoteShort={props.gitRemoteShort}
        locale={props.locale}
        t={t}
        onRescan={props.onRescan}
      />

      <nav
        aria-label="Project tabs"
        className="no-scrollbar flex overflow-x-auto rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface-1)] p-0.5"
      >
        {TAB_DEFS.map((tab) => {
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => setTab(tab.id)}
              aria-current={isActive ? 'page' : undefined}
              className={`whitespace-nowrap rounded-[var(--radius)] px-3 py-1.5 text-[12.5px] font-medium transition ${
                isActive
                  ? 'bg-[var(--surface-2)] text-[var(--text)]'
                  : 'text-[var(--text-dim)] hover:text-[var(--text)]'
              }`}
            >
              {tab.label}
            </button>
          );
        })}
      </nav>

      {activeTab === 'overview' ? (
        <OverviewTab
          project={project}
          usage={usage}
          cost={cost}
          effort={effort}
          hasUsage={hasUsage}
          realEur={props.realEur}
          paygEur={props.paygEur}
          savingsEur={props.savingsEur}
          leverageAbo={props.leverageAbo}
          cachePct={props.cachePct}
          heatmapDays={props.heatmapDays}
          locale={props.locale}
          t={t}
        />
      ) : null}
      {activeTab === 'costs' ? (
        <CostsTab
          cost={cost}
          effort={effort}
          usage={usage}
          realEur={props.realEur}
          devEur={props.devEur}
          paygEur={props.paygEur}
          savingsEur={props.savingsEur}
          leverageAbo={props.leverageAbo}
          leverageDev={props.leverageDev}
          locale={props.locale}
          t={t}
        />
      ) : null}
      {activeTab === 'activity' ? (
        <ActivityTab
          usage={usage}
          hasUsage={hasUsage}
          realEur={props.realEur}
          heatmapDays={props.heatmapDays}
          locale={props.locale}
          t={t}
        />
      ) : null}
      {activeTab === 'knowledge' ? (
        <KnowledgeTab
          usage={usage}
          hasUsage={hasUsage}
          languageEntries={props.languageEntries}
          locale={props.locale}
          t={t}
        />
      ) : null}
      {activeTab === 'readme' ? (
        <Card>
          <ReadmeBody markdown={props.readme} />
        </Card>
      ) : null}
    </div>
  );
}

// ═════════════════════ Hero ═════════════════════

function avatarColor(name: string): string {
  const palette = ['#64d2ff', '#30d158', '#ffd60a', '#ff9500', '#bf5af2', '#ff2d95', '#5e5ce6'];
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return palette[h % palette.length];
}

function HeroBar({
  project,
  hasUsage,
  usage,
  topLangs,
  gitRemoteShort,
  locale,
  t,
  onRescan,
}: {
  project: ProjectDetail;
  hasUsage: boolean;
  usage: ProjectUsage | null;
  topLangs: string[];
  gitRemoteShort: string | null;
  locale: Locale;
  t: TFunc;
  onRescan: () => void;
}) {
  const color = avatarColor(project.name);
  const initial = project.name[0]?.toUpperCase() || '?';
  return (
    <div className="flex flex-wrap items-center gap-4 rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface-1)] px-4 py-3">
      <div
        aria-hidden="true"
        className="flex h-12 w-12 shrink-0 items-center justify-center rounded-[var(--radius)] text-[20px] font-semibold"
        style={{ backgroundColor: `${color}22`, color }}
      >
        {initial}
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="truncate text-[18px] font-semibold tracking-tight text-[var(--text)]">
            {project.name}
          </h1>
          <Chip tone="neutral">{project.type}</Chip>
          {project.git_branch ? (
            <span className="text-[11px] text-[var(--text-dim)]">
              <span aria-hidden="true">⎇</span> {project.git_branch}
            </span>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-[var(--text-dim)]">
          <span className="truncate font-mono" title={project.path}>
            {project.path}
          </span>
          {gitRemoteShort ? (
            <span className="truncate text-[var(--text-faint)]" title={project.git_remote || ''}>
              {gitRemoteShort}
            </span>
          ) : null}
          {project.last_commit_at ? (
            <span>last commit {relativeTime(project.last_commit_at, t)}</span>
          ) : null}
          {topLangs.length > 0 ? (
            <span className="text-[var(--text-faint)]">
              {topLangs.map((l) => `.${l}`).join(' ')}
            </span>
          ) : null}
        </div>
      </div>
      <HealthGauge score={project.health_score} />
      <div className="hidden flex-col gap-0.5 text-right md:flex">
        <span className="text-[10px] uppercase tracking-[0.08em] text-[var(--text-dim)]">
          {hasUsage && usage ? `${numberLabel(usage.sessions, locale)} sessions` : 'no usage'}
        </span>
        <span className="num text-[13px] font-medium tabular-nums text-[var(--text)]">
          {hasUsage && usage ? formatTokens(usage.totalTokens) : '—'} tok
        </span>
        {project.loc ? (
          <span className="text-[10px] text-[var(--text-faint)]">
            {numberLabel(project.loc, locale)} LoC
          </span>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Link to={`/agent?projectId=${project.id}`}>
          <Button tone="accent">{t('projects.detail.askAgent')}</Button>
        </Link>
        <Button tone="ghost" onClick={onRescan}>
          {t('projects.detail.rescan')}
        </Button>
      </div>
    </div>
  );
}

function HealthGauge({ score }: { score: number }) {
  const size = 56;
  const stroke = 5;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const pct = Math.max(0, Math.min(100, score)) / 100;
  const offset = circumference * (1 - pct);
  const color =
    score >= 60 ? '#30d158' : score >= 30 ? '#ffd60a' : score > 0 ? '#ff453a' : '#6e6e73';

  return (
    <div className="relative" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <title>Health score</title>
        <g transform={`rotate(-90 ${size / 2} ${size / 2})`}>
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            stroke="rgba(255,255,255,0.08)"
            strokeWidth={stroke}
          />
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            stroke={color}
            strokeWidth={stroke}
            strokeDasharray={circumference}
            strokeDashoffset={offset}
            strokeLinecap="round"
          />
        </g>
      </svg>
      <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center leading-tight">
        <span className="num text-[15px] font-semibold tabular-nums" style={{ color }}>
          {score}
        </span>
        <span className="text-[8.5px] uppercase tracking-[0.12em] text-[var(--text-faint)]">
          health
        </span>
      </div>
    </div>
  );
}

// ═════════════════════ Tab panels ═════════════════════

function OverviewTab({
  project,
  usage,
  cost,
  effort,
  hasUsage,
  realEur,
  savingsEur,
  leverageAbo,
  cachePct,
  heatmapDays,
  locale,
  t,
}: {
  project: ProjectDetail;
  usage: ProjectUsage | null;
  cost: CostBreakdown | null;
  effort: DevEffortEstimate | null;
  hasUsage: boolean;
  realEur: number;
  paygEur: number;
  savingsEur: number;
  leverageAbo: number;
  cachePct: number;
  heatmapDays: Array<{ date: string; count: number; color: null }>;
  locale: Locale;
  t: TFunc;
}) {
  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat
          label="Coût abo"
          value={hasUsage ? formatEur(realEur, locale) : '—'}
          hint={hasUsage ? t('projects.detail.costs.realAboHint') : undefined}
        />
        <Stat
          label="Économies vs PAYG"
          value={
            hasUsage
              ? savingsEur >= 0
                ? formatEur(savingsEur, locale)
                : `-${formatEur(Math.abs(savingsEur), locale)}`
              : '—'
          }
          tone={hasUsage && savingsEur >= 0 ? 'success' : hasUsage ? 'danger' : undefined}
          hint={leverageAbo > 0 ? `leverage ×${leverageAbo.toFixed(1)}` : undefined}
        />
        <Stat
          label="Dev équiv."
          value={effort ? formatEur(effort.midEur, locale) : '—'}
          tone={effort ? 'success' : undefined}
          hint={effort ? formatHours(effort.midHours, locale) : undefined}
        />
        <Stat
          label="Cache hit"
          value={hasUsage ? `${cachePct}%` : '—'}
          hint={hasUsage && cost ? `${formatTokens(usage?.cacheRead || 0)} read` : undefined}
        />
      </div>

      {hasUsage ? (
        <Card>
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[11px] uppercase tracking-[0.08em] text-[var(--text-dim)]">
              Heatmap annuelle
            </span>
            <span className="text-[11px] text-[var(--text-faint)]">
              {formatTokens(usage?.totalTokens || 0)} tokens ·{' '}
              {numberLabel(usage?.activeDays || 0, locale)} jours actifs
            </span>
          </div>
          <Heatmap days={heatmapDays} palette="cyan" totalLabel="tokens" />
        </Card>
      ) : null}

      <RadarSummary projectId={project.id} />

      {!hasUsage ? (
        <Card>
          <Empty>
            Aucun usage LLM enregistré pour ce projet. Lance une session dans l'agent (bouton
            ci-dessus) pour commencer à tracker.
          </Empty>
        </Card>
      ) : null}
    </div>
  );
}

function CostsTab({
  cost,
  effort,
  usage,
  realEur,
  devEur,
  paygEur,
  savingsEur,
  leverageAbo,
  leverageDev,
  locale,
  t,
}: {
  cost: CostBreakdown | null;
  effort: DevEffortEstimate | null;
  usage: ProjectUsage | null;
  realEur: number;
  devEur: number;
  paygEur: number;
  savingsEur: number;
  leverageAbo: number;
  leverageDev: number;
  locale: Locale;
  t: TFunc;
}) {
  if (!usage) {
    return (
      <Card>
        <Empty>Pas de données de coût disponibles pour ce projet.</Empty>
      </Card>
    );
  }
  return (
    <div className="grid grid-cols-1 gap-3 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <CostsPanel
        realEur={realEur}
        devEur={devEur}
        paygEur={paygEur}
        savingsEur={savingsEur}
        leverageAbo={leverageAbo}
        leverageDev={leverageDev}
        effort={effort}
        costPerM={cost?.costPerMillionTokensEur ?? null}
        locale={locale}
        t={t}
      />
      <div className="flex flex-col gap-3">
        {effort ? <EstimationPanel effort={effort} usage={usage} locale={locale} t={t} /> : null}
        {cost ? (
          <Card className="!p-3">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-[11px] uppercase tracking-[0.08em] text-[var(--text-dim)]">
                {t('projects.detail.breakdown.title')}
              </span>
              <span
                className="text-[10px] text-[var(--text-faint)]"
                title={t('projects.detail.breakdown.meta', {
                  input: formatEurPerMillion(cost.blendedInputPer1M * USD_TO_EUR, locale),
                  output: formatEurPerMillion(cost.blendedOutputPer1M * USD_TO_EUR, locale),
                })}
              >
                €/M · blended
              </span>
            </div>
            <TokenBreakdown
              inputTokens={usage.inputTokens}
              outputTokens={usage.outputTokens}
              cacheRead={usage.cacheRead}
              cacheCreate={usage.cacheCreate}
              inputEur={cost.inputEur}
              outputEur={cost.outputEur}
              cacheReadEur={cost.cacheReadEur}
              cacheWriteEur={cost.cacheWriteEur}
              locale={locale}
              t={t}
            />
          </Card>
        ) : null}
      </div>
    </div>
  );
}

function ActivityTab({
  usage,
  hasUsage,
  realEur,
  heatmapDays,
  locale,
  t,
}: {
  usage: ProjectUsage | null;
  hasUsage: boolean;
  realEur: number;
  heatmapDays: Array<{ date: string; count: number; color: null }>;
  locale: Locale;
  t: TFunc;
}) {
  if (!hasUsage || !usage) {
    return (
      <Card>
        <Empty>Aucune activité enregistrée.</Empty>
      </Card>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      <Card>
        <div className="mb-2 flex items-center justify-between">
          <span className="text-[11px] uppercase tracking-[0.08em] text-[var(--text-dim)]">
            {t('projects.detail.heatmap.title')}
          </span>
          <span className="text-[11px] text-[var(--text-faint)]">
            {formatTokens(usage.totalTokens)} tokens
          </span>
        </div>
        <Heatmap days={heatmapDays} palette="cyan" totalLabel="tokens" />
      </Card>
      <ActivityPanel usage={usage} realEur={realEur} locale={locale} t={t} />
    </div>
  );
}

function KnowledgeTab({
  usage,
  hasUsage,
  languageEntries,
  locale,
  t,
}: {
  usage: ProjectUsage | null;
  hasUsage: boolean;
  languageEntries: Array<[string, number]>;
  locale: Locale;
  t: TFunc;
}) {
  if (!hasUsage && languageEntries.length === 0) {
    return (
      <Card>
        <Empty>Rien à afficher ici. Scanne le projet ou lance des sessions LLM.</Empty>
      </Card>
    );
  }
  return (
    <div className="grid grid-cols-1 gap-3 xl:grid-cols-3">
      {hasUsage && usage ? (
        <ChipsPanel
          title={t('projects.detail.modelsTools.models')}
          emptyLabel={t('projects.detail.modelsTools.noModels')}
          items={usage.models.slice(0, 12).map((m) => ({
            key: m.model,
            label: m.model,
            right: formatTokens(m.tokens),
            tone: /gpt|o3|o4/i.test(m.model) ? 'warn' : 'accent',
            title: t('projects.detail.modelsTools.modelTooltip', {
              tokens: numberLabel(m.tokens, locale),
              messages: numberLabel(m.messages, locale),
            }),
          }))}
        />
      ) : null}
      {hasUsage && usage ? (
        <ChipsPanel
          title={t('projects.detail.modelsTools.tools')}
          emptyLabel={t('projects.detail.modelsTools.noTools')}
          items={usage.tools.slice(0, 16).map((tool) => ({
            key: tool.name,
            label: tool.name,
            right: numberLabel(tool.count, locale),
            tone: 'neutral',
            title: t('projects.detail.modelsTools.toolTooltip', {
              count: numberLabel(tool.count, locale),
            }),
          }))}
        />
      ) : null}
      {languageEntries.length > 0 ? (
        <ChipsPanel
          title={t('projects.detail.languages.title')}
          emptyLabel="—"
          items={languageEntries.slice(0, 20).map(([ext, lines]) => ({
            key: ext,
            label: `.${ext}`,
            right: numberLabel(lines, locale),
            tone: 'neutral',
          }))}
        />
      ) : null}
    </div>
  );
}

function RadarSummary({ projectId }: { projectId: string }) {
  const [competitorsCount, setCompetitorsCount] = useState<number | null>(null);
  const [insightsCount, setInsightsCount] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const [comp, ins] = await Promise.all([
          apiGet<Array<unknown>>(`/api/projects/${projectId}/competitors`),
          apiGet<Array<unknown>>(`/api/insights?projectId=${projectId}&status=pending`),
        ]);
        if (cancelled) return;
        setCompetitorsCount(comp.length);
        setInsightsCount(ins.length);
      } catch {
        if (!cancelled) {
          setCompetitorsCount(0);
          setInsightsCount(0);
        }
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  // Compact inline row — not a full Section — to avoid visual weight inflation.
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface-1)] px-3 py-2">
      <div className="flex flex-wrap items-center gap-3 text-[12.5px]">
        <span className="text-[11px] uppercase tracking-[0.08em] text-[var(--text-dim)]">
          Radar
        </span>
        <span>
          <span className="num text-[var(--text)]">{competitorsCount ?? '—'}</span>
          <span className="ml-1 text-[var(--text-dim)]">concurrents</span>
        </span>
        <span className="text-[var(--text-faint)]">·</span>
        <span>
          <span className="num text-[var(--text)]">{insightsCount ?? '—'}</span>
          <span className="ml-1 text-[var(--text-dim)]">insights pending</span>
        </span>
      </div>
      <Link
        to={`/radar?projectId=${projectId}`}
        className="text-[12px] text-[var(--accent)] hover:underline"
      >
        ouvrir →
      </Link>
    </div>
  );
}

// ─────────────────────── Panels ───────────────────────

type TFunc = (key: string, vars?: Record<string, string | number>) => string;

function CostsPanel({
  realEur,
  devEur,
  paygEur,
  savingsEur,
  leverageAbo,
  leverageDev,
  effort,
  costPerM,
  locale,
  t,
}: {
  realEur: number;
  devEur: number;
  paygEur: number;
  savingsEur: number;
  leverageAbo: number;
  leverageDev: number;
  effort: DevEffortEstimate | null;
  costPerM: number | null;
  locale: Locale;
  t: TFunc;
}) {
  const savingsColor = savingsEur >= 0 ? 'text-[#30d158]' : 'text-[#ff453a]';
  const savingsFormatted =
    savingsEur >= 0 ? formatEur(savingsEur, locale) : `-${formatEur(Math.abs(savingsEur), locale)}`;
  return (
    <Card className="!p-3">
      <div className="mb-2 text-[11px] uppercase tracking-[0.08em] text-[var(--text-dim)]">
        {t('projects.detail.costs.title')}
      </div>
      <div className="flex flex-col divide-y divide-[var(--border)]">
        <KpiRow
          label={t('projects.detail.costs.realAbo')}
          value={formatEur(realEur, locale)}
          hint={t('projects.detail.costs.realAboHint')}
        />
        <KpiRow
          label={t('projects.detail.costs.devEquiv')}
          value={formatEur(devEur, locale)}
          valueClass="text-[#30d158]"
          hint={
            effort
              ? t('projects.detail.costs.devEquivHintRange', {
                  low: formatEur(effort.lowEur, locale),
                  high: formatEur(effort.highEur, locale),
                })
              : ''
          }
        />
        <KpiRow
          label={t('projects.detail.costs.apiPayg')}
          value={formatEur(paygEur, locale)}
          valueClass="text-[#64d2ff]"
          hint={
            costPerM !== null
              ? t('projects.detail.costs.apiPaygHint', {
                  amount: formatEur(costPerM, locale),
                })
              : ''
          }
        />
        <KpiRow
          label={t('projects.detail.costs.savingsVsPayg')}
          value={savingsFormatted}
          valueClass={savingsColor}
          hint={
            leverageAbo > 0
              ? t('projects.detail.costs.savingsHint', { n: leverageAbo.toFixed(1) })
              : '—'
          }
        />
        <KpiRow
          label={t('projects.detail.costs.leverageVsDev')}
          value={leverageDev > 0 ? `×${leverageDev.toFixed(1)}` : '—'}
          hint={t('projects.detail.costs.leverageVsDevHint')}
          valueClass="text-[var(--text-mute)]"
        />
      </div>
    </Card>
  );
}

function ActivityPanel({
  usage,
  realEur,
  locale,
  t,
}: {
  usage: ProjectUsage;
  realEur: number;
  locale: Locale;
  t: TFunc;
}) {
  const activeDays = usage.activeDays ?? 0;
  const tokensPerDay =
    activeDays > 0 ? formatTokens(Math.round(usage.totalTokens / activeDays)) : '—';
  const aboPerDay = activeDays > 0 ? formatEur(realEur / activeDays, locale) : '—';
  return (
    <Card className="!p-3">
      <div className="mb-2 text-[11px] uppercase tracking-[0.08em] text-[var(--text-dim)]">
        {t('projects.detail.activity.title')}
      </div>
      <div className="flex flex-col divide-y divide-[var(--border)]">
        <KpiRow
          label={t('projects.detail.activity.firstSeen')}
          value={fmtShortDate(usage.firstSeenTs, locale)}
          hint={usage.firstSeenTs ? relativeTime(usage.firstSeenTs, t) : '—'}
        />
        <KpiRow
          label={t('projects.detail.activity.lastSeen')}
          value={fmtShortDate(usage.lastSeenTs, locale)}
          hint={usage.lastSeenTs ? relativeTime(usage.lastSeenTs, t) : '—'}
        />
        <KpiRow
          label={t('projects.detail.activity.activeDays')}
          value={String(activeDays)}
          hint={t('projects.detail.activity.activeDaysHint')}
        />
        <KpiRow
          label={t('projects.detail.activity.tokensPerDay')}
          value={tokensPerDay}
          valueClass="text-[var(--text-mute)]"
          hint={t('projects.detail.activity.tokensPerDayHint')}
        />
        <KpiRow
          label={t('projects.detail.activity.aboPerActiveDay')}
          value={aboPerDay}
          valueClass="text-[var(--text-mute)]"
          hint={t('projects.detail.activity.aboPerActiveDayHint')}
        />
      </div>
    </Card>
  );
}

function EstimationPanel({
  effort,
  usage,
  locale,
  t,
}: {
  effort: DevEffortEstimate;
  usage: ProjectUsage;
  locale: Locale;
  t: TFunc;
}) {
  return (
    <Card className="!p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[11px] uppercase tracking-[0.08em] text-[var(--text-dim)]">
          {t('projects.detail.estimation.title')}
        </span>
        <span className="text-[10px] text-[var(--text-faint)]">
          {t('projects.detail.estimation.meta')}
        </span>
      </div>
      <div className="flex flex-col divide-y divide-[var(--border)]">
        <KpiRow
          label={t('projects.detail.estimation.volume')}
          value={formatEur(effort.tokenBased.eur, locale)}
          hint={`${formatHours(effort.tokenBased.hours, locale)} · ~${numberLabel(
            Math.round(effort.tokenBased.estimatedLoc),
            locale,
          )} LoC`}
        />
        <KpiRow
          label={t('projects.detail.estimation.intensity')}
          value={formatEur(effort.activityBased.eur, locale)}
          hint={`${formatHours(effort.activityBased.hours, locale)} · ${usage.sessions} sess · ${numberLabel(usage.messageCount, locale)} msg`}
        />
        <KpiRow
          label={t('projects.detail.estimation.calendar')}
          value={formatEur(effort.calendarBased.eur, locale)}
          hint={`${formatHours(effort.calendarBased.hours, locale)} · ${t(
            'projects.detail.estimation.calendarDays',
            { days: effort.calendarBased.activeDays },
          )}`}
        />
      </div>
    </Card>
  );
}

function KpiRow({
  label,
  value,
  hint,
  valueClass,
}: {
  label: string;
  value: string;
  hint?: string;
  valueClass?: string;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1.5">
      <span className="min-w-0 flex-1 text-[11.5px] text-[var(--text-dim)]">
        {label}
        {hint ? (
          <span className="ml-1.5 text-[10px] text-[var(--text-faint)]" title={hint}>
            · {hint.length > 40 ? `${hint.slice(0, 40)}…` : hint}
          </span>
        ) : null}
      </span>
      <span
        className={`num shrink-0 text-[13px] font-medium tabular-nums ${valueClass ?? 'text-[var(--text)]'}`}
      >
        {value}
      </span>
    </div>
  );
}

function TokenBreakdown({
  inputTokens,
  outputTokens,
  cacheRead,
  cacheCreate,
  inputEur,
  outputEur,
  cacheReadEur,
  cacheWriteEur,
  locale,
  t,
}: {
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheCreate: number;
  inputEur: number;
  outputEur: number;
  cacheReadEur: number;
  cacheWriteEur: number;
  locale: Locale;
  t: TFunc;
}) {
  const segments = [
    {
      key: 'output',
      label: t('projects.detail.breakdown.output'),
      tokens: outputTokens,
      eur: outputEur,
      color: '#64d2ff',
    },
    {
      key: 'input',
      label: t('projects.detail.breakdown.input'),
      tokens: inputTokens,
      eur: inputEur,
      color: 'var(--text-mute)',
    },
    {
      key: 'cacheRead',
      label: t('projects.detail.breakdown.cacheRead'),
      tokens: cacheRead,
      eur: cacheReadEur,
      color: '#30d158',
    },
    {
      key: 'cacheCreate',
      label: t('projects.detail.breakdown.cacheCreate'),
      tokens: cacheCreate,
      eur: cacheWriteEur,
      color: '#ffd60a',
    },
  ];
  const total = segments.reduce((a, s) => a + s.tokens, 0);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex h-2 overflow-hidden rounded-full bg-[var(--surface-2)]">
        {segments.map((s) => {
          const pct = total > 0 ? (s.tokens / total) * 100 : 0;
          if (pct === 0) return null;
          return (
            <div
              key={s.key}
              style={{ width: `${pct}%`, backgroundColor: s.color }}
              title={`${s.label}: ${formatTokens(s.tokens)} · ${formatEur(s.eur, locale)}`}
            />
          );
        })}
      </div>
      <div className="flex flex-col divide-y divide-[var(--border)]">
        {segments.map((s) => (
          <div key={s.key} className="flex items-baseline justify-between gap-2 py-1">
            <span className="flex items-center gap-1.5 text-[11.5px] text-[var(--text-dim)]">
              <span
                aria-hidden="true"
                className="h-1.5 w-1.5 rounded-full"
                style={{ backgroundColor: s.color }}
              />
              {s.label}
            </span>
            <span className="num text-[12px] tabular-nums">
              <span className="text-[var(--text-mute)]">{formatTokens(s.tokens)}</span>
              <span className="ml-2 text-[var(--text)]">{formatEur(s.eur, locale)}</span>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function ChipsPanel({
  title,
  emptyLabel,
  items,
}: {
  title: string;
  emptyLabel: string;
  items: Array<{
    key: string;
    label: string;
    right?: string;
    tone?: 'accent' | 'warn' | 'neutral';
    title?: string;
  }>;
}) {
  return (
    <Card className="!p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[11px] uppercase tracking-[0.08em] text-[var(--text-dim)]">
          {title}
        </span>
        <span className="text-[10px] text-[var(--text-faint)]">{items.length}</span>
      </div>
      {items.length === 0 ? (
        <span className="text-[12px] text-[var(--text-dim)]">{emptyLabel}</span>
      ) : (
        <div className="flex flex-wrap gap-1">
          {items.map((it) => (
            <Chip key={it.key} tone={it.tone} title={it.title}>
              <span className="font-medium">{it.label}</span>
              {it.right ? <span className="text-[var(--text-dim)]">{it.right}</span> : null}
            </Chip>
          ))}
        </div>
      )}
    </Card>
  );
}

function ReadmeBody({ markdown }: { markdown: string }) {
  const html = useMemo(() => {
    if (!markdown) {
      return '';
    }
    try {
      return marked.parse(markdown, { async: false }) as string;
    } catch {
      return '';
    }
  }, [markdown]);

  if (!markdown) {
    return <Empty>README non disponible.</Empty>;
  }

  if (!html) {
    return (
      <pre className="max-h-[420px] overflow-auto whitespace-pre-wrap text-[12.5px] leading-relaxed text-[var(--text)]">
        {markdown}
      </pre>
    );
  }

  return (
    <article
      className="prose-readme max-h-[520px] overflow-auto pr-2"
      // biome-ignore lint/security/noDangerouslySetInnerHtml: trusted local README content
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

function safeParseJson(value: string | null): unknown {
  if (!value) {
    return {};
  }
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function fmtDate(ts: number | null, locale: Locale = 'fr'): string {
  if (!ts) {
    return 'n/a';
  }
  return new Date(ts * 1000).toLocaleString(dateLocale(locale));
}

function fmtShortDate(ts: number | null | undefined, locale: Locale = 'fr'): string {
  if (!ts) {
    return '—';
  }
  return new Date(ts * 1000).toLocaleDateString(dateLocale(locale), {
    day: '2-digit',
    month: 'short',
    year: '2-digit',
  });
}

function relativeTime(
  ts: number,
  t: (key: string, vars?: Record<string, string | number>) => string,
): string {
  const diffSec = Math.max(0, Math.floor(Date.now() / 1000) - ts);
  const days = Math.floor(diffSec / 86400);
  if (days <= 0) {
    const hours = Math.floor(diffSec / 3600);
    return hours <= 0 ? t('common.today') : t('common.daysAgo', { n: 0 });
  }
  if (days === 1) {
    return t('common.yesterday');
  }
  if (days < 30) {
    return t('common.daysAgo', { n: days });
  }
  if (days < 365) {
    return t('common.monthsAgo', { n: Math.floor(days / 30) });
  }
  return t('common.yearsAgo', { n: Math.floor(days / 365) });
}

function numberLabel(value: number, locale: Locale = 'fr'): string {
  return Intl.NumberFormat(numberLocale(locale)).format(Math.round(value));
}

function formatTokens(value: number): string {
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  }
  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}K`;
  }
  return String(value);
}
