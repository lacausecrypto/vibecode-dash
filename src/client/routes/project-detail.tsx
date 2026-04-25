import { useEffect, useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { Heatmap } from '../components/Heatmap';
import { Markdown } from '../components/Markdown';
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

type ProjectDetail = {
  id: string;
  name: string;
  path: string;
  type: string;
  description: string | null;
  readme_path: string | null;
  health_score: number;
  health_breakdown_json: string | null;
  last_modified: number;
  last_commit_at: number | null;
  git_branch: string | null;
  git_remote: string | null;
  uncommitted: number;
  loc: number | null;
  languages_json: string | null;
};

type HealthFactor = {
  weight: number;
  value: number;
  label: string;
  reason: string;
};

type HealthBreakdown = {
  factors: Record<string, HealthFactor>;
  score: number;
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

// Shape returned by /api/usage/codex/by-project — semantically overlapping with
// ProjectUsage but with Codex-specific field names (turns vs messages,
// cachedInputTokens vs cacheRead, reasoningOutputTokens folded in).
type CodexProjectUsage = {
  projectKey: string;
  projectPath: string | null;
  projectId: string | null;
  projectName: string | null;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
  turns: number;
  sessions: number;
  costUsd: number;
  cacheHitRatio: number;
  lastTs: number | null;
  accruedEur?: number;
  firstSeenTs?: number | null;
  lastSeenTs?: number | null;
  activeDays?: number;
  models: Array<{ model: string; turns: number; tokens: number }>;
  tools: Array<{ name: string; count: number }>;
};

type CodexProjectUsageResponse = { rows: CodexProjectUsage[] };

// Normalize a Codex row into the Claude-shape ProjectUsage so downstream
// aggregations (sums, KPIs, cost breakdown) can operate on a single type.
// cachedInputTokens → cacheRead (same billing concept: input at cached rate).
// reasoningOutputTokens is folded into outputTokens (both are generated tokens).
// turns → messageCount / assistantMessages (assistant-side turns).
function codexToProjectUsage(row: CodexProjectUsage): ProjectUsage {
  const output = row.outputTokens + row.reasoningOutputTokens;
  const denom = row.inputTokens + row.cachedInputTokens;
  return {
    projectKey: row.projectKey,
    projectPath: row.projectPath,
    projectId: row.projectId,
    projectName: row.projectName,
    inputTokens: row.inputTokens,
    outputTokens: output,
    cacheCreate: 0,
    cacheRead: row.cachedInputTokens,
    totalTokens: row.totalTokens,
    assistantMessages: row.turns,
    userMessages: 0,
    messageCount: row.turns,
    sessions: row.sessions,
    avgOutputTokens: row.turns > 0 ? output / row.turns : 0,
    cacheReuseRatio: denom > 0 ? row.cachedInputTokens / denom : 0,
    lastTs: row.lastTs,
    accruedEur: row.accruedEur,
    firstSeenTs: row.firstSeenTs,
    lastSeenTs: row.lastSeenTs,
    activeDays: row.activeDays,
    models: row.models.map((m) => ({
      model: m.model,
      messages: m.turns,
      tokens: m.tokens,
    })),
    tools: row.tools,
  };
}

function mergeUsage(claude: ProjectUsage | null, codex: ProjectUsage | null): ProjectUsage | null {
  if (!claude && !codex) return null;
  if (!codex) return claude;
  if (!claude) return codex;

  const inputTokens = claude.inputTokens + codex.inputTokens;
  const outputTokens = claude.outputTokens + codex.outputTokens;
  const cacheCreate = claude.cacheCreate + codex.cacheCreate;
  const cacheRead = claude.cacheRead + codex.cacheRead;
  const totalTokens = claude.totalTokens + codex.totalTokens;
  const messageCount = claude.messageCount + codex.messageCount;
  const sessions = claude.sessions + codex.sessions;
  const denom = inputTokens + cacheRead;

  const modelMap = new Map<string, { model: string; tokens: number; messages: number }>();
  for (const src of [claude.models, codex.models]) {
    for (const m of src) {
      const cur = modelMap.get(m.model) || { model: m.model, tokens: 0, messages: 0 };
      cur.tokens += m.tokens;
      cur.messages += m.messages;
      modelMap.set(m.model, cur);
    }
  }
  const toolMap = new Map<string, number>();
  for (const src of [claude.tools, codex.tools]) {
    for (const tl of src) toolMap.set(tl.name, (toolMap.get(tl.name) || 0) + tl.count);
  }

  return {
    projectKey: claude.projectKey || codex.projectKey,
    projectPath: claude.projectPath ?? codex.projectPath,
    projectId: claude.projectId ?? codex.projectId,
    projectName: claude.projectName ?? codex.projectName,
    inputTokens,
    outputTokens,
    cacheCreate,
    cacheRead,
    totalTokens,
    assistantMessages: claude.assistantMessages + codex.assistantMessages,
    userMessages: claude.userMessages + codex.userMessages,
    messageCount,
    sessions,
    avgOutputTokens: messageCount > 0 ? outputTokens / messageCount : 0,
    cacheReuseRatio: denom > 0 ? cacheRead / denom : 0,
    lastTs: Math.max(claude.lastTs ?? 0, codex.lastTs ?? 0) || null,
    accruedEur: (claude.accruedEur ?? 0) + (codex.accruedEur ?? 0),
    firstSeenTs:
      claude.firstSeenTs && codex.firstSeenTs
        ? Math.min(claude.firstSeenTs, codex.firstSeenTs)
        : (claude.firstSeenTs ?? codex.firstSeenTs ?? null),
    lastSeenTs: Math.max(claude.lastSeenTs ?? 0, codex.lastSeenTs ?? 0) || null,
    activeDays: Math.max(claude.activeDays ?? 0, codex.activeDays ?? 0),
    models: [...modelMap.values()].sort((a, b) => b.tokens - a.tokens),
    tools: [...toolMap.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count),
  };
}

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
  const [claudeUsage, setClaudeUsage] = useState<ProjectUsage | null>(null);
  const [codexUsage, setCodexUsage] = useState<ProjectUsage | null>(null);
  const [dailyUsage, setDailyUsage] = useState<DailyUsageRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  const usage = useMemo(() => mergeUsage(claudeUsage, codexUsage), [claudeUsage, codexUsage]);

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
        // Fetch Claude + Codex in parallel and merge. A project may be
        // worked on exclusively via one CLI (common for heavy-Codex users);
        // loading only Claude would show empty KPIs while the heatmap
        // (summing both) shows activity — the bug we're fixing.
        const [claudeData, codexData, dailyData] = await Promise.all([
          apiGet<ProjectUsageResponse>(
            `/api/usage/by-project?projectId=${encodeURIComponent(projectId)}&from=${fromIso}&limit=1`,
          ).catch(() => ({ rows: [] as ProjectUsage[] })),
          apiGet<CodexProjectUsageResponse>(
            `/api/usage/codex/by-project?projectId=${encodeURIComponent(projectId)}&from=${fromIso}&limit=1`,
          ).catch(() => ({ rows: [] as CodexProjectUsage[] })),
          apiGet<DailyUsageResponse>(
            `/api/usage/by-project/daily?projectId=${encodeURIComponent(projectId)}&from=${fromIso}`,
          ).catch(() => ({ rows: [] as DailyUsageRow[] })),
        ]);

        setClaudeUsage(claudeData.rows?.[0] || null);
        setCodexUsage(codexData.rows?.[0] ? codexToProjectUsage(codexData.rows[0]) : null);
        setDailyUsage(dailyData.rows || []);
      } catch {
        setClaudeUsage(null);
        setCodexUsage(null);
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
    if (!claudeUsage && !codexUsage) return null;
    // Source is known from which endpoint the row came from — no regex
    // sniffing needed. Merge models with explicit source attribution.
    const models: Array<{ model: string; tokens: number; source: 'claude' | 'codex' }> = [];
    if (claudeUsage) {
      for (const m of claudeUsage.models) {
        models.push({ model: m.model, tokens: m.tokens, source: 'claude' });
      }
    }
    if (codexUsage) {
      for (const m of codexUsage.models) {
        models.push({ model: m.model, tokens: m.tokens, source: 'codex' });
      }
    }
    const claudeTokens = claudeUsage?.totalTokens ?? 0;
    const codexTokens = codexUsage?.totalTokens ?? 0;
    const totalIn = (claudeUsage?.inputTokens ?? 0) + (codexUsage?.inputTokens ?? 0);
    const totalOut = (claudeUsage?.outputTokens ?? 0) + (codexUsage?.outputTokens ?? 0);
    const totalCacheRead = (claudeUsage?.cacheRead ?? 0) + (codexUsage?.cacheRead ?? 0);
    const totalCacheWrite = (claudeUsage?.cacheCreate ?? 0) + (codexUsage?.cacheCreate ?? 0);
    return computeCost({
      models,
      inputTokens: totalIn,
      outputTokens: totalOut,
      cacheReadTokens: totalCacheRead,
      cacheWriteTokens: totalCacheWrite,
      defaultSource: codexTokens > claudeTokens ? 'codex' : 'claude',
    });
  }, [claudeUsage, codexUsage]);

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
      claudeUsage={claudeUsage}
      codexUsage={codexUsage}
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
      dailyUsage={dailyUsage}
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
  claudeUsage: ProjectUsage | null;
  codexUsage: ProjectUsage | null;
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
  dailyUsage: DailyUsageRow[];
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
          dailyUsage={props.dailyUsage}
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
          dailyUsage={props.dailyUsage}
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
          dailyUsage={props.dailyUsage}
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
          <ReadmeBody markdown={props.readme} projectId={project.id} />
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

  const scrollToBreakdown = () => {
    const el = document.getElementById('health-breakdown-anchor');
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  return (
    <button
      type="button"
      onClick={scrollToBreakdown}
      className="relative cursor-pointer rounded-full transition-transform hover:scale-105 focus:outline-none focus:ring-2 focus:ring-[var(--accent)]"
      style={{ width: size, height: size }}
      aria-label={`Voir le détail du health score (${score}/100)`}
      title="Cliquer pour voir le breakdown"
    >
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
    </button>
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
  dailyUsage,
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
  dailyUsage: DailyUsageRow[];
  locale: Locale;
  t: TFunc;
}) {
  // Derive 30-day sparklines from dailyUsage. We aggregate per-day across
  // sources (Claude + Codex) because the KPI already reflects the merged
  // totals. Cost estimates per day use the server-provided costUsd.
  const sparks = useMemo(() => {
    const now = new Date();
    const cutoff = new Date(now);
    cutoff.setUTCDate(cutoff.getUTCDate() - 29);
    const byDate = new Map<
      string,
      { tokens: number; messages: number; sessions: number; costUsd: number }
    >();
    for (const row of dailyUsage) {
      const prev = byDate.get(row.date) || {
        tokens: 0,
        messages: 0,
        sessions: 0,
        costUsd: 0,
      };
      prev.tokens += row.totalTokens;
      prev.messages += row.messages;
      prev.sessions += row.sessions;
      prev.costUsd += row.costUsd;
      byDate.set(row.date, prev);
    }
    const tokens: number[] = [];
    const messages: number[] = [];
    const sessions: number[] = [];
    const costUsd: number[] = [];
    const cursor = new Date(cutoff);
    while (cursor <= now) {
      const iso = cursor.toISOString().slice(0, 10);
      const d = byDate.get(iso) || { tokens: 0, messages: 0, sessions: 0, costUsd: 0 };
      tokens.push(d.tokens);
      messages.push(d.messages);
      sessions.push(d.sessions);
      costUsd.push(d.costUsd);
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    return { tokens, messages, sessions, costUsd };
  }, [dailyUsage]);

  const totalMessages = usage?.messageCount ?? 0;
  const totalSessions = usage?.sessions ?? 0;
  const activeDays = usage?.activeDays ?? 0;
  const costPerTurn = hasUsage && totalMessages > 0 ? realEur / totalMessages : null;

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat
          label="Coût abo"
          value={hasUsage ? formatEur(realEur, locale) : '—'}
          hint={hasUsage ? t('projects.detail.costs.realAboHint') : undefined}
        >
          {hasUsage ? (
            <Sparkline values={sparks.costUsd} tone="accent" ariaLabel="coût 30j" />
          ) : null}
        </Stat>
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
        <Stat
          label="Tokens total"
          value={hasUsage ? formatTokens(usage?.totalTokens || 0) : '—'}
          hint={hasUsage ? `${numberLabel(usage?.totalTokens || 0, locale)} tok` : undefined}
        >
          {hasUsage ? (
            <Sparkline values={sparks.tokens} tone="accent" ariaLabel="tokens 30j" />
          ) : null}
        </Stat>
        <Stat
          label="Sessions"
          value={hasUsage ? numberLabel(totalSessions, locale) : '—'}
          hint={
            hasUsage && totalMessages > 0
              ? `${numberLabel(totalMessages, locale)} messages`
              : undefined
          }
        >
          {hasUsage ? (
            <Sparkline values={sparks.sessions} tone="neutral" ariaLabel="sessions 30j" />
          ) : null}
        </Stat>
        <Stat
          label="Coût / turn"
          value={costPerTurn != null ? formatEur(costPerTurn, locale) : '—'}
          hint={costPerTurn != null ? `${numberLabel(totalMessages, locale)} turns` : undefined}
        />
        <Stat
          label="Jours actifs"
          value={hasUsage ? numberLabel(activeDays, locale) : '—'}
          hint={
            hasUsage && activeDays > 0 && usage
              ? `${formatTokens(Math.round(usage.totalTokens / activeDays))}/j`
              : undefined
          }
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

      <GitStatsPanel projectId={project.id} locale={locale} />

      <div id="health-breakdown-anchor" className="scroll-mt-4">
        <HealthBreakdownPanel
          score={project.health_score}
          breakdownJson={project.health_breakdown_json}
        />
      </div>

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
  dailyUsage,
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
  dailyUsage: DailyUsageRow[];
  locale: Locale;
  t: TFunc;
}) {
  const daily = useMemo(() => buildDailyBySourceWindow(dailyUsage, 60), [dailyUsage]);
  // Daily cost is stored in USD on the server; convert to EUR using the
  // same constant the rest of the cost math uses so charts and KPI tiles
  // can be compared directly.
  const claudeCostEur = useMemo(
    () => daily.claude.costUsd.map((v) => v * USD_TO_EUR),
    [daily.claude.costUsd],
  );
  const codexCostEur = useMemo(
    () => daily.codex.costUsd.map((v) => v * USD_TO_EUR),
    [daily.codex.costUsd],
  );

  if (!usage) {
    return (
      <Card>
        <Empty>Pas de données de coût disponibles pour ce projet.</Empty>
      </Card>
    );
  }
  return (
    <div className="flex flex-col gap-3">
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

      <Card className="!p-3">
        <div className="mb-2 flex items-baseline justify-between">
          <span className="text-[11px] uppercase tracking-[0.08em] text-[var(--text-dim)]">
            Coût PAYG / jour
          </span>
          <span className="text-[10px] text-[var(--text-faint)]">
            60j · Claude + Codex (€ contrefactuel PAYG)
          </span>
        </div>
        <StackedColumnChart
          labels={daily.labels}
          series={[
            { label: 'Claude', color: '#64d2ff', values: claudeCostEur },
            { label: 'Codex', color: '#ffd60a', values: codexCostEur },
          ]}
          height={140}
          unit="€"
          formatValue={(v) => formatEur(v, locale)}
        />
      </Card>

      {usage.models.length > 0 ? (
        <ModelCostBreakdown usage={usage} realEur={realEur} locale={locale} />
      ) : null}
    </div>
  );
}

