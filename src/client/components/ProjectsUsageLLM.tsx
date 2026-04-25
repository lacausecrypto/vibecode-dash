import type { ProjectSummary } from '@shared/types';
import { memo, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { type Locale, dateLocale, numberLocale, useTranslation } from '../lib/i18n';
import {
  type BillingHistory,
  type CostBreakdown,
  DEV_HOURLY_RATE_EUR,
  type DevEffortEstimate,
  USD_TO_EUR,
  computeBillingCost,
  computeCost,
  devEquivalentEur,
  devEquivalentHours,
  estimateDevEffort,
  formatEur,
  formatEurPerMillion,
  formatHours,
} from '../lib/pricing';
import { useApi } from '../lib/useApi';
import { EmptyState, ErrorState, SkeletonList } from './States';
import { Button, Card, Chip, Section, Segmented, Stat, Toolbar } from './ui';

type ClaudeProjectRow = {
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

type CodexProjectRow = {
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
  cacheHitRatio: number;
  lastTs: number | null;
  accruedEur?: number;
  firstSeenTs?: number | null;
  lastSeenTs?: number | null;
  activeDays?: number;
  models: Array<{ model: string; turns: number; tokens: number }>;
  tools: Array<{ name: string; count: number }>;
};

type UsageMeta = {
  generatedAt: number;
  fromTs: number;
  toTs: number;
  filesScanned: number;
  linesParsed: number;
};

type ClaudeResponse = { rows: ClaudeProjectRow[]; meta: UsageMeta };
type CodexResponse = { rows: CodexProjectRow[]; meta: UsageMeta };

type Period = '7' | '30' | '90' | 'all';
type Source = 'combined' | 'claude' | 'codex';
type SortKey = 'tokens' | 'cost' | 'messages' | 'sessions' | 'recent';

type MergedRow = {
  key: string;
  projectId: string | null;
  projectName: string;
  projectPath: string | null;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheCreate: number;
  cacheReuseRatio: number;
  messages: number;
  sessions: number;
  lastTs: number | null;
  claudeTokens: number;
  codexTokens: number;
  claudeMessages: number;
  codexTurns: number;
  topModel: string | null;
  topTool: string | null;
  accruedEur: number;
  firstSeenTs: number | null;
  lastSeenTs: number | null;
  activeDays: number;
  models: Array<{ model: string; tokens: number; messages: number; source: 'claude' | 'codex' }>;
  tools: Array<{ name: string; count: number; source: 'claude' | 'codex' }>;
  matchedProject: ProjectSummary | null;
};

type Props = {
  projects?: ProjectSummary[];
};

function isoFromDaysAgo(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
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

function formatCount(value: number): string {
  return new Intl.NumberFormat(numberLocale(currentLocale())).format(value);
}

let LOCALE_SNAPSHOT: Locale = 'fr';
function currentLocale(): Locale {
  return LOCALE_SNAPSHOT;
}

function relativeTime(
  ts: number | null,
  tr: (key: string, vars?: Record<string, string | number>) => string = (k) => k,
): string {
  if (!ts) return tr('github.sourceChipNever');
  const diffSec = Math.max(0, Math.floor(Date.now() / 1000) - ts);
  const days = Math.floor(diffSec / 86400);
  if (days <= 0) {
    const hours = Math.floor(diffSec / 3600);
    if (hours <= 0) return tr('common.today');
    return `${hours} h`;
  }
  if (days === 1) return tr('common.yesterday');
  if (days < 30) return tr('common.daysAgo', { n: days });
  if (days < 365) return tr('common.monthsAgo', { n: Math.floor(days / 30) });
  return tr('common.yearsAgo', { n: Math.floor(days / 365) });
}

function pickProject(
  projects: ProjectSummary[],
  projectId: string | null,
  projectPath: string | null,
  projectName: string | null,
): ProjectSummary | null {
  if (projectId) {
    const match = projects.find((p) => p.id === projectId);
    if (match) {
      return match;
    }
  }
  if (projectPath) {
    const match = projects.find((p) => p.path === projectPath);
    if (match) {
      return match;
    }
  }
  if (projectName) {
    const match = projects.find((p) => p.name === projectName);
    if (match) {
      return match;
    }
  }
  return null;
}

function applyAlias(name: string, aliases: Record<string, string>): string {
  return aliases[name] || name;
}

function mergeRows(
  claude: ClaudeProjectRow[],
  codex: CodexProjectRow[],
  source: Source,
  projects: ProjectSummary[],
  aliases: Record<string, string>,
): MergedRow[] {
  const merged = new Map<string, MergedRow>();

  function keyFor(row: {
    projectId: string | null;
    projectPath: string | null;
    projectKey: string;
  }) {
    return row.projectId || row.projectPath || row.projectKey;
  }

  if (source !== 'codex') {
    for (const row of claude) {
      const key = keyFor(row);
      const matched = pickProject(projects, row.projectId, row.projectPath, row.projectName);
      const existing = merged.get(key);
      const topModel = row.models[0]?.model || null;
      const topTool = row.tools[0]?.name || null;
      const rawName =
        row.projectName || matched?.name || row.projectKey.split('/').pop() || row.projectKey;
      const baseName = applyAlias(rawName, aliases);

      if (!existing) {
        merged.set(key, {
          key,
          projectId: row.projectId || matched?.id || null,
          projectName: baseName,
          projectPath: row.projectPath || matched?.path || null,
          totalTokens: row.totalTokens,
          inputTokens: row.inputTokens,
          outputTokens: row.outputTokens,
          cacheRead: row.cacheRead,
          cacheCreate: row.cacheCreate,
          cacheReuseRatio: row.cacheReuseRatio,
          messages: row.messageCount,
          sessions: row.sessions,
          lastTs: row.lastTs,
          claudeTokens: row.totalTokens,
          codexTokens: 0,
          claudeMessages: row.messageCount,
          codexTurns: 0,
          topModel,
          topTool,
          accruedEur: row.accruedEur ?? 0,
          firstSeenTs: row.firstSeenTs ?? null,
          lastSeenTs: row.lastSeenTs ?? null,
          activeDays: row.activeDays ?? 0,
          models: row.models.slice(0, 5).map((m) => ({
            model: m.model,
            tokens: m.tokens,
            messages: m.messages,
            source: 'claude' as const,
          })),
          tools: row.tools.slice(0, 8).map((t) => ({
            name: t.name,
            count: t.count,
            source: 'claude' as const,
          })),
          matchedProject: matched,
        });
      }
    }
  }

  if (source !== 'claude') {
    for (const row of codex) {
      const key = keyFor(row);
      const matched = pickProject(projects, row.projectId, row.projectPath, row.projectName);
      const existing = merged.get(key);
      const topModel = row.models[0]?.model || null;
      const topTool = row.tools[0]?.name || null;
      const rawName =
        row.projectName || matched?.name || row.projectKey.split('/').pop() || row.projectKey;
      const baseName = applyAlias(rawName, aliases);

      // Codex / OpenAI convention: input_tokens INCLUDES cached_input_tokens.
      // Subtract to get net input (avoids double-billing at both input + cache rates).
      const netInput = Math.max(0, row.inputTokens - row.cachedInputTokens);
      // Codex reasoning tokens are billed as output tokens (OpenAI pricing).
      const effectiveOutput = row.outputTokens + row.reasoningOutputTokens;
      const codexEffectiveTotal = netInput + effectiveOutput + row.cachedInputTokens;

      if (existing) {
        existing.totalTokens += codexEffectiveTotal;
        existing.inputTokens += netInput;
        existing.outputTokens += effectiveOutput;
        existing.cacheRead += row.cachedInputTokens;
        existing.codexTokens = codexEffectiveTotal;
        existing.codexTurns = row.turns;
        existing.sessions += row.sessions;
        existing.accruedEur += row.accruedEur ?? 0;
        if (row.firstSeenTs) {
          existing.firstSeenTs =
            existing.firstSeenTs === null
              ? row.firstSeenTs
              : Math.min(existing.firstSeenTs, row.firstSeenTs);
        }
        if (row.lastSeenTs) {
          existing.lastSeenTs =
            existing.lastSeenTs === null
              ? row.lastSeenTs
              : Math.max(existing.lastSeenTs, row.lastSeenTs);
        }
        existing.activeDays = Math.max(existing.activeDays, row.activeDays ?? 0);
        if (row.lastTs && (!existing.lastTs || row.lastTs > existing.lastTs)) {
          existing.lastTs = row.lastTs;
        }
        existing.models.push(
          ...row.models.slice(0, 3).map((m) => ({
            model: m.model,
            tokens: m.tokens,
            messages: m.turns,
            source: 'codex' as const,
          })),
        );
        existing.tools.push(
          ...row.tools.slice(0, 5).map((t) => ({
            name: t.name,
            count: t.count,
            source: 'codex' as const,
          })),
        );
        if (!existing.topTool && topTool) {
          existing.topTool = topTool;
        }
        if (!existing.topModel && topModel) {
          existing.topModel = topModel;
        }
      } else {
        merged.set(key, {
          key,
          projectId: row.projectId || matched?.id || null,
          projectName: baseName,
          projectPath: row.projectPath || matched?.path || null,
          totalTokens: codexEffectiveTotal,
          inputTokens: netInput,
          outputTokens: effectiveOutput,
          cacheRead: row.cachedInputTokens,
          cacheCreate: 0,
          cacheReuseRatio: row.cacheHitRatio,
          messages: row.turns,
          sessions: row.sessions,
          lastTs: row.lastTs,
          claudeTokens: 0,
          codexTokens: codexEffectiveTotal,
          claudeMessages: 0,
          codexTurns: row.turns,
          topModel,
          topTool,
          accruedEur: row.accruedEur ?? 0,
          firstSeenTs: row.firstSeenTs ?? null,
          lastSeenTs: row.lastSeenTs ?? null,
          activeDays: row.activeDays ?? 0,
          models: row.models.slice(0, 5).map((m) => ({
            model: m.model,
            tokens: m.tokens,
            messages: m.turns,
            source: 'codex' as const,
          })),
          tools: row.tools.slice(0, 8).map((t) => ({
            name: t.name,
            count: t.count,
            source: 'codex' as const,
          })),
          matchedProject: matched,
        });
      }
    }
  }

  return [...merged.values()];
}

function periodToDays(period: Period): number {
  if (period === 'all') {
    // 5 years rolling — englobe tout l'historique Claude depuis juillet 2025.
    return 5 * 365;
  }
  return Number(period);
}

function useUsageData(period: Period, source: Source) {
  const days = periodToDays(period);
  const from = isoFromDaysAgo(days);
  const to = todayIso();
  const claudePath =
    source === 'codex' ? null : `/api/usage/by-project?from=${from}&to=${to}&limit=500`;
  const codexPath =
    source === 'claude' ? null : `/api/usage/codex/by-project?from=${from}&to=${to}&limit=500`;

  const claude = useApi<ClaudeResponse>(claudePath);
  const codex = useApi<CodexResponse>(codexPath);
  return { claude, codex };
}

export function ProjectsUsageLLM({ projects: externalProjects }: Props) {
  const { t, locale } = useTranslation();
  LOCALE_SNAPSHOT = locale;
  const [period, setPeriod] = useState<Period>('30');
  const [source, setSource] = useState<Source>('combined');
  const [sortBy, setSortBy] = useState<SortKey>('tokens');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [limit, setLimit] = useState(10);

  const { claude, codex } = useUsageData(period, source);
  const settings = useApi<{
    displayAliases?: Record<string, string>;
    devEquivalent?: { hourlyRateEur?: number; outputTokensPerHour?: number };
    billingHistory?: BillingHistory;
  }>('/api/settings');
  const projectsApi = useApi<ProjectSummary[]>(externalProjects ? null : '/api/projects');
  const projects = useMemo<ProjectSummary[]>(
    () => externalProjects || (projectsApi.status === 'success' ? projectsApi.data : []),
    [externalProjects, projectsApi.status, projectsApi.data],
  );
  const aliases = useMemo(
    () =>
      settings.status === 'success' && settings.data.displayAliases
        ? settings.data.displayAliases
        : {},
    [settings.status, settings.data],
  );
  const devParams = useMemo(
    () => ({
      hourlyRateEur: settings.data?.devEquivalent?.hourlyRateEur,
      outputTokensPerHour: settings.data?.devEquivalent?.outputTokensPerHour,
    }),
    [settings.data],
  );

  const claudeRows = claude.status === 'success' ? claude.data.rows : [];
  const codexRows = codex.status === 'success' ? codex.data.rows : [];

  const loading =
    (source !== 'codex' && claude.status === 'loading') ||
    (source !== 'claude' && codex.status === 'loading');

  const errorMessage =
    (source !== 'codex' && claude.status === 'error' && claude.error.message) ||
    (source !== 'claude' && codex.status === 'error' && codex.error.message) ||
    null;

  function reloadAll() {
    if (source !== 'codex') {
      claude.reload();
    }
    if (source !== 'claude') {
      codex.reload();
    }
  }

  const merged = useMemo(
    () => mergeRows(claudeRows, codexRows, source, projects, aliases),
    [claudeRows, codexRows, source, projects, aliases],
  );

  const costed = useMemo(() => {
    const rate = devParams.hourlyRateEur ?? DEV_HOURLY_RATE_EUR;
    return merged.map((row) => {
      const cost = computeCost({
        models: row.models,
        inputTokens: row.inputTokens,
        outputTokens: row.outputTokens,
        cacheReadTokens: row.cacheRead,
        cacheWriteTokens: row.cacheCreate,
        defaultSource: row.codexTokens > row.claudeTokens ? 'codex' : 'claude',
      });

      // realEur = time-weighted daily attribution calculée server-side.
      // Un projet créé il y a N jours reçoit au maximum N jours d'abo
      // (pas toute la fenêtre). Chaque jour, l'abo est réparti entre les
      // projets actifs ce jour-là en proportion de leurs tokens.
      const realEur = row.accruedEur;
      const leverage = realEur > 0 ? cost.totalEur / realEur : 0;

      // Per-project dev estimate (médiane des 3 estimateurs).
      // On le calcule ici pour que kpis puisse sommer proprement.
      const effort = estimateDevEffort(
        {
          outputTokens: row.outputTokens,
          messages: row.messages,
          sessions: row.sessions,
          activeDays: row.activeDays,
          inputTokens: row.inputTokens,
          cacheReadTokens: row.cacheRead,
          cacheCreateTokens: row.cacheCreate,
        },
        { hourlyRateEur: rate },
      );

      return {
        row,
        cost,
        realEur,
        claudeShare: 0,
        codexShare: 0,
        leverage,
        effort,
      };
    });
  }, [merged, devParams]);

  const sorted = useMemo(() => {
    const rows = [...costed];
    rows.sort((a, b) => {
      if (sortBy === 'cost') {
        return b.realEur - a.realEur;
      }
      if (sortBy === 'messages') {
        return b.row.messages - a.row.messages;
      }
      if (sortBy === 'sessions') {
        return b.row.sessions - a.row.sessions;
      }
      if (sortBy === 'recent') {
        return (b.row.lastTs || 0) - (a.row.lastTs || 0);
      }
      return b.row.totalTokens - a.row.totalTokens;
    });
    return rows;
  }, [costed, sortBy]);

  const kpis = useMemo(() => {
    const totalTokens = merged.reduce((acc, row) => acc + row.totalTokens, 0);
    const totalOutputTokens = merged.reduce((acc, row) => acc + row.outputTokens, 0);
    const totalMessages = merged.reduce((acc, row) => acc + row.messages, 0);
    const totalSessions = merged.reduce((acc, row) => acc + row.sessions, 0);
    const activeProjects = merged.filter((row) => row.totalTokens > 0).length;
    const totalCostEur = costed.reduce((acc, entry) => acc + entry.cost.totalEur, 0);
    const totalRealEur = costed.reduce((acc, entry) => acc + entry.realEur, 0);
    const periodDays = periodToDays(period);
    const nowSec = Math.floor(Date.now() / 1000);
    const billing = computeBillingCost(
      settings.data?.billingHistory,
      source,
      nowSec - periodDays * 86_400,
      nowSec,
      nowSec,
    );
    const paygVsSubLeverage = billing.total > 0 ? totalCostEur / billing.total : 0;
    const paygSavingsEur = totalCostEur - billing.total;

    // Total dev = somme des estimations par-projet (médiane par projet, additionnée).
    // Cohérent avec totalCostEur / totalRealEur qui sont aussi des sommes par-projet.
    // L'ancienne approche "global estimate" avec inputs agrégés donnait une valeur
    // qui ne correspondait pas à la moyenne des estimations individuelles.
    const totalDevEur = costed.reduce((acc, entry) => acc + entry.effort.midEur, 0);
    const totalDevHours = costed.reduce((acc, entry) => acc + entry.effort.midHours, 0);
    const totalDevLowEur = costed.reduce((acc, entry) => acc + entry.effort.lowEur, 0);
    const totalDevHighEur = costed.reduce((acc, entry) => acc + entry.effort.highEur, 0);

    const devLeverageVsPayg = totalCostEur > 0 ? totalDevEur / totalCostEur : 0;
    const devLeverageVsAbo = totalRealEur > 0 ? totalDevEur / totalRealEur : 0;

    // Abo non utilisé — formule rigoureuse avec décomposition 4-parties.
    //
    // Problème à corriger : si la table daily_usage n'a pas de données pour
    // une partie de la période (ex: DB récente, migration), `totalRealEur`
    // sous-estime l'usage réel, et la différence s'est retrouvée comptée en
    // "idle". Il faut donc séparer "jours avec données" de "jours sans".
    //
    // Bornes de données : premier/dernier `firstSeenTs` / `lastSeenTs` des
    // projets (= plage où nous avons effectivement des tokens en DB).
    //
    // Décomposition du cash :
    //   - used        = Σ realEur : attribué aux projets actifs (time-weighted)
    //   - idleWithData = max(0, accruedWithData − used)
    //                    → jours couverts par l'abo ET par nos données, sans projet actif
    //   - noData      = accruedTotal − accruedWithData
    //                    → jours couverts par l'abo mais pas de données token en DB
    //   - prepaid     = max(0, cash − accruedTotal)
    //                    → jours payés pas encore écoulés
    // used + idleWithData + noData + prepaid ≈ cash (à l'arrondi près)
    //
    // Le vrai KPI "% utilisé" = used / (used + idleWithData), car c'est
    // la seule partie où on peut juger de l'utilisation effective.
    const cashEur = billing.total;
    const accruedEur = billing.accrued.total;

    // Fenêtre réellement couverte par les données token
    const allFirstSeenTs = merged
      .map((row) => row.firstSeenTs)
      .filter((ts): ts is number => ts !== null && ts > 0);
    const allLastSeenTs = merged
      .map((row) => row.lastSeenTs)
      .filter((ts): ts is number => ts !== null && ts > 0);
    const dataFromTs = allFirstSeenTs.length > 0 ? Math.min(...allFirstSeenTs) : 0;
    const dataToTs = allLastSeenTs.length > 0 ? Math.max(...allLastSeenTs) : nowSec;

    // Accrued restreint à la fenêtre où on a des données
    const billingWithData =
      dataFromTs > 0
        ? computeBillingCost(settings.data?.billingHistory, source, dataFromTs, dataToTs, nowSec)
        : null;
    const accruedWithDataEur = billingWithData ? billingWithData.accrued.total : accruedEur;

    const usedEur = Math.min(totalRealEur, accruedWithDataEur);
    const idleWithDataEur = Math.max(0, accruedWithDataEur - usedEur);
    const noDataEur = Math.max(0, accruedEur - accruedWithDataEur);
    // Prepaid now computed per-charge inside computeBillingCost (tail after
    // asOfTs, restricted to charges debited in the window). Previous
    // `cash − accrued` leaked pre-window charges' tail-accrual and
    // under-stated prepaid whenever an older charge was still running at
    // the start of the window.
    const prepaidEur = billing.prepaid.total;

    // Dénominateur "utilisation effective" : jours mesurables uniquement
    const measurableEur = usedEur + idleWithDataEur;
    const usedPct = measurableEur > 0 ? (usedEur / measurableEur) * 100 : 0;
    const unusedPct = measurableEur > 0 ? (idleWithDataEur / measurableEur) * 100 : 0;

    // Dénominateur "complet" pour affichage contextuel
    const denominatorEur = Math.max(cashEur, accruedEur);
    const unusedEur = Math.max(0, denominatorEur - usedEur);

    // Distribution dev par projet (non-agrégée) : utile pour montrer la dispersion
    // dans la carte "Moyenne par projet" plutôt que la seule moyenne.
    const activeDevEurs = costed
      .filter((e) => e.effort.midEur > 0)
      .map((e) => e.effort.midEur)
      .sort((a, b) => a - b);
    const projectDevDistribution = {
      min: activeDevEurs[0] ?? 0,
      median:
        activeDevEurs.length > 0
          ? activeDevEurs.length % 2 === 1
            ? activeDevEurs[Math.floor(activeDevEurs.length / 2)]
            : (activeDevEurs[activeDevEurs.length / 2 - 1] +
                activeDevEurs[activeDevEurs.length / 2]) /
              2
          : 0,
      max: activeDevEurs[activeDevEurs.length - 1] ?? 0,
      count: activeDevEurs.length,
    };

    // Projet avec le leverage dev/abo le plus fort (min d'abo > 1€ pour éviter div/0)
    const topLeverageProject =
      [...costed]
        .filter((e) => e.realEur > 1 && e.effort.midEur > 0)
        .sort((a, b) => b.effort.midEur / b.realEur - a.effort.midEur / a.realEur)[0] ?? null;

    // Cache hit rate : ratio des tokens de contexte venant du cache vs fraîchement ingérés.
    // input_tokens = input net (non-caché) · cache_read = lecture cache (économie)
    // · cache_create = écriture cache (investissement). Hit rate élevé = stratégie
    // de caching efficace (itérations sur mêmes fichiers, prompts stables).
    const totalInputNet = merged.reduce((acc, r) => acc + r.inputTokens, 0);
    const totalCacheRead = merged.reduce((acc, r) => acc + r.cacheRead, 0);
    const totalCacheCreate = merged.reduce((acc, r) => acc + r.cacheCreate, 0);
    const cacheContextTotal = totalInputNet + totalCacheRead + totalCacheCreate;
    const cacheHitRate = cacheContextTotal > 0 ? (totalCacheRead / cacheContextTotal) * 100 : 0;

    const n = activeProjects || 1;
    return {
      totalTokens,
      totalOutputTokens,
      totalMessages,
      totalSessions,
      activeProjects,
      totalCostEur,
      totalRealEur,
      billing,
      paygVsSubLeverage,
      paygSavingsEur,
      totalDevEur,
      totalDevHours,
      totalDevLowEur,
      totalDevHighEur,
      devLeverageVsPayg,
      devLeverageVsAbo,
      denominatorEur,
      accruedEur,
      accruedWithDataEur,
      measurableEur,
      cashEur,
      unusedEur,
      usedEur,
      idleWithDataEur,
      noDataEur,
      prepaidEur,
      unusedPct,
      usedPct,
      dataFromTs,
      dataToTs,
      totalInputNet,
      totalCacheRead,
      totalCacheCreate,
      cacheContextTotal,
      cacheHitRate,
      avgDevPerProject: totalDevEur / n,
      avgPaygPerProject: totalCostEur / n,
      avgRealPerProject: totalRealEur / n,
      avgDevHoursPerProject: totalDevHours / n,
      projectDevDistribution,
      topLeverageProject,
    };
  }, [merged, costed, source, period, settings.data]);

  const maxRealCost = sorted[0]?.realEur || 0;
  const maxTokens = sorted[0]?.row.totalTokens || 1;
  const barBasis = sortBy === 'cost' ? maxRealCost || 1 : maxTokens;
  const visible = sorted.slice(0, limit);
  const canExpand = sorted.length > limit;

  return (
    <Section
      title={t('usage.llmPerProject.title')}
      meta={
        <span>
          {period === '7'
            ? t('usage.llmPerProject.period7d')
            : period === '30'
              ? t('usage.llmPerProject.period30d')
              : period === '90'
                ? t('usage.llmPerProject.period90d')
                : t('usage.llmPerProject.periodAll')}
          {' · '}
          {source === 'combined' ? 'Claude + Codex' : source === 'claude' ? 'Claude' : 'Codex'}
        </span>
      }
      action={
        <Button tone="ghost" onClick={reloadAll} disabled={loading}>
          {loading ? t('common.loading') : t('common.refresh')}
        </Button>
      }
    >
      <Card>
        <Toolbar>
          <Segmented<Source>
            value={source}
            options={[
              { value: 'combined', label: t('usage.sources.combined') },
              { value: 'claude', label: t('usage.sources.claude') },
              { value: 'codex', label: t('usage.sources.codex') },
            ]}
            onChange={setSource}
          />
          <Segmented<Period>
            value={period}
            options={[
              { value: '7', label: t('common.daysAgo', { n: 7 }) },
              { value: '30', label: t('common.daysAgo', { n: 30 }) },
              { value: '90', label: t('common.daysAgo', { n: 90 }) },
              { value: 'all', label: t('common.allTime') },
            ]}
            onChange={setPeriod}
          />
          <div className="ml-auto flex items-center gap-2">
            <label
              htmlFor="usage-sort-by"
              className="text-[11px] uppercase tracking-[0.08em] text-[var(--text-dim)]"
            >
              {t('usage.llmPerProject.sortLabel')}
            </label>
            <select
              id="usage-sort-by"
              value={sortBy}
              onChange={(event) => setSortBy(event.target.value as SortKey)}
            >
              <option value="tokens">{t('usage.llmPerProject.sortTokens')}</option>
              <option value="cost">{t('usage.llmPerProject.sortCost')}</option>
              <option value="messages">{t('usage.llmPerProject.sortMessages')}</option>
              <option value="sessions">{t('usage.llmPerProject.sortSessions')}</option>
              <option value="recent">{t('usage.llmPerProject.sortRecent')}</option>
            </select>
          </div>
        </Toolbar>
      </Card>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <SubscriptionVsPaygStat
          source={source}
          periodDays={periodToDays(period)}
          billing={kpis.billing}
          paygEur={kpis.totalCostEur}
          usedEur={kpis.usedEur}
          idleWithDataEur={kpis.idleWithDataEur}
          noDataEur={kpis.noDataEur}
          prepaidEur={kpis.prepaidEur}
          denominatorEur={kpis.denominatorEur}
          measurableEur={kpis.measurableEur}
          usedPct={kpis.usedPct}
          unusedPct={kpis.unusedPct}
          dataFromTs={kpis.dataFromTs}
          dataToTs={kpis.dataToTs}
          totalTokens={kpis.totalTokens}
          totalOutputTokens={kpis.totalOutputTokens}
        />
        <AvgPerProjectStat
          avgDevEur={kpis.avgDevPerProject}
          avgPaygEur={kpis.avgPaygPerProject}
          avgRealEur={kpis.avgRealPerProject}
          avgDevHours={kpis.avgDevHoursPerProject}
          activeProjects={kpis.activeProjects}
          hourlyRateEur={devParams.hourlyRateEur ?? DEV_HOURLY_RATE_EUR}
          devDistribution={kpis.projectDevDistribution}
          topLeverageProject={kpis.topLeverageProject}
        />
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Stat
          label={t('usage.llmPerProject.stats.equivDev')}
          value={formatEur(kpis.totalDevEur, locale)}
          hint={t('usage.llmPerProject.stats.equivDevHint', {
            low: formatEur(kpis.totalDevLowEur, locale),
            high: formatEur(kpis.totalDevHighEur, locale),
            hours: formatHours(kpis.totalDevHours, locale),
          })}
          tone="success"
        />
        <Stat
          label={t('usage.llmPerProject.stats.devLeverage')}
          value={kpis.devLeverageVsAbo > 0 ? `×${kpis.devLeverageVsAbo.toFixed(1)}` : '—'}
          hint={t('usage.llmPerProject.stats.devLeverageHint', {
            n: kpis.devLeverageVsPayg.toFixed(1),
          })}
        />
        <Stat
          label={t('usage.llmPerProject.stats.aboUnused')}
          value={kpis.measurableEur > 0 ? `${kpis.unusedPct.toFixed(0)}%` : '—'}
          hint={
            kpis.measurableEur > 0
              ? t('usage.llmPerProject.stats.aboUnusedHint', {
                  idle: formatEur(kpis.idleWithDataEur, locale),
                  measurable: formatEur(kpis.measurableEur, locale),
                  used: kpis.usedPct.toFixed(0),
                  extra: `${
                    kpis.noDataEur > 0.01
                      ? t('usage.llmPerProject.stats.aboUnusedExtraNoData', {
                          amount: formatEur(kpis.noDataEur, locale),
                        })
                      : ''
                  }${
                    kpis.prepaidEur > 0.01
                      ? t('usage.llmPerProject.stats.aboUnusedExtraPrepaid', {
                          amount: formatEur(kpis.prepaidEur, locale),
                        })
                      : ''
                  }`,
                })
              : t('usage.llmPerProject.stats.aboUnusedNoTokens')
          }
          tone={
            kpis.measurableEur === 0
              ? 'neutral'
              : kpis.unusedPct >= 60
                ? 'danger'
                : kpis.unusedPct >= 30
                  ? 'warn'
                  : 'success'
          }
        />
        <Stat
          label={t('usage.llmPerProject.stats.tokens')}
          value={formatTokens(kpis.totalTokens)}
          hint={t('usage.llmPerProject.stats.tokensOutputHint', {
            amount: formatTokens(kpis.totalOutputTokens),
          })}
        />
        <Stat
          label={t('usage.llmPerProject.stats.activeProjects')}
          value={String(kpis.activeProjects)}
          hint={t('usage.llmPerProject.stats.activeProjectsHint', {
            scanned: projects.length,
            usd: (1 / USD_TO_EUR).toFixed(2),
          })}
        />
        <Stat
          label={t('usage.llmPerProject.stats.cacheHit')}
          value={kpis.cacheContextTotal > 0 ? `${kpis.cacheHitRate.toFixed(0)}%` : '—'}
          hint={
            kpis.cacheContextTotal > 0
              ? t('usage.llmPerProject.stats.cacheHitHint', {
                  reused: formatTokens(kpis.totalCacheRead),
                  fresh: formatTokens(kpis.totalInputNet),
                  created: formatTokens(kpis.totalCacheCreate),
                })
              : t('usage.llmPerProject.stats.cacheHitNoData')
          }
          tone={
            kpis.cacheContextTotal === 0
              ? 'neutral'
              : kpis.cacheHitRate >= 70
                ? 'success'
                : kpis.cacheHitRate >= 40
                  ? 'accent'
                  : 'warn'
          }
        />
      </div>

      {errorMessage ? <ErrorState message={errorMessage} onRetry={reloadAll} /> : null}

      <div className="flex flex-col gap-2" aria-busy={loading}>
        {loading && merged.length === 0 ? (
          <SkeletonList rows={6} rowClassName="h-16 rounded-[var(--radius)]" />
        ) : null}

        {!loading && merged.length === 0 ? (
          <EmptyState
            title={t('usage.llmPerProject.emptyTitle')}
            description={t('usage.llmPerProject.emptyDesc')}
          />
        ) : null}

        {visible.map(({ row, cost, realEur, claudeShare, codexShare, leverage, effort }) => (
          <UsageRow
            key={row.key}
            row={row}
            cost={cost}
            devParams={devParams}
            realEur={realEur}
            claudeShare={claudeShare}
            codexShare={codexShare}
            leverage={leverage}
            effort={effort}
            maxBasis={barBasis}
            sortBy={sortBy}
            expanded={expanded === row.key}
            onToggle={() => setExpanded(expanded === row.key ? null : row.key)}
          />
        ))}

        {canExpand ? (
          <div className="flex justify-center pt-1">
            <Button tone="ghost" onClick={() => setLimit((l) => l + 10)}>
              {t('usage.llmPerProject.seeMore', { n: sorted.length - limit })}
            </Button>
          </div>
        ) : null}
      </div>
    </Section>
  );
}

type UsageRowProps = {
  row: MergedRow;
  cost: CostBreakdown;
  devParams: { hourlyRateEur?: number; outputTokensPerHour?: number };
  realEur: number;
  claudeShare: number;
  codexShare: number;
  leverage: number;
  effort: DevEffortEstimate;
  maxBasis: number;
  sortBy: SortKey;
  expanded: boolean;
  onToggle: () => void;
};

const UsageRow = memo(function UsageRow({
  row,
  cost,
  devParams,
  realEur,
  claudeShare,
  codexShare,
  leverage,
  effort,
  maxBasis,
  sortBy,
  expanded,
  onToggle,
}: UsageRowProps) {
  const { t, locale } = useTranslation();
  const rateEur = devParams.hourlyRateEur ?? DEV_HOURLY_RATE_EUR;
  const devEur = effort.midEur;
  const devHours = effort.midHours;
  const basis = sortBy === 'cost' ? realEur : row.totalTokens;
  const pct = Math.min(100, Math.max(1.5, (basis / (maxBasis || 1)) * 100));
  const headerId = `usage-row-${row.key.replace(/[^a-z0-9]+/gi, '-')}`;
  const hasClaude = row.claudeTokens > 0;
  const hasCodex = row.codexTokens > 0;
  const cachePct = Math.round((row.cacheReuseRatio || 0) * 100);
  const savedEur = cost.totalEur - realEur;

  return (
    <div className="card-tight !p-0 overflow-hidden">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        aria-controls={`${headerId}-detail`}
        className="w-full px-3 py-2 text-left"
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="truncate text-[14px] font-medium text-[var(--text)]" id={headerId}>
                {row.projectName}
              </span>
              {hasClaude ? <Chip tone="accent">Claude</Chip> : null}
              {hasCodex ? <Chip tone="warn">Codex</Chip> : null}
              {row.topModel ? (
                <span className="text-[11px] text-[var(--text-dim)]">{row.topModel}</span>
              ) : null}
            </div>
            <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[11px] text-[var(--text-dim)]">
              {row.projectPath ? (
                <span className="truncate max-w-[260px]">{row.projectPath}</span>
              ) : null}
              <span>·</span>
              <span>{relativeTime(row.lastTs, t)}</span>
              {cachePct > 0 ? (
                <>
                  <span>·</span>
                  <span>cache {cachePct}%</span>
                </>
              ) : null}
            </div>
          </div>

          <div className="flex items-center gap-3 text-right text-[12px] text-[var(--text-mute)]">
            <div className="min-w-[56px]">
              <div className="text-[10px] uppercase tracking-[0.08em] text-[var(--text-dim)]">
                Msg
              </div>
              <div className="num text-[12px] text-[var(--text)]">{formatCount(row.messages)}</div>
            </div>
            <div className="min-w-[64px]">
              <div className="text-[10px] uppercase tracking-[0.08em] text-[var(--text-dim)]">
                Tokens
              </div>
              <div className="num text-[12px] text-[var(--text)]">
                {formatTokens(row.totalTokens)}
              </div>
            </div>
            <div
              className="min-w-[88px] border-l border-[var(--border)] pl-3"
              title={`${t('projects.detail.costs.devEquiv')}: ${formatEur(devEur, locale)} (${t('projects.detail.costs.devEquivHintRange', { low: formatEur(effort.lowEur, locale), high: formatEur(effort.highEur, locale) })})`}
            >
              <div className="text-[10px] uppercase tracking-[0.08em] text-[var(--text-dim)]">
                {t('usage.llmPerProject.avgPerProject.barDev')}
              </div>
              <div className="num text-[14px] font-semibold text-[#30d158]">
                {formatEur(devEur, locale)}
              </div>
              <div className="num text-[10px] text-[var(--text-dim)]">
                {formatHours(devHours, locale)}
              </div>
            </div>
            <div className="min-w-[88px]">
              <div className="text-[10px] uppercase tracking-[0.08em] text-[var(--text-dim)]">
                {t('usage.llmPerProject.rowApiLabel')}
              </div>
              <div className="num text-[14px] font-semibold text-[#64d2ff]">
                {formatEur(cost.totalEur, locale)}
              </div>
              <div className="num text-[10px] text-[var(--text-dim)]">
                {t('usage.llmPerProject.apiPaygSub')}
              </div>
            </div>
            <div className="min-w-[88px]">
              <div className="text-[10px] uppercase tracking-[0.08em] text-[var(--text-dim)]">
                {t('usage.llmPerProject.rowAboLabel')}
              </div>
              <div className="num text-[14px] font-semibold text-[var(--text)]">
                {formatEur(realEur, locale)}
              </div>
              <div className="num text-[10px] text-[var(--text-dim)]">
                {t('usage.llmPerProject.realAboSub')}
              </div>
            </div>
          </div>
        </div>

        <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-[var(--surface-2)]">
          <div
            className="h-full rounded-full transition-[width] duration-300"
            style={{
              width: `${pct}%`,
              background:
                hasClaude && hasCodex
                  ? 'linear-gradient(90deg, var(--accent) 0%, var(--warn) 100%)'
                  : hasCodex
                    ? 'var(--warn)'
                    : 'var(--accent)',
            }}
            aria-label={`${formatCount(row.totalTokens)} tokens`}
          />
        </div>
      </button>

      {expanded ? (
        <div
          id={`${headerId}-detail`}
          className="border-t border-[var(--border)] bg-[var(--surface-2)] px-3 py-3"
        >
          {/* ─── Synthèse économique ─── */}
          <div className="mb-3">
            <div className="mb-1.5 text-[10px] uppercase tracking-[0.08em] text-[var(--text-dim)]">
              {t('usage.llmPerProject.synthesis')}
            </div>
            <div className="grid grid-cols-2 gap-2 rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-1)] px-3 py-2 md:grid-cols-5">
              <ExpandKV
                label={t('projects.detail.costs.realAbo')}
                value={formatEur(realEur, locale)}
                hint={t('usage.llmPerProject.expandCosts.realAboHint')}
                accent="text-[var(--text)]"
              />
              <ExpandKV
                label={t('projects.detail.costs.devEquiv')}
                value={formatEur(devEur, locale)}
                hint={`${t('projects.detail.costs.devEquivHintRange', {
                  low: formatEur(effort.lowEur, locale),
                  high: formatEur(effort.highEur, locale),
                })} · ${formatHours(devHours, locale)}`}
                accent="text-[#30d158]"
              />
              <ExpandKV
                label={t('projects.detail.costs.apiPayg')}
                value={formatEur(cost.totalEur, locale)}
                hint={t('usage.llmPerProject.expandCosts.apiPerMtok', {
                  amount: formatEur(cost.costPerMillionTokensEur, locale),
                })}
                accent="text-[#64d2ff]"
              />
              <ExpandKV
                label={t('projects.detail.costs.savingsVsPayg')}
                value={
                  savedEur >= 0
                    ? formatEur(savedEur, locale)
                    : `-${formatEur(Math.abs(savedEur), locale)}`
                }
                hint={
                  leverage > 0
                    ? t('projects.detail.costs.savingsHint', { n: leverage.toFixed(1) })
                    : '—'
                }
                accent={savedEur >= 0 ? 'text-[#30d158]' : 'text-[#ff453a]'}
              />
              <ExpandKV
                label={t('projects.detail.costs.leverageVsDev')}
                value={realEur > 0.001 ? `×${(devEur / realEur).toFixed(1)}` : '—'}
                hint={t('usage.llmPerProject.expandCosts.leverageVsDevHint')}
                accent="text-[var(--text-mute)]"
              />
            </div>
          </div>

          {/* ─── Activité projet ─── */}
          <div className="mb-3">
            <div className="mb-1.5 text-[10px] uppercase tracking-[0.08em] text-[var(--text-dim)]">
              {t('usage.llmPerProject.activitySection')}
            </div>
            <div className="grid grid-cols-2 gap-2 rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-1)] px-3 py-2 md:grid-cols-5">
              <ExpandKV
                label={t('usage.llmPerProject.expandActivity.firstSeen')}
                value={formatTimestampDate(row.firstSeenTs)}
                hint={row.firstSeenTs ? relativeTime(row.firstSeenTs, t) : '—'}
                accent="text-[var(--text)]"
              />
              <ExpandKV
                label={t('usage.llmPerProject.expandActivity.lastSeen')}
                value={formatTimestampDate(row.lastSeenTs)}
                hint={row.lastSeenTs ? relativeTime(row.lastSeenTs, t) : '—'}
                accent="text-[var(--text)]"
              />
              <ExpandKV
                label={t('usage.llmPerProject.expandActivity.activeDays')}
                value={String(row.activeDays || 0)}
                hint={t('usage.llmPerProject.expandActivity.activeDaysHint')}
                accent="text-[var(--text)]"
              />
              <ExpandKV
                label={t('usage.llmPerProject.expandActivity.tokensPerDay')}
                value={
                  row.activeDays > 0
                    ? formatTokens(Math.round(row.totalTokens / row.activeDays))
                    : '—'
                }
                hint={t('usage.llmPerProject.expandActivity.tokensPerDayHint')}
                accent="text-[var(--text-mute)]"
              />
              <ExpandKV
                label={t('usage.llmPerProject.expandActivity.aboPerActiveDay')}
                value={row.activeDays > 0 ? formatEur(realEur / row.activeDays, locale) : '—'}
                hint={t('usage.llmPerProject.expandActivity.aboPerActiveDayHint')}
                accent="text-[var(--text-mute)]"
              />
            </div>
          </div>

          {/* ─── Détail estimation dev (3 estimateurs indépendants + clamp) ─── */}
          <div className="mb-3">
            <div className="mb-1.5 flex items-baseline justify-between">
              <span className="text-[10px] uppercase tracking-[0.08em] text-[var(--text-dim)]">
                {t('usage.llmPerProject.estimation.title')}
              </span>
              <span className="text-[10px] text-[var(--text-dim)]">
                {effort.calendarCap.applied
                  ? t('usage.llmPerProject.estimation.medianKeptClamped')
                  : t('usage.llmPerProject.estimation.medianKept')}
              </span>
            </div>
            <div className="grid grid-cols-1 gap-2 rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-1)] px-3 py-2 md:grid-cols-3">
              <div className="flex flex-col">
                <span className="text-[10px] uppercase tracking-[0.08em] text-[var(--text-dim)]">
                  {t('usage.llmPerProject.estimation.volume')}
                </span>
                <span className="num text-[14px] font-semibold text-[var(--text)]">
                  {formatEur(effort.tokenBased.eur, locale)}
                </span>
                <span className="text-[10px] text-[var(--text-dim)]">
                  {formatHours(effort.tokenBased.hours, locale)} · ~
                  {formatCount(Math.round(effort.tokenBased.estimatedLoc))} LoC
                </span>
                <span className="text-[10px] text-[var(--text-dim)]">
                  {effort.tokenBased.effectiveCodeRatio < effort.params.codeRatio ? (
                    <span className="text-[#ffd60a]">
                      {t('usage.llmPerProject.estimation.volumeDamped', {
                        effective: Math.round(effort.tokenBased.effectiveCodeRatio * 100),
                        base: Math.round(effort.params.codeRatio * 100),
                        cache: Math.round(effort.tokenBased.cacheHitShare * 100),
                        tok: effort.params.tokensPerLoc,
                        loc: effort.params.locPerHour,
                      })}
                    </span>
                  ) : (
                    t('usage.llmPerProject.estimation.volumeFormula', {
                      pct: Math.round(effort.tokenBased.effectiveCodeRatio * 100),
                      tok: effort.params.tokensPerLoc,
                      loc: effort.params.locPerHour,
                    })
                  )}
                </span>
              </div>
              <div className="flex flex-col">
                <span className="text-[10px] uppercase tracking-[0.08em] text-[var(--text-dim)]">
                  {t('usage.llmPerProject.estimation.intensity')}
                </span>
                <span className="num text-[14px] font-semibold text-[var(--text)]">
                  {formatEur(effort.activityBased.eur, locale)}
                </span>
                <span className="text-[10px] text-[var(--text-dim)]">
                  {formatHours(effort.activityBased.hours, locale)} ·{' '}
                  {t('usage.llmPerProject.estimation.intensityHint')}
                </span>
                <span className="text-[10px] text-[var(--text-dim)]">
                  {t('usage.llmPerProject.estimation.intensityDetail', {
                    sess: row.sessions,
                    sessHours: effort.params.hoursPerSession,
                    sessTotal: formatHours(effort.activityBased.sessionsHours, locale),
                    msg: formatCount(row.messages),
                    min: effort.params.minutesPerMessage,
                    msgTotal: formatHours(effort.activityBased.messagesHours, locale),
                  })}
                </span>
              </div>
              <div className="flex flex-col">
                <span className="text-[10px] uppercase tracking-[0.08em] text-[var(--text-dim)]">
                  {t('usage.llmPerProject.estimation.calendar')}
                </span>
                <span className="num text-[14px] font-semibold text-[var(--text)]">
                  {formatEur(effort.calendarBased.eur, locale)}
                </span>
                <span className="text-[10px] text-[var(--text-dim)]">
                  {formatHours(effort.calendarBased.hours, locale)} ·{' '}
                  {t('usage.llmPerProject.estimation.calendarDays', {
                    days: effort.calendarBased.activeDays,
                  })}
                </span>
                <span className="text-[10px] text-[var(--text-dim)]">
                  {t('usage.llmPerProject.estimation.calendarFormula', {
                    h: effort.params.hoursPerActiveDay,
                  })}
                </span>
              </div>
            </div>
            {effort.calendarCap.applied ? (
              <div className="mt-1 text-[10px] text-[#ffd60a]">
                {t('usage.llmPerProject.estimation.clampWarning', {
                  cap: formatHours(effort.calendarCap.capHours, locale),
                  days: effort.calendarBased.activeDays,
                  max: effort.params.maxHoursPerDay,
                  midDetail:
                    effort.calendarCap.midCappedFrom !== null
                      ? t('usage.llmPerProject.estimation.clampMidDetail', {
                          from: formatHours(effort.calendarCap.midCappedFrom, locale),
                          to: formatHours(effort.midHours, locale),
                        })
                      : '',
                })}
              </div>
            ) : null}
          </div>

          {/* ─── Breakdown tokens (API list prices) ─── */}
          <div>
            <div className="mb-1.5 flex items-baseline justify-between">
              <span className="text-[10px] uppercase tracking-[0.08em] text-[var(--text-dim)]">
                {t('usage.llmPerProject.breakdownMeta')}
              </span>
              <span className="text-[10px] text-[var(--text-dim)]">
                in {formatEurPerMillion(cost.blendedInputPer1M * USD_TO_EUR, locale)} · out{' '}
                {formatEurPerMillion(cost.blendedOutputPer1M * USD_TO_EUR, locale)}
              </span>
            </div>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <CostKV
                label={t('usage.llmPerProject.breakdown.input')}
                tokens={row.inputTokens}
                eur={cost.inputEur}
                accent="text-[var(--text)]"
              />
              <CostKV
                label={t('usage.llmPerProject.breakdown.output')}
                tokens={row.outputTokens}
                eur={cost.outputEur}
                accent="text-[#64d2ff]"
              />
              <CostKV
                label={t('usage.llmPerProject.breakdown.cacheRead')}
                tokens={row.cacheRead}
                eur={cost.cacheReadEur}
                accent="text-[#30d158]"
                sub={`cache ${cachePct}%`}
              />
              <CostKV
                label={t('usage.llmPerProject.breakdown.cacheWrite')}
                tokens={row.cacheCreate}
                eur={cost.cacheWriteEur}
                accent="text-[var(--text-mute)]"
              />
            </div>
          </div>

          {row.models.length > 0 ? (
            <div className="mt-3">
              <div className="mb-1.5 text-[11px] uppercase tracking-[0.08em] text-[var(--text-dim)]">
                {t('usage.llmPerProject.modelsSection')}
              </div>
              <div className="flex flex-wrap gap-1.5">
                {row.models.slice(0, 6).map((m, idx) => (
                  <Chip
                    key={`${m.source}-${m.model}-${idx}`}
                    tone={m.source === 'claude' ? 'accent' : 'warn'}
                    title={`${formatCount(m.tokens)} tokens · ${formatCount(m.messages)} msg`}
                  >
                    {m.model}
                    <span className="text-[var(--text-dim)]">{formatTokens(m.tokens)}</span>
                  </Chip>
                ))}
              </div>
            </div>
          ) : null}

          {row.tools.length > 0 ? (
            <div className="mt-3">
              <div className="mb-1.5 text-[11px] uppercase tracking-[0.08em] text-[var(--text-dim)]">
                {t('usage.llmPerProject.topTools')}
              </div>
              <div className="flex flex-wrap gap-1.5">
                {row.tools.slice(0, 10).map((tool, idx) => (
                  <Chip
                    key={`${tool.source}-${tool.name}-${idx}`}
                    title={`${formatCount(tool.count)} (${tool.source})`}
                  >
                    {tool.name}
                    <span className="text-[var(--text-dim)]">{formatCount(tool.count)}</span>
                  </Chip>
                ))}
              </div>
            </div>
          ) : null}

          <div className="mt-3 flex flex-wrap gap-2">
            {row.projectId ? (
              <Link to={`/projects/${row.projectId}`}>
                <Button tone="ghost">{t('usage.row.openProject')}</Button>
              </Link>
            ) : null}
            {row.projectId ? (
              <Link to={`/agent?projectId=${row.projectId}`}>
                <Button tone="ghost">{t('usage.row.launchAgent')}</Button>
              </Link>
            ) : null}
            <Link to={`/usage?project=${encodeURIComponent(row.projectPath || row.projectName)}`}>
              <Button tone="ghost">{t('usage.row.usageDetails')}</Button>
            </Link>
          </div>
        </div>
      ) : null}
    </div>
  );
});

function CostKV({
  label,
  tokens,
  eur,
  accent,
  sub,
}: {
  label: string;
  tokens: number;
  eur: number;
  accent: string;
  sub?: string;
}) {
  const { locale } = useTranslation();
  return (
    <div className="flex flex-col gap-0.5 rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-1)] px-3 py-2">
      <div className="text-[10px] uppercase tracking-[0.08em] text-[var(--text-dim)]">{label}</div>
      <div className={`num text-[14px] font-semibold ${accent}`.trim()}>
        {formatEur(eur, locale)}
      </div>
      <div className="num text-[11px] text-[var(--text-mute)]">{formatTokens(tokens)} tok</div>
      {sub ? <div className="text-[10px] text-[var(--text-dim)]">{sub}</div> : null}
    </div>
  );
}

function ExpandKV({
  label,
  value,
  hint,
  accent,
}: {
  label: string;
  value: string;
  hint?: string;
  accent: string;
}) {
  return (
    <div className="flex flex-col">
      <span className="text-[10px] uppercase tracking-[0.08em] text-[var(--text-dim)]">
        {label}
      </span>
      <span className={`num text-[16px] font-semibold ${accent}`.trim()}>{value}</span>
      {hint ? <span className="text-[10px] text-[var(--text-dim)]">{hint}</span> : null}
    </div>
  );
}

function formatTimestampDate(ts: number | null | undefined): string {
  if (!ts) {
    return '—';
  }
  return new Date(ts * 1000).toLocaleDateString(dateLocale(currentLocale()), {
    day: '2-digit',
    month: 'short',
    year: '2-digit',
  });
}

function SubscriptionVsPaygStat({
  source,
  periodDays,
  billing,
  paygEur,
  usedEur,
  idleWithDataEur,
  noDataEur,
  prepaidEur,
  denominatorEur,
  measurableEur,
  usedPct,
  unusedPct,
  dataFromTs,
  dataToTs,
  totalTokens,
  totalOutputTokens,
}: {
  source: Source;
  periodDays: number;
  billing: {
    total: number;
    claude: number;
    codex: number;
    accrued: { total: number; claude: number; codex: number };
    prepaid: { total: number; claude: number; codex: number };
    activeDaily: { total: number; claude: number; codex: number };
    activeMonthly: { total: number; claude: number; codex: number };
  };
  paygEur: number;
  usedEur: number;
  idleWithDataEur: number;
  noDataEur: number;
  prepaidEur: number;
  denominatorEur: number;
  measurableEur: number;
  usedPct: number;
  unusedPct: number;
  dataFromTs: number;
  dataToTs: number;
  totalTokens: number;
  totalOutputTokens: number;
}) {
  const { t, locale } = useTranslation();
  // "Ce que tu payes" = cumul réel facturé sur la période sélectionnée (depuis billingHistory).
  const subscriptionPeriod = billing.total;
  const paygPeriod = paygEur;
  const leverage = subscriptionPeriod > 0 ? paygPeriod / subscriptionPeriod : 0;
  const savings = paygPeriod - subscriptionPeriod;

  const hintParts: string[] = [];
  if (source !== 'codex' && billing.claude > 0) {
    hintParts.push(`Claude ${formatEur(billing.claude, locale)}`);
  }
  if (source !== 'claude' && billing.codex > 0) {
    hintParts.push(`Codex ${formatEur(billing.codex, locale)}`);
  }
  // Active-rate hint: show €/day directly from the current charge's
  // amount÷coverageDays. Previous version divided an "€/mo scaled to 30d"
  // synthetic (220 × 30 / 32 = 206) which misrepresented the actual €220
  // cycle cost and was confusing.
  const activeParts: string[] = [];
  if (source !== 'codex' && billing.activeDaily.claude > 0) {
    activeParts.push(`Claude ${formatEur(billing.activeDaily.claude, locale)}/j`);
  }
  if (source !== 'claude' && billing.activeDaily.codex > 0) {
    activeParts.push(`Codex ${formatEur(billing.activeDaily.codex, locale)}/j`);
  }
  const activeLabel =
    activeParts.length > 0
      ? t('usage.llmPerProject.subVsPayg.activeLabel', { parts: activeParts.join(' + ') })
      : '';
  const hint = `${hintParts.join(' + ') || t('usage.llmPerProject.subVsPayg.noChargeOnWindow')}${activeLabel}`;

  const leverageTone =
    leverage >= 2 ? 'text-[#30d158]' : leverage >= 1 ? 'text-[#ffd60a]' : 'text-[#ff453a]';
  const savingsPositive = savings >= 0;

  return (
    <div className="stat flex flex-col">
      <div className="stat-label">
        {t('usage.llmPerProject.subVsPayg.title', {
          window: periodDays >= 365 ? t('common.allTime') : t('common.daysAgo', { n: periodDays }),
        })}
      </div>
      <div className="mt-1 flex items-end gap-4">
        <div className="flex flex-col">
          <span className="text-[10px] uppercase tracking-[0.08em] text-[var(--text-dim)]">
            {t('usage.llmPerProject.subVsPayg.paid')}
          </span>
          <span className="num text-[22px] font-semibold text-[var(--text)]">
            {formatEur(subscriptionPeriod, locale)}
          </span>
        </div>
        <span className="pb-1 text-[16px] text-[var(--text-dim)]">{t('common.vs')}</span>
        <div className="flex flex-col">
          <span className="text-[10px] uppercase tracking-[0.08em] text-[var(--text-dim)]">
            {t('usage.llmPerProject.subVsPayg.payg')}
          </span>
          <span className="num text-[22px] font-semibold text-[#64d2ff]">
            {formatEur(paygPeriod, locale)}
          </span>
        </div>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-[var(--text-mute)]">
        <span className={`num font-medium ${leverageTone}`.trim()}>
          {leverage > 0
            ? t('usage.llmPerProject.subVsPayg.leverage', { n: leverage.toFixed(1) })
            : t('usage.llmPerProject.subVsPayg.noLeverage')}
        </span>
        <span className="text-[var(--text-dim)]">·</span>
        <span className={savingsPositive ? 'text-[#30d158]' : 'text-[#ff453a]'}>
          {savingsPositive
            ? t('usage.llmPerProject.subVsPayg.economy', { amount: formatEur(savings, locale) })
            : t('usage.llmPerProject.subVsPayg.overcost', {
                amount: formatEur(Math.abs(savings), locale),
              })}
        </span>
      </div>
      {denominatorEur > 0 ? (
        <div className="mt-2 flex flex-col gap-1">
          <div
            className="flex h-1.5 w-full overflow-hidden rounded-full bg-[rgba(255,255,255,0.05)]"
            role="img"
            aria-label={t('usage.llmPerProject.subVsPayg.effectiveUseAria', {
              pct: usedPct.toFixed(0),
            })}
          >
            <span
              className="h-full"
              style={{
                width: `${(usedEur / denominatorEur) * 100}%`,
                backgroundColor: '#30d158',
              }}
              title={`${t('usage.llmPerProject.subVsPayg.used')} · ${formatEur(usedEur, locale)}`}
            />
            <span
              className="h-full"
              style={{
                width: `${(idleWithDataEur / denominatorEur) * 100}%`,
                backgroundColor: 'rgba(255,149,0,0.55)',
              }}
              title={`${t('usage.llmPerProject.subVsPayg.idle')} · ${formatEur(idleWithDataEur, locale)}`}
            />
            <span
              className="h-full"
              style={{
                width: `${(noDataEur / denominatorEur) * 100}%`,
                backgroundColor: 'rgba(142,142,147,0.45)',
              }}
              title={`${t('usage.llmPerProject.subVsPayg.noData')} · ${formatEur(noDataEur, locale)}`}
            />
            <span
              className="h-full"
              style={{
                width: `${(prepaidEur / denominatorEur) * 100}%`,
                backgroundColor: 'rgba(100,210,255,0.35)',
              }}
              title={`${t('usage.llmPerProject.subVsPayg.prepaidFuture')} · ${formatEur(prepaidEur, locale)}`}
            />
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[10.5px] text-[var(--text-mute)]">
            <span className="text-[#30d158]">
              {t('usage.llmPerProject.subVsPayg.used')}{' '}
              <span className="num">{formatEur(usedEur, locale)}</span>
            </span>
            {idleWithDataEur > 0.01 ? (
              <span className="text-[#ff9500]">
                {t('usage.llmPerProject.subVsPayg.idle')}{' '}
                <span className="num">{formatEur(idleWithDataEur, locale)}</span>
              </span>
            ) : null}
            {noDataEur > 0.01 ? (
              <span className="text-[#8e8e93]">
                {t('usage.llmPerProject.subVsPayg.noData')}{' '}
                <span className="num">{formatEur(noDataEur, locale)}</span>
              </span>
            ) : null}
            {prepaidEur > 0.01 ? (
              <span className="text-[#64d2ff]">
                {t('usage.llmPerProject.subVsPayg.prepaidFuture')}{' '}
                <span className="num">{formatEur(prepaidEur, locale)}</span>
              </span>
            ) : null}
            <span className="ml-auto">
              {measurableEur > 0
                ? t('usage.llmPerProject.subVsPayg.measurableNote', {
                    pct: usedPct.toFixed(0),
                    amount: formatEur(measurableEur, locale),
                  })
                : t('usage.llmPerProject.subVsPayg.noMeasurable')}
            </span>
          </div>
          {noDataEur > 0.01 && dataFromTs > 0 ? (
            <div className="text-[10px] text-[var(--text-faint)]">
              {t('usage.llmPerProject.subVsPayg.dbSince', {
                date: new Date(dataFromTs * 1000).toLocaleDateString(dateLocale(currentLocale()), {
                  day: '2-digit',
                  month: 'short',
                  year: '2-digit',
                }),
              })}
            </div>
          ) : null}
        </div>
      ) : null}

      {/* Prix effectifs : ramène les totaux à des unités "quotidien" / "par Mtok"
          pour donner une intuition stable hors fenêtre temporelle. */}
      {billing.activeDaily.total > 0 || paygEur > 0 ? (
        <div className="mt-3 grid grid-cols-3 gap-3 rounded-[var(--radius-sm)] bg-[rgba(255,255,255,0.02)] px-2.5 py-1.5">
          <MiniCost
            label={t('usage.llmPerProject.subVsPayg.aboPerDay')}
            // Canonical "ABO/JOUR" = €/day of the currently-active charge
            // (amount ÷ coverageDays, "newest wins" on overlap). No round-trip
            // through a 30d-normalized €/mo — that previously introduced a
            // coverage-dependent bias.
            value={
              billing.activeDaily.total > 0 ? formatEur(billing.activeDaily.total, locale) : '—'
            }
            hint={
              billing.activeDaily.total > 0
                ? t('usage.llmPerProject.subVsPayg.activeRateHint', {
                    amount: formatEur(billing.activeDaily.total * 30, locale),
                  })
                : t('usage.llmPerProject.subVsPayg.noActiveAbo')
            }
            color="var(--text)"
          />
          <MiniCost
            label={t('usage.llmPerProject.subVsPayg.paygPerDay')}
            value={paygEur > 0 && periodDays > 0 ? formatEur(paygEur / periodDays, locale) : '—'}
            hint={t('usage.llmPerProject.subVsPayg.onWindow', {
              window:
                periodDays >= 365 ? t('common.allTime') : t('common.daysAgo', { n: periodDays }),
            })}
            color="#64d2ff"
          />
          <MiniCost
            label={t('usage.llmPerProject.subVsPayg.perMtok')}
            value={totalTokens > 0 ? formatEur((paygEur / totalTokens) * 1_000_000, locale) : '—'}
            hint={
              totalOutputTokens > 0
                ? t('usage.llmPerProject.subVsPayg.perMtokOut', {
                    amount: formatEur((paygEur / totalOutputTokens) * 1_000_000, locale),
                  })
                : t('usage.llmPerProject.subVsPayg.blendedAllModels')
            }
            color="#ffd60a"
          />
        </div>
      ) : null}

      <div className="stat-hint">{hint}</div>
    </div>
  );
}

function MiniCost({
  label,
  value,
  hint,
  color,
}: {
  label: string;
  value: string;
  hint: string;
  color: string;
}) {
  return (
    <div className="flex flex-col">
      <span className="text-[9.5px] uppercase tracking-[0.08em] text-[var(--text-dim)]">
        {label}
      </span>
      <span className="num text-[14px] font-semibold" style={{ color }}>
        {value}
      </span>
      <span className="text-[9.5px] text-[var(--text-faint)]">{hint}</span>
    </div>
  );
}

function AvgPerProjectStat({
  avgDevEur,
  avgPaygEur,
  avgRealEur,
  avgDevHours,
  activeProjects,
  hourlyRateEur,
  devDistribution,
  topLeverageProject,
}: {
  avgDevEur: number;
  avgPaygEur: number;
  avgRealEur: number;
  avgDevHours: number;
  activeProjects: number;
  hourlyRateEur: number;
  devDistribution: { min: number; median: number; max: number; count: number };
  topLeverageProject: {
    row: { projectName: string; key: string };
    realEur: number;
    effort: { midEur: number };
  } | null;
}) {
  const { t, locale } = useTranslation();
  const devVsAbo = avgRealEur > 0.001 ? avgDevEur / avgRealEur : 0;
  const paygVsAbo = avgRealEur > 0.001 ? avgPaygEur / avgRealEur : 0;

  // Log-scale bar (sur max des 3 valeurs) — rend visible le ×240 de leverage.
  // Log évite que l'abo disparaisse visuellement face au dev 240× plus gros.
  const devLog = Math.log10(Math.max(1, avgDevEur));
  const paygLog = Math.log10(Math.max(1, avgPaygEur));
  const realLog = Math.log10(Math.max(1, avgRealEur));
  const maxLog = Math.max(devLog, paygLog, realLog, 1);
  const devPct = (devLog / maxLog) * 100;
  const paygPct = (paygLog / maxLog) * 100;
  const realPct = (realLog / maxLog) * 100;

  const topName = topLeverageProject?.row.projectName || topLeverageProject?.row.key || '';
  const topLeverage =
    topLeverageProject && topLeverageProject.realEur > 0
      ? topLeverageProject.effort.midEur / topLeverageProject.realEur
      : 0;

  return (
    <div className="stat flex flex-col">
      <div className="stat-label">{t('usage.llmPerProject.avgPerProject.title')}</div>
      <div className="mt-1 grid grid-cols-3 gap-3">
        <div className="flex flex-col">
          <span className="text-[10px] uppercase tracking-[0.08em] text-[var(--text-dim)]">
            {t('usage.llmPerProject.avgPerProject.devEquiv')}
          </span>
          <span className="num text-[20px] font-semibold text-[#30d158]">
            {formatEur(avgDevEur, locale)}
          </span>
          <span className="text-[10px] text-[var(--text-dim)]">
            {t('usage.llmPerProject.avgPerProject.perHour', {
              hours: formatHours(avgDevHours, locale),
              rate: String(hourlyRateEur),
            })}
          </span>
        </div>
        <div className="flex flex-col">
          <span className="text-[10px] uppercase tracking-[0.08em] text-[var(--text-dim)]">
            {t('usage.llmPerProject.avgPerProject.apiPayg')}
          </span>
          <span className="num text-[20px] font-semibold text-[#64d2ff]">
            {formatEur(avgPaygEur, locale)}
          </span>
          <span className="text-[10px] text-[var(--text-dim)]">
            {paygVsAbo > 0
              ? t('usage.llmPerProject.avgPerProject.byRatio', { n: paygVsAbo.toFixed(1) })
              : '—'}
          </span>
        </div>
        <div className="flex flex-col">
          <span className="text-[10px] uppercase tracking-[0.08em] text-[var(--text-dim)]">
            {t('usage.llmPerProject.avgPerProject.realAbo')}
          </span>
          <span className="num text-[20px] font-semibold text-[var(--text)]">
            {formatEur(avgRealEur, locale)}
          </span>
          <span className="text-[10px] text-[var(--text-dim)]">
            {t('usage.llmPerProject.avgPerProject.paidByYou')}
          </span>
        </div>
      </div>

      {avgDevEur > 0 || avgPaygEur > 0 || avgRealEur > 0 ? (
        <div className="mt-3 flex flex-col gap-1.5">
          <AvgBar
            color="#30d158"
            label={t('usage.llmPerProject.avgPerProject.barDev')}
            pct={devPct}
          />
          <AvgBar
            color="#64d2ff"
            label={t('usage.llmPerProject.avgPerProject.barApi')}
            pct={paygPct}
          />
          <AvgBar
            color="var(--text)"
            label={t('usage.llmPerProject.avgPerProject.barAbo')}
            pct={realPct}
          />
          <span className="text-[9.5px] text-[var(--text-faint)]">
            {t('usage.llmPerProject.avgPerProject.logScaleHint')}
          </span>
        </div>
      ) : null}

      <div className="mt-3 flex flex-col gap-1 rounded-[var(--radius-sm)] bg-[rgba(255,255,255,0.02)] px-2.5 py-1.5">
        <div className="flex items-center justify-between text-[10.5px]">
          <span className="uppercase tracking-[0.08em] text-[var(--text-dim)]">
            {t('usage.llmPerProject.avgPerProject.dispersion')}
          </span>
          <span className="text-[10px] text-[var(--text-faint)]">
            {t('usage.llmPerProject.avgPerProject.projectsCount', {
              n: String(devDistribution.count),
            })}
          </span>
        </div>
        <div className="flex items-baseline justify-between">
          <DistributionTick
            label={t('common.min')}
            value={formatEur(devDistribution.min, locale)}
          />
          <DistributionTick
            label={t('common.median')}
            value={formatEur(devDistribution.median, locale)}
            accent
          />
          <DistributionTick
            label={t('common.max')}
            value={formatEur(devDistribution.max, locale)}
          />
        </div>
      </div>

      {topLeverageProject && topLeverage > 0 ? (
        <div className="mt-2 flex items-center justify-between gap-2 rounded-[var(--radius-sm)] border border-[rgba(48,209,88,0.2)] bg-[rgba(48,209,88,0.05)] px-2.5 py-1.5 text-[11px]">
          <span className="text-[var(--text-dim)]">
            {t('usage.llmPerProject.avgPerProject.topLeverage')} ·{' '}
            <span className="text-[var(--text)]">
              {topName.length > 22 ? `${topName.slice(0, 22)}…` : topName}
            </span>
          </span>
          <span className="num font-semibold text-[#30d158]">×{topLeverage.toFixed(1)}</span>
        </div>
      ) : null}

      <div className="stat-hint">
        {t(
          activeProjects > 1
            ? 'usage.llmPerProject.avgPerProject.avgOnMany'
            : 'usage.llmPerProject.avgPerProject.avgOnOne',
          { n: String(activeProjects) },
        )}
        {devVsAbo > 0
          ? ` · ${t('usage.llmPerProject.avgPerProject.devVsAboSuffix', {
              n: devVsAbo.toFixed(1),
            })}`
          : ''}
      </div>
    </div>
  );
}

function AvgBar({ color, label, pct }: { color: string; label: string; pct: number }) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-8 shrink-0 text-[10px] uppercase tracking-[0.08em] text-[var(--text-dim)]">
        {label}
      </span>
      <div className="h-1 flex-1 overflow-hidden rounded-full bg-[rgba(255,255,255,0.05)]">
        <div
          className="h-full rounded-full"
          style={{
            width: `${Math.max(2, Math.min(100, pct))}%`,
            backgroundColor: color,
          }}
        />
      </div>
    </div>
  );
}

function DistributionTick({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: boolean;
}) {
  return (
    <div className="flex flex-col">
      <span className="text-[9px] uppercase tracking-[0.08em] text-[var(--text-faint)]">
        {label}
      </span>
      <span
        className={`num text-[12px] ${accent ? 'font-semibold text-[var(--text)]' : 'text-[var(--text-mute)]'}`}
      >
        {value}
      </span>
    </div>
  );
}