// Coût estimé par modèle. Approximation proportionnelle à part de tokens :
// realEur × (tokens_model / tokens_total). Ne reflète pas les différences
// de €/M entre modèles (sonnet vs opus vs haiku), donc à lire comme
// "contribution relative au coût" plus que chiffres exacts. Nommer
// clairement l'approximation dans la meta évite l'illusion de précision.
function ModelCostBreakdown({
  usage,
  realEur,
  locale,
}: {
  usage: ProjectUsage;
  realEur: number;
  locale: Locale;
}) {
  const rows = useMemo(() => {
    const total = usage.models.reduce((acc, m) => acc + m.tokens, 0) || 1;
    return usage.models
      .slice(0, 10)
      .map((m) => ({
        model: m.model,
        tokens: m.tokens,
        messages: m.messages,
        share: m.tokens / total,
        eurApprox: realEur * (m.tokens / total),
      }))
      .sort((a, b) => b.tokens - a.tokens);
  }, [usage.models, realEur]);

  const maxTokens = Math.max(1, ...rows.map((r) => r.tokens));

  return (
    <Card className="!p-3">
      <div className="mb-2 flex items-baseline justify-between">
        <span className="text-[11px] uppercase tracking-[0.08em] text-[var(--text-dim)]">
          Coût par modèle
        </span>
        <span
          className="text-[10px] text-[var(--text-faint)]"
          title="Approximation proportionnelle à la part de tokens — ne reflète pas les écarts de tarif par modèle"
        >
          approx. proportionnel
        </span>
      </div>
      <div className="flex flex-col gap-1.5">
        {rows.map((r) => {
          const barPct = (r.tokens / maxTokens) * 100;
          const color = /gpt|o3|o4|codex/i.test(r.model) ? '#ffd60a' : '#64d2ff';
          return (
            <div key={r.model}>
              <div className="mb-0.5 flex items-baseline justify-between gap-2 text-[11.5px]">
                <span className="truncate font-mono text-[var(--text)]">{r.model}</span>
                <div className="flex shrink-0 items-baseline gap-3 tabular-nums">
                  <span className="text-[var(--text-dim)]">{formatTokens(r.tokens)} tok</span>
                  <span className="text-[var(--text-dim)]">
                    {numberLabel(r.messages, locale)} msg
                  </span>
                  <span className="text-[var(--text)]">≈ {formatEur(r.eurApprox, locale)}</span>
                  <span className="w-10 text-right text-[var(--text-faint)]">
                    {(r.share * 100).toFixed(1)}%
                  </span>
                </div>
              </div>
              <div className="h-1 rounded bg-[var(--surface-2)]">
                <div
                  className="h-1 rounded"
                  style={{ width: `${barPct}%`, backgroundColor: color, opacity: 0.8 }}
                />
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

function ActivityTab({
  usage,
  hasUsage,
  realEur,
  heatmapDays,
  dailyUsage,
  locale,
  t,
}: {
  usage: ProjectUsage | null;
  hasUsage: boolean;
  realEur: number;
  heatmapDays: Array<{ date: string; count: number; color: null }>;
  dailyUsage: DailyUsageRow[];
  locale: Locale;
  t: TFunc;
}) {
  // 60-day window split per source — gives a useful column chart without
  // blowing up the viewBox with a full year of thin bars.
  const daily = useMemo(() => buildDailyBySourceWindow(dailyUsage, 60), [dailyUsage]);

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

      <div className="grid grid-cols-1 gap-3 xl:grid-cols-3">
        <Card className="!p-3">
          <div className="mb-2 flex items-baseline justify-between">
            <span className="text-[11px] uppercase tracking-[0.08em] text-[var(--text-dim)]">
              Tokens / jour
            </span>
            <span className="text-[10px] text-[var(--text-faint)]">60j · stacked</span>
          </div>
          <StackedColumnChart
            labels={daily.labels}
            series={[
              { label: 'Claude', color: '#64d2ff', values: daily.claude.tokens },
              { label: 'Codex', color: '#ffd60a', values: daily.codex.tokens },
            ]}
            unit="tok"
            formatValue={(v) => formatTokens(v)}
          />
        </Card>

        <Card className="!p-3">
          <div className="mb-2 flex items-baseline justify-between">
            <span className="text-[11px] uppercase tracking-[0.08em] text-[var(--text-dim)]">
              Messages / jour
            </span>
            <span className="text-[10px] text-[var(--text-faint)]">60j · stacked</span>
          </div>
          <StackedColumnChart
            labels={daily.labels}
            series={[
              { label: 'Claude', color: '#64d2ff', values: daily.claude.messages },
              { label: 'Codex', color: '#ffd60a', values: daily.codex.messages },
            ]}
            formatValue={(v) => numberLabel(v, locale)}
          />
        </Card>

        <Card className="!p-3">
          <div className="mb-2 flex items-baseline justify-between">
            <span className="text-[11px] uppercase tracking-[0.08em] text-[var(--text-dim)]">
              Sessions / jour
            </span>
            <span className="text-[10px] text-[var(--text-faint)]">60j · stacked</span>
          </div>
          <StackedColumnChart
            labels={daily.labels}
            series={[
              { label: 'Claude', color: '#64d2ff', values: daily.claude.sessions },
              { label: 'Codex', color: '#ffd60a', values: daily.codex.sessions },
            ]}
            formatValue={(v) => numberLabel(v, locale)}
          />
        </Card>
      </div>

      <ActivityPanel usage={usage} realEur={realEur} locale={locale} t={t} />
    </div>
  );
}

// Aggregates DailyUsageRow[] into a fixed N-day window, split by source.
// Missing days are filled with zeros so the chart keeps a consistent X axis
// even when the project was idle for a stretch.
function buildDailyBySourceWindow(
  rows: DailyUsageRow[],
  days: number,
): {
  labels: string[];
  claude: { tokens: number[]; messages: number[]; sessions: number[]; costUsd: number[] };
  codex: { tokens: number[]; messages: number[]; sessions: number[]; costUsd: number[] };
} {
  const now = new Date();
  const cutoff = new Date(now);
  cutoff.setUTCDate(cutoff.getUTCDate() - (days - 1));

  type Slot = { tokens: number; messages: number; sessions: number; costUsd: number };
  const makeSlot = (): Slot => ({ tokens: 0, messages: 0, sessions: 0, costUsd: 0 });

  const claudeMap = new Map<string, Slot>();
  const codexMap = new Map<string, Slot>();
  for (const r of rows) {
    if (r.date < cutoff.toISOString().slice(0, 10)) continue;
    const target = r.source === 'codex' ? codexMap : claudeMap;
    const slot = target.get(r.date) || makeSlot();
    slot.tokens += r.totalTokens;
    slot.messages += r.messages;
    slot.sessions += r.sessions;
    slot.costUsd += r.costUsd;
    target.set(r.date, slot);
  }

  const labels: string[] = [];
  const claude = {
    tokens: [] as number[],
    messages: [] as number[],
    sessions: [] as number[],
    costUsd: [] as number[],
  };
  const codex = {
    tokens: [] as number[],
    messages: [] as number[],
    sessions: [] as number[],
    costUsd: [] as number[],
  };
  const cursor = new Date(cutoff);
  while (cursor <= now) {
    const iso = cursor.toISOString().slice(0, 10);
    labels.push(iso);
    const c = claudeMap.get(iso) || makeSlot();
    const x = codexMap.get(iso) || makeSlot();
    claude.tokens.push(c.tokens);
    claude.messages.push(c.messages);
    claude.sessions.push(c.sessions);
    claude.costUsd.push(c.costUsd);
    codex.tokens.push(x.tokens);
    codex.messages.push(x.messages);
    codex.sessions.push(x.sessions);
    codex.costUsd.push(x.costUsd);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return { labels, claude, codex };
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
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
        {hasUsage && usage && usage.models.length > 0 ? (
          <HorizontalBarList
            title={t('projects.detail.modelsTools.models')}
            meta={`top ${Math.min(12, usage.models.length)} · par tokens`}
            rows={usage.models.slice(0, 12).map((m) => ({
              key: m.model,
              label: m.model,
              value: m.tokens,
              right: `${formatTokens(m.tokens)} · ${numberLabel(m.messages, locale)} msg`,
              color: /gpt|o3|o4|codex/i.test(m.model) ? '#ffd60a' : '#64d2ff',
            }))}
          />
        ) : null}
        {hasUsage && usage && usage.tools.length > 0 ? (
          <HorizontalBarList
            title={t('projects.detail.modelsTools.tools')}
            meta={`top ${Math.min(16, usage.tools.length)} · par count`}
            rows={usage.tools.slice(0, 16).map((tool) => ({
              key: tool.name,
              label: tool.name,
              value: tool.count,
              right: numberLabel(tool.count, locale),
              color: '#bf5af2',
            }))}
          />
        ) : null}
      </div>

      {languageEntries.length > 0 ? (
        <Card className="!p-3">
          <div className="mb-2 flex items-baseline justify-between">
            <span className="text-[11px] uppercase tracking-[0.08em] text-[var(--text-dim)]">
              {t('projects.detail.languages.title')}
            </span>
            <span className="text-[10px] text-[var(--text-faint)]">
              {numberLabel(
                languageEntries.reduce((acc, [, v]) => acc + v, 0),
                locale,
              )}{' '}
              LoC · {languageEntries.length} extensions
            </span>
          </div>
          <div className="grid grid-cols-1 items-center gap-4 md:grid-cols-[180px_minmax(0,1fr)]">
            <LanguagesDonut entries={languageEntries.slice(0, 8)} />
            <div className="flex flex-col gap-1">
              {languageEntries.slice(0, 12).map(([ext, lines], i) => {
                const total = languageEntries.reduce((acc, [, v]) => acc + v, 0) || 1;
                const share = lines / total;
                return (
                  <div
                    key={ext}
                    className="flex items-baseline justify-between gap-2 text-[11.5px]"
                  >
                    <span className="flex items-center gap-1.5">
                      <span
                        className="inline-block h-2 w-2 rounded-sm"
                        style={{ backgroundColor: LANG_PALETTE[i % LANG_PALETTE.length] }}
                        aria-hidden="true"
                      />
                      <span className="font-mono text-[var(--text)]">.{ext}</span>
                    </span>
                    <div className="flex shrink-0 items-baseline gap-3 tabular-nums">
                      <span className="text-[var(--text-dim)]">
                        {numberLabel(lines, locale)} LoC
                      </span>
                      <span className="w-12 text-right text-[var(--text-faint)]">
                        {(share * 100).toFixed(1)}%
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </Card>
      ) : null}
    </div>
  );
}

// Horizontal bars stacked vertically — more legible than chips for rankings
// because the eye can catch length deltas faster than number deltas.
function HorizontalBarList({
  title,
  meta,
  rows,
}: {
  title: string;
  meta?: string;
  rows: Array<{ key: string; label: string; value: number; right: string; color: string }>;
}) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <Card className="!p-3">
      <div className="mb-2 flex items-baseline justify-between">
        <span className="text-[11px] uppercase tracking-[0.08em] text-[var(--text-dim)]">
          {title}
        </span>
        {meta ? <span className="text-[10px] text-[var(--text-faint)]">{meta}</span> : null}
      </div>
      <div className="flex flex-col gap-1.5">
        {rows.map((r) => {
          const pct = (r.value / max) * 100;
          return (
            <div key={r.key}>
              <div className="mb-0.5 flex items-baseline justify-between gap-2 text-[11.5px]">
                <span className="truncate text-[var(--text)]" title={r.label}>
                  {r.label}
                </span>
                <span className="num shrink-0 tabular-nums text-[var(--text-dim)]">{r.right}</span>
              </div>
              <div className="h-1 rounded bg-[var(--surface-2)]">
                <div
                  className="h-1 rounded"
                  style={{ width: `${pct}%`, backgroundColor: r.color, opacity: 0.85 }}
                />
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

const LANG_PALETTE = [
  '#64d2ff',
  '#30d158',
  '#ffd60a',
  '#bf5af2',
  '#ff9f0a',
  '#ff375f',
  '#5ac8fa',
  '#a29bfe',
  '#00d4aa',
  '#fec260',
  '#ff6482',
  '#78c3ff',
];

// Donut chart pour le breakdown LoC par langage. SVG pur ; les arcs sont
// calculés en coordonnées polaires puis transformés via le path `A` (arc).
// Angle = share × 2π, cumulé jour après jour autour du cercle.
function LanguagesDonut({ entries }: { entries: Array<[string, number]> }) {
  const total = entries.reduce((acc, [, v]) => acc + v, 0);
  if (total <= 0) return null;

  const size = 140;
  const cx = size / 2;
  const cy = size / 2;
  const rOuter = size / 2 - 4;
  const rInner = rOuter - 22;

  let startAngle = -Math.PI / 2; // start at 12 o'clock

  const arcs = entries.map(([ext, value], i) => {
    const angle = (value / total) * 2 * Math.PI;
    const endAngle = startAngle + angle;
    const largeArc = angle > Math.PI ? 1 : 0;

    const x1 = cx + rOuter * Math.cos(startAngle);
    const y1 = cy + rOuter * Math.sin(startAngle);
    const x2 = cx + rOuter * Math.cos(endAngle);
    const y2 = cy + rOuter * Math.sin(endAngle);
    const x3 = cx + rInner * Math.cos(endAngle);
    const y3 = cy + rInner * Math.sin(endAngle);
    const x4 = cx + rInner * Math.cos(startAngle);
    const y4 = cy + rInner * Math.sin(startAngle);

    const path = [
      `M ${x1} ${y1}`,
      `A ${rOuter} ${rOuter} 0 ${largeArc} 1 ${x2} ${y2}`,
      `L ${x3} ${y3}`,
      `A ${rInner} ${rInner} 0 ${largeArc} 0 ${x4} ${y4}`,
      'Z',
    ].join(' ');

    startAngle = endAngle;
    return { path, color: LANG_PALETTE[i % LANG_PALETTE.length], ext, value };
  });

  return (
    <svg
      viewBox={`0 0 ${size} ${size}`}
      width={size}
      height={size}
      role="img"
      aria-label="LoC par langage"
    >
      <title>Breakdown LoC par langage</title>
      {arcs.map((a) => (
        <path key={a.ext} d={a.path} fill={a.color} opacity={0.9}>
          <title>{`.${a.ext}: ${a.value} LoC`}</title>
        </path>
      ))}
      <text
        x={cx}
        y={cy - 2}
        textAnchor="middle"
        dominantBaseline="central"
        fontSize="10"
        fill="var(--text-dim)"
      >
        LoC
      </text>
      <text
        x={cx}
        y={cy + 10}
        textAnchor="middle"
        dominantBaseline="central"
        fontSize="13"
        fontWeight="600"
        fill="var(--text)"
      >
        {total >= 1000 ? `${Math.round(total / 1000)}K` : total}
      </text>
    </svg>
  );
}

// Live-fetched git metadata: commit counts, author diversity, recent
// hotspots. The scanned `ProjectDetail` only stores branch/remote/last
// commit for performance; this endpoint gives us the auditable detail
// panel without bloating the main project scan.
type GitStatsResponse = {
  isGitRepo: boolean;
  totalCommits: number | null;
  commitsLast30d: number | null;
  commitsLast7d: number | null;
  authors30d: number | null;
  authorsTotal: number | null;
  hotFiles: Array<{ path: string; changes: number }>;
  topAuthors: Array<{ name: string; commits: number }>;
};

function GitStatsPanel({ projectId, locale }: { projectId: string; locale: Locale }) {
  const [stats, setStats] = useState<GitStatsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(false);
    apiGet<GitStatsResponse>(`/api/projects/${projectId}/git/stats`)
      .then((res) => {
        if (!cancelled) {
          setStats(res);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setError(true);
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  if (loading) {
    return (
      <Card className="!p-3">
        <div className="text-[11px] uppercase tracking-[0.08em] text-[var(--text-dim)]">
          Git activity
        </div>
        <Empty>Chargement…</Empty>
      </Card>
    );
  }
  if (error || !stats) {
    return null;
  }
  if (!stats.isGitRepo) {
    return (
      <Card className="!p-3">
        <div className="text-[11px] uppercase tracking-[0.08em] text-[var(--text-dim)]">
          Git activity
        </div>
        <Empty>Ce projet n'est pas un dépôt git.</Empty>
      </Card>
    );
  }

  return (
    <Card className="!p-3">
      <div className="mb-2 flex items-baseline justify-between">
        <span className="text-[11px] uppercase tracking-[0.08em] text-[var(--text-dim)]">
          Git activity
        </span>
        <span className="text-[10px] text-[var(--text-faint)]">90j de logs</span>
      </div>
      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        <div className="rounded-[var(--radius-sm)] bg-[var(--surface-2)] px-2.5 py-1.5">
          <div className="text-[10px] text-[var(--text-dim)]">Commits (7j)</div>
          <div className="num text-[16px] font-semibold tabular-nums">
            {stats.commitsLast7d ?? '—'}
          </div>
        </div>
        <div className="rounded-[var(--radius-sm)] bg-[var(--surface-2)] px-2.5 py-1.5">
          <div className="text-[10px] text-[var(--text-dim)]">Commits (30j)</div>
          <div className="num text-[16px] font-semibold tabular-nums">
            {stats.commitsLast30d ?? '—'}
          </div>
        </div>
        <div className="rounded-[var(--radius-sm)] bg-[var(--surface-2)] px-2.5 py-1.5">
          <div className="text-[10px] text-[var(--text-dim)]">Total commits</div>
          <div className="num text-[16px] font-semibold tabular-nums">
            {stats.totalCommits != null ? numberLabel(stats.totalCommits, locale) : '—'}
          </div>
        </div>
        <div className="rounded-[var(--radius-sm)] bg-[var(--surface-2)] px-2.5 py-1.5">
          <div className="text-[10px] text-[var(--text-dim)]">Auteurs (30j)</div>
          <div className="num text-[16px] font-semibold tabular-nums">
            {stats.authors30d ?? '—'}
          </div>
        </div>
      </div>

      {stats.hotFiles.length > 0 || stats.topAuthors.length > 0 ? (
        <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
          {stats.hotFiles.length > 0 ? (
            <div>
              <div className="mb-1 text-[11px] text-[var(--text-dim)]">
                Fichiers les plus modifiés (90j)
              </div>
              <ul className="flex flex-col gap-0.5">
                {stats.hotFiles.slice(0, 6).map((f) => (
                  <li
                    key={f.path}
                    className="flex items-baseline justify-between gap-2 text-[11.5px]"
                  >
                    <span className="truncate font-mono text-[var(--text)]" title={f.path}>
                      {f.path}
                    </span>
                    <span className="num shrink-0 tabular-nums text-[var(--text-dim)]">
                      {f.changes}×
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {stats.topAuthors.length > 0 ? (
            <div>
              <div className="mb-1 text-[11px] text-[var(--text-dim)]">Top contributeurs (90j)</div>
              <ul className="flex flex-col gap-0.5">
                {stats.topAuthors.slice(0, 6).map((a) => (
                  <li
                    key={a.name}
                    className="flex items-baseline justify-between gap-2 text-[11.5px]"
                  >
                    <span className="truncate text-[var(--text)]" title={a.name}>
                      {a.name}
                    </span>
                    <span className="num shrink-0 tabular-nums text-[var(--text-dim)]">
                      {a.commits}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}
    </Card>
  );
}

// Stacked column chart: one bar per day, optionally split across series
// (e.g. Claude vs Codex). Pure SVG — the recharts ResponsiveContainer is
// heavy for a 60-day bar chart and overdetermined for our needs.
//
// The bars are rendered as two stacked rects per day so hover/tooltip can
// address them independently (via the native <title> child for simplicity).
type StackedSeries = {
  label: string;
  color: string;
  values: number[]; // length === labels.length
};

function StackedColumnChart({
  labels,
  series,
  height = 120,
  unit = '',
  formatValue,
  formatLabel,
}: {
  labels: string[]; // ISO dates
  series: StackedSeries[];
  height?: number;
  unit?: string;
  formatValue?: (v: number) => string;
  formatLabel?: (iso: string) => string;
}) {
  const n = labels.length;
  if (n === 0 || series.length === 0) {
    return <Empty>—</Empty>;
  }

  const totals = labels.map((_, i) => series.reduce((acc, s) => acc + (s.values[i] ?? 0), 0));
  const max = Math.max(1, ...totals);
  // Use a viewBox that scales with the number of bars so per-bar geometry
  // is stable regardless of how many days we plot. Earlier version used a
  // fixed width=100 with a hard 2px gap, which produced a negative bar
  // width once n got above ~33 (60 days × 2 gap > 100 viewBox).
  const slotW = 10; // viewBox units per day
  const barRatio = 0.72; // 72% bar, 28% gap within each slot — visually breathes
  const barW = slotW * barRatio;
  const slotGap = slotW - barW;
  const width = slotW * n;

  const fmt = formatValue ?? ((v: number) => String(Math.round(v)));
  const fmtLabel = formatLabel ?? ((iso: string) => iso.slice(5));

  return (
    <div className="flex flex-col gap-1.5">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        width="100%"
        height={height}
        className="block"
        role="img"
      >
        <title>Timeseries</title>
        {labels.map((iso, i) => {
          let yCursor = height;
          const x = i * slotW + slotGap / 2;
          return (
            <g key={iso}>
              {series.map((s) => {
                const v = s.values[i] ?? 0;
                if (v <= 0) return null;
                const h = (v / max) * (height - 2);
                yCursor -= h;
                return (
                  <rect
                    key={s.label}
                    x={x}
                    y={yCursor}
                    width={barW}
                    height={h}
                    fill={s.color}
                    opacity={0.9}
                  >
                    <title>{`${fmtLabel(iso)} · ${s.label}: ${fmt(v)}${unit ? ` ${unit}` : ''}`}</title>
                  </rect>
                );
              })}
              <rect x={i * slotW} y={0} width={slotW} height={height} fill="transparent">
                <title>{`${fmtLabel(iso)} · total: ${fmt(totals[i])}${unit ? ` ${unit}` : ''}`}</title>
              </rect>
            </g>
          );
        })}
      </svg>
      <div className="flex flex-wrap items-center gap-3 text-[10px] text-[var(--text-dim)]">
        {series.map((s) => (
          <span key={s.label} className="inline-flex items-center gap-1">
            <span
              className="inline-block h-2 w-2 rounded-sm"
              style={{ backgroundColor: s.color }}
              aria-hidden="true"
            />
            <span>{s.label}</span>
          </span>
        ))}
        <span className="ml-auto text-[var(--text-faint)]">
          max {fmt(max)}
          {unit ? ` ${unit}` : ''} · {n}j
        </span>
      </div>
    </div>
  );
}

// Compact inline sparkline for KPI tiles. 30 data points typical. We render
// an area+line polyline with a subtle baseline. Pure SVG, no recharts — the
// overhead of CartesianChart isn't justified for a 140×28 decoration.
function Sparkline({
  values,
  tone = 'accent',
  ariaLabel,
  height = 22,
}: {
  values: number[];
  tone?: 'accent' | 'success' | 'warn' | 'danger' | 'neutral';
  ariaLabel?: string;
  height?: number;
}) {
  if (!values.length) return null;
  const max = Math.max(...values, 1);
  const width = 100;
  const stepX = values.length > 1 ? width / (values.length - 1) : 0;
  const color =
    tone === 'success'
      ? '#30d158'
      : tone === 'warn'
        ? '#ffd60a'
        : tone === 'danger'
          ? '#ff453a'
          : tone === 'neutral'
            ? 'var(--text-dim)'
            : '#64d2ff';

  const points = values.map((v, i) => {
    const x = i * stepX;
    const y = height - (v / max) * (height - 2) - 1;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  });
  const areaPath = `M0,${height} L${points.join(' L')} L${width},${height} Z`;

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width="100%"
      height={height}
      preserveAspectRatio="none"
      aria-label={ariaLabel}
      role="img"
      className="block"
    >
      <path d={areaPath} fill={color} opacity={0.15} />
      <polyline
        points={points.join(' ')}
        fill="none"
        stroke={color}
        strokeWidth={1}
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

// Renders the 6-factor breakdown that powers the health_score. Each factor
// contributes `weight × value` to the final score; we show the raw value
// (a 0..1 bar) and the contribution as the numeric weight so the score is
// auditable rather than opaque.
function HealthBreakdownPanel({
  score,
  breakdownJson,
}: {
  score: number;
  breakdownJson: string | null;
}) {
  const breakdown = useMemo<HealthBreakdown | null>(() => {
    if (!breakdownJson) return null;
    try {
      const parsed = JSON.parse(breakdownJson) as HealthBreakdown;
      if (!parsed || typeof parsed !== 'object' || !parsed.factors) return null;
      return parsed;
    } catch {
      return null;
    }
  }, [breakdownJson]);

  if (!breakdown) {
    return (
      <Card className="!p-3">
        <div className="mb-1 flex items-baseline justify-between">
          <span className="text-[11px] uppercase tracking-[0.08em] text-[var(--text-dim)]">
            Health breakdown
          </span>
          <span className="text-[11px] text-[var(--text-faint)]">{score}/100</span>
        </div>
        <Empty>Breakdown non disponible — relance un scan.</Empty>
      </Card>
    );
  }

  // Sort by contribution (weight × value) descending so the biggest levers
  // are at the top. Factors with weight=0 (activity with no git) are
  // demoted to the bottom rather than hidden, so the weight redistribution
  // is visible.
  const ordered = Object.entries(breakdown.factors).sort(
    ([, a], [, b]) => b.weight * b.value - a.weight * a.value,
  );

  return (
    <Card className="!p-3">
      <div className="mb-2 flex items-baseline justify-between">
        <span className="text-[11px] uppercase tracking-[0.08em] text-[var(--text-dim)]">
          Health breakdown
        </span>
        <span className="text-[11px] text-[var(--text-faint)]">6 facteurs · score {score}/100</span>
      </div>
      <div className="flex flex-col gap-2">
        {ordered.map(([key, f]) => {
          const pct = Math.round(f.value * 100);
          const contribution = f.weight * f.value * 100;
          const tone: 'ok' | 'warn' | 'danger' = pct >= 70 ? 'ok' : pct >= 40 ? 'warn' : 'danger';
          const barColor = tone === 'ok' ? '#30d158' : tone === 'warn' ? '#ffd60a' : '#ff453a';
          // Weight=0 means this factor was redistributed (e.g. activity
          // with no git history). Mute it so the user sees it's inert.
          const muted = f.weight === 0;
          return (
            <div key={key} className={muted ? 'opacity-50' : ''}>
              <div className="mb-1 flex items-baseline justify-between gap-2">
                <div className="flex items-baseline gap-2 min-w-0">
                  <span className="text-[12px] font-medium text-[var(--text)]">{f.label}</span>
                  <span className="text-[10.5px] text-[var(--text-faint)] truncate">
                    {f.reason}
                  </span>
                </div>
                <div className="flex shrink-0 items-baseline gap-2">
                  <span className="num text-[10.5px] tabular-nums text-[var(--text-dim)]">
                    {muted ? 'n/a' : `+${contribution.toFixed(1)}`}
                  </span>
                  <span
                    className="num w-10 text-right text-[12px] font-semibold tabular-nums"
                    style={{ color: muted ? 'var(--text-faint)' : barColor }}
                  >
                    {pct}%
                  </span>
                </div>
              </div>
              <div className="h-1.5 rounded bg-[var(--surface-2)]">
                <div
                  className="h-1.5 rounded transition-all"
                  style={{
                    width: `${pct}%`,
                    backgroundColor: muted ? 'var(--surface-3)' : barColor,
                    opacity: muted ? 0.3 : 1,
                  }}
                />
                {!muted && f.weight > 0 ? (
                  // Marker showing the weight ceiling — i.e. the max
                  // contribution this factor could make at value=1.
                  // Gives the user a visual sense of "how much room is
                  // left" for this factor to improve.
                  <div
                    className="relative -mt-1.5 h-1.5"
                    style={{ width: '100%' }}
                    aria-hidden="true"
                  >
                    <div
                      className="absolute top-0 h-1.5 w-[1px] bg-[var(--text-faint)]"
                      style={{ left: `${f.weight * 100}%`, opacity: 0.4 }}
                    />
                  </div>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
      <div className="mt-2 text-[10px] text-[var(--text-faint)]">
        Chaque facteur contribue <span className="num">weight × value</span> au score. La barre
        verticale indique le poids max (ex. documentation = 20 pts).
      </div>
    </Card>
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

function ReadmeBody({ markdown, projectId }: { markdown: string; projectId: string }) {
  if (!markdown) {
    return <Empty>README non disponible.</Empty>;
  }
  return (
    <div className="max-h-[720px] overflow-auto pr-2">
      <Markdown content={markdown} projectId={projectId} />
    </div>
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
