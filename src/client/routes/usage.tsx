import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { Heatmap } from '../components/Heatmap';
import { HeatmapStackedBars } from '../components/HeatmapStackedBars';
import { ProjectsUsageLLM } from '../components/ProjectsUsageLLM';
import { Segmented } from '../components/ui';
import { apiGet } from '../lib/api';
import { type GroupBy, type StackedDailyRow, repoColor } from '../lib/cumulStacks';
import { type Locale, dateLocale, numberLocale, useTranslation } from '../lib/i18n';
import { type BillingHistory, computeBillingCost } from '../lib/pricing';

type CombinedDailyRow = {
  date: string;
  claudeInputTokens: number;
  claudeOutputTokens: number;
  claudeCacheCreateTokens: number;
  claudeCacheReadTokens: number;
  claudeTokens: number;
  claudeCostUsd: number;
  // Subscription cost (USD) for this day = (daily sub rate in EUR) / usdToEur.
  // Flat per-day while a plan is active. Optional on older clients/cached data.
  claudeSubCostUsd?: number;
  codexInputTokens: number;
  codexCachedInputTokens: number;
  codexOutputTokens: number;
  codexReasoningOutputTokens: number;
  codexTokens: number;
  codexCostUsd: number;
  codexSubCostUsd?: number;
  totalTokens: number;
  totalCostUsd: number;
  totalSubCostUsd?: number;
};

type CombinedDailyResponse = {
  rows: CombinedDailyRow[];
  warnings?: {
    claude?: string | null;
    codex?: string | null;
  };
};

type ProjectUsageRow = {
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
  models: Array<{ model: string; messages: number; tokens: number }>;
  tools: Array<{ name: string; count: number }>;
};

type ModelUsageRow = {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreate: number;
  cacheRead: number;
  totalTokens: number;
  messages: number;
};

type HourDistributionRow = {
  hour: number;
  tokens: number;
  messages: number;
};

type ToolUsageRow = {
  name: string;
  count: number;
};

type UsageMeta = {
  generatedAt: number;
  fromTs: number;
  toTs: number;
  filesScanned: number;
  linesParsed: number;
  assistantMessages: number;
  userMessages: number;
};

type UsageResponse<T> = {
  rows: T[];
  meta: UsageMeta;
};

// Shape returned by /api/usage/by-project/stacked-daily — one row per
// (date, project, source). `source` is null for synthetic idle rows
// (subscription paid, no project active that day — folded across
// sources). `realEur` is the time-weighted SUBSCRIPTION accrual (€).
type ProjectStackedDailyRow = {
  date: string;
  project: string;
  source: 'claude' | 'codex' | null;
  tokensActive: number;
  tokensAll: number;
  realEur: number;
};

type ToolUsageResponse = {
  rows: ToolUsageRow[];
  meta: UsageMeta;
  project: {
    projectKey: string;
    projectPath: string | null;
    projectId: string | null;
    projectName: string | null;
  } | null;
};

type CodexProjectUsageRow = {
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
  models: Array<{ model: string; turns: number; tokens: number }>;
  tools: ToolUsageRow[];
};

type CodexModelUsageRow = {
  model: string;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
  turns: number;
};

type CodexHourDistributionRow = {
  hour: number;
  tokens: number;
  turns: number;
};

type CodexUsageMeta = {
  generatedAt: number;
  fromTs: number;
  toTs: number;
  filesScanned: number;
  linesParsed: number;
  turns: number;
  sessions: number;
};

type CodexUsageResponse<T> = {
  rows: T[];
  meta: CodexUsageMeta;
};

type CodexToolUsageResponse = {
  rows: ToolUsageRow[];
  meta: CodexUsageMeta;
  project: {
    projectKey: string;
    projectPath: string | null;
    projectId: string | null;
    projectName: string | null;
  } | null;
};

type RateLimitBar = { usedPercent: number; windowMinutes: number; resetsAt: number } | null;

type CodexRateLimitsPayload = {
  rateLimits: {
    primary: RateLimitBar;
    secondary: RateLimitBar;
    planType: string | null;
    observedAt: number;
  } | null;
  // `live_oauth` = fresh from chatgpt.com/backend-api/wham/usage.
  // `jsonl_fallback` = last value observed inside a Codex session transcript
  // (stale by definition if the user hasn't run Codex recently).
  source?: 'live_oauth' | 'jsonl_fallback';
  liveCached?: boolean;
  liveError?: string | null;
  meta: CodexUsageMeta;
};

type ClaudeRateLimitsPayload = {
  rateLimits: {
    primary: RateLimitBar;
    secondary: RateLimitBar;
    tertiary: RateLimitBar;
    planType: string | null;
    observedAt: number;
  } | null;
};

type ProjectRowLike = {
  projectKey: string;
  projectPath: string | null;
  projectId: string | null;
  projectName: string | null;
  totalTokens: number;
};

type TimeRange = '30d' | '90d' | 'all';
type TokenLens = 'active' | 'all';
type HeatmapSource = 'total' | 'claude' | 'codex';
type HeatmapDayFilter = 'all' | 'weekday' | 'weekend';
type HeatmapIntensityFilter = 'all' | 'p50' | 'p75';
type HeatmapScale = 'linear' | 'log';
type AnalyticsProvider = 'claude' | 'codex';

type SubscriptionSettings = {
  usdToEur: number;
  claude: { plan: string; monthlyEur: number };
  codex: { plan: string; monthlyEur: number };
};

type ChartRow = {
  date: string;
  claudeActiveTokens: number;
  claudeCacheTokens: number;
  claudeAllTokens: number;
  codexActiveTokens: number;
  codexCacheTokens: number;
  codexAllTokens: number;
  totalActiveTokens: number;
  totalAllTokens: number;
  claudeSelectedTokens: number;
  codexSelectedTokens: number;
  totalSelectedTokens: number;
  claudeCost: number;
  codexCost: number;
  totalCost: number;
};

type ProviderTone = 'cyan' | 'amber';

// Option keys (labels resolved via t() at render time)
const RANGE_KEYS: TimeRange[] = ['30d', '90d', 'all'];
const LENS_KEYS: TokenLens[] = ['active', 'all'];
const HEATMAP_KEYS: HeatmapSource[] = ['total', 'claude', 'codex'];
const HEATMAP_DAY_KEYS: HeatmapDayFilter[] = ['all', 'weekday', 'weekend'];
const HEATMAP_INTENSITY_KEYS: HeatmapIntensityFilter[] = ['all', 'p50', 'p75'];
const HEATMAP_SCALE_KEYS: HeatmapScale[] = ['linear', 'log'];
const ANALYTICS_PROVIDER_KEYS: AnalyticsProvider[] = ['claude', 'codex'];

let LOCALE_SNAPSHOT: Locale = 'fr';
function currentLocale(): Locale {
  return LOCALE_SNAPSHOT;
}

function numberLabel(value: number): string {
  return Intl.NumberFormat(numberLocale(currentLocale())).format(Math.round(value));
}

function percentLabel(value: number): string {
  return `${value.toFixed(1)}%`;
}

function currencyLabel(value: number): string {
  return `$${value.toFixed(2)}`;
}

function yyyymmddFromDate(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

function isoDateFromDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function daysAgo(days: number): Date {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  return date;
}

function queryRange(range: TimeRange): { fromIso: string; fromCompact: string } {
  // 'all' = 5 years back, same convention as ProjectsUsageLLM.periodToDays,
  // which comfortably covers Claude history since July 2025 and anything
  // earlier the user might accumulate.
  const fromDate = range === '30d' ? daysAgo(30) : range === '90d' ? daysAgo(90) : daysAgo(5 * 365);
  return {
    fromIso: isoDateFromDate(fromDate),
    fromCompact: yyyymmddFromDate(fromDate),
  };
}

function shortProjectName(row: ProjectRowLike): string {
  if (row.projectName && row.projectName.trim().length > 0) {
    return row.projectName;
  }

  const source = row.projectPath || row.projectKey;
  const parts = source.split('/').filter(Boolean);
  return parts[parts.length - 1] || source;
}

function projectSelectorValue(row: ProjectRowLike): string {
  return row.projectId || row.projectKey;
}

function percentage(part: number, total: number): number {
  if (total <= 0) {
    return 0;
  }
  return (part / total) * 100;
}

function providerTokenTitle(lens: TokenLens): string {
  return lens === 'all' ? 'Tokens + cache' : 'Tokens actifs';
}

function heatmapSourceLabel(source: HeatmapSource): string {
  if (source === 'claude') {
    return 'Claude';
  }
  if (source === 'codex') {
    return 'Codex';
  }
  return 'Total';
}

function quantile(values: number[], q: number): number {
  if (values.length === 0) {
    return 0;
  }

  const sorted = [...values].sort((a, b) => a - b);
  const idx = (sorted.length - 1) * q;
  const lower = Math.floor(idx);
  const upper = Math.ceil(idx);
  if (lower === upper) {
    return sorted[lower];
  }

  const ratio = idx - lower;
  return sorted[lower] * (1 - ratio) + sorted[upper] * ratio;
}

function isWeekEnd(dateIso: string): boolean {
  const day = new Date(`${dateIso}T00:00:00Z`).getUTCDay();
  return day === 0 || day === 6;
}

/**
 * Retourne le plan name de la charge couvrant asOfTs (ou la plus récente à défaut).
 * Parcourt billingHistory[source] pour trouver l'abo actif aujourd'hui.
 */
function pickLatestActivePlan(
  charges: BillingHistory['claude'] | BillingHistory['codex'] | undefined,
  asOfTs: number,
): string | null {
  if (!charges || charges.length === 0) {
    return null;
  }
  const sorted = [...charges].sort((a, b) => b.date.localeCompare(a.date));
  const DAY = 86_400;
  for (const charge of sorted) {
    const startTs = Math.floor(new Date(`${charge.date}T00:00:00Z`).getTime() / 1000);
    const coverageDays = charge.coverageDays ?? 31;
    const endTs = startTs + coverageDays * DAY;
    if (asOfTs >= startTs && asOfTs < endTs) {
      return charge.plan;
    }
  }
  // Fallback: plan le plus récent si aucune coverage ne couvre maintenant
  return sorted[0]?.plan ?? null;
}

export default function UsageRoute() {
  const { t, locale } = useTranslation();
  LOCALE_SNAPSHOT = locale;
  const [dailyCombined, setDailyCombined] = useState<CombinedDailyRow[]>([]);
  const [sourceWarnings, setSourceWarnings] = useState<{
    claude?: string | null;
    codex?: string | null;
  }>({});
  const [byProject, setByProject] = useState<ProjectUsageRow[]>([]);
  // Daily per-project rows feeding the cumul stacked-bars view (one segment
  // per project). Both providers folded together server-side so the chart
  // shows project shares without mixing in the claude-vs-codex axis.
  const [projectStackedDaily, setProjectStackedDaily] = useState<ProjectStackedDailyRow[]>([]);
  const [byModel, setByModel] = useState<ModelUsageRow[]>([]);
  const [hourly, setHourly] = useState<HourDistributionRow[]>([]);
  const [toolUsage, setToolUsage] = useState<ToolUsageRow[]>([]);
  const [jsonlMeta, setJsonlMeta] = useState<UsageMeta | null>(null);
  const [codexByProject, setCodexByProject] = useState<CodexProjectUsageRow[]>([]);
  const [codexByModel, setCodexByModel] = useState<CodexModelUsageRow[]>([]);
  const [codexHourly, setCodexHourly] = useState<CodexHourDistributionRow[]>([]);
  const [codexTools, setCodexTools] = useState<ToolUsageRow[]>([]);
  const [codexRateLimits, setCodexRateLimits] =
    useState<CodexRateLimitsPayload['rateLimits']>(null);
  const [claudeRateLimits, setClaudeRateLimits] =
    useState<ClaudeRateLimitsPayload['rateLimits']>(null);
  const [codexJsonlMeta, setCodexJsonlMeta] = useState<CodexUsageMeta | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toolUsageError, setToolUsageError] = useState<string | null>(null);
  const [codexError, setCodexError] = useState<string | null>(null);
  const [codexToolError, setCodexToolError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isToolUsageLoading, setIsToolUsageLoading] = useState(false);
  const [isCodexLoading, setIsCodexLoading] = useState(false);
  const [isCodexToolLoading, setIsCodexToolLoading] = useState(false);
  const [range, setRange] = useState<TimeRange>('90d');
  const [tokenLens, setTokenLens] = useState<TokenLens>('active');
  const [heatmapSource, setHeatmapSource] = useState<HeatmapSource>('total');
  const [heatmapDayFilter, setHeatmapDayFilter] = useState<HeatmapDayFilter>('all');
  const [heatmapIntensity, setHeatmapIntensity] = useState<HeatmapIntensityFilter>('all');
  const [heatmapScale, setHeatmapScale] = useState<HeatmapScale>('linear');
  // View toggle for the merged heatmap module: calendar grid (existing) vs
  // cumulative stacked bars per provider (new — mirrors the github heatmap
  // cumul view). Defaults to grid so the page reads the same on first paint;
  // the cumul view is opt-in via the toolbar segmented control.
  const [heatmapView, setHeatmapView] = useState<'grid' | 'cumul'>('grid');
  // Granularity for the cumul stacked-bars view. 'month' = 12 columns over
  // the active range, reads cleanly. Other modes mirror the github heatmap.
  const [heatmapBucket, setHeatmapBucket] = useState<GroupBy>('month');
  // Metric driving the cumul view's Y values: tokens (volumes) or cost (€).
  // Replaces the old "Volume tokens + coût" panel — both signals live here
  // now, swapped via this control. Provider stacking is automatic.
  const [heatmapMetric, setHeatmapMetric] = useState<'tokens' | 'cost'>('tokens');
  const [analyticsProvider, setAnalyticsProvider] = useState<AnalyticsProvider>('claude');
  const [selectedProjectRef, setSelectedProjectRef] = useState<string>('');
  const [selectedCodexProjectRef, setSelectedCodexProjectRef] = useState<string>('');
  const [subscriptions, setSubscriptions] = useState<SubscriptionSettings | null>(null);
  const [billingHistory, setBillingHistory] = useState<BillingHistory | null>(null);
  const [allTimeDaily, setAllTimeDaily] = useState<CombinedDailyRow[]>([]);

  useEffect(() => {
    apiGet<{ subscriptions?: SubscriptionSettings; billingHistory?: BillingHistory }>(
      '/api/settings',
    )
      .then((data) => {
        if (data.billingHistory) {
          setBillingHistory(data.billingHistory);
        }
        if (data.subscriptions) {
          // Override monthlyEur + plan name with the actual currently active charge
          // from billingHistory (source de vérité : charges réelles, pas settings figés).
          const nowSec = Math.floor(Date.now() / 1000);
          const claudeBilling = data.billingHistory?.claude
            ? computeBillingCost(data.billingHistory, 'claude', nowSec - 30 * 86400, nowSec, nowSec)
            : null;
          const codexBilling = data.billingHistory?.codex
            ? computeBillingCost(data.billingHistory, 'codex', nowSec - 30 * 86400, nowSec, nowSec)
            : null;

          const claudeActive = claudeBilling?.activeMonthly.claude ?? 0;
          const codexActive = codexBilling?.activeMonthly.codex ?? 0;

          // Latest active plan names
          const latestClaudePlan = pickLatestActivePlan(data.billingHistory?.claude, nowSec);
          const latestCodexPlan = pickLatestActivePlan(data.billingHistory?.codex, nowSec);

          setSubscriptions({
            ...data.subscriptions,
            claude: {
              plan: latestClaudePlan || data.subscriptions.claude.plan,
              monthlyEur: claudeActive > 0 ? claudeActive : data.subscriptions.claude.monthlyEur,
            },
            codex: {
              plan: latestCodexPlan || data.subscriptions.codex.plan,
              monthlyEur: codexActive > 0 ? codexActive : data.subscriptions.codex.monthlyEur,
            },
          });
        }
      })
      .catch(() => {
        /* ignore */
      });
  }, []);

  // Fetch all-time daily data (independent of period selector) for the EconomyCard.
  useEffect(() => {
    let cancelled = false;
    // 2020-01-01 comme borne basse : couvre tout l'historique imaginable.
    apiGet<CombinedDailyResponse>('/api/usage/daily-combined?from=20200101')
      .then((data) => {
        if (!cancelled) {
          setAllTimeDaily(data.rows || []);
        }
      })
      .catch(() => {
        /* ignore — EconomyCard fera fallback sur la période courante */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const { fromIso, fromCompact } = queryRange(range);

    setIsLoading(true);
    setError(null);

    Promise.all([
      apiGet<CombinedDailyResponse>(`/api/usage/daily-combined?from=${fromCompact}`),
      apiGet<UsageResponse<ProjectUsageRow>>(`/api/usage/by-project?from=${fromIso}&limit=80`),
      apiGet<UsageResponse<ModelUsageRow>>(`/api/usage/by-model?from=${fromIso}`),
      apiGet<UsageResponse<HourDistributionRow>>(`/api/usage/hour-distribution?from=${fromIso}`),
      apiGet<{ rows: ProjectStackedDailyRow[] }>(
        `/api/usage/by-project/stacked-daily?from=${fromIso}`,
      ),
    ])
      .then(([combinedData, projectData, modelData, hourData, stackedDailyData]) => {
        if (cancelled) {
          return;
        }

        setDailyCombined(combinedData.rows || []);
        setSourceWarnings(combinedData.warnings || {});
        setByProject(projectData.rows || []);
        setByModel(modelData.rows || []);
        setHourly(hourData.rows || []);
        setProjectStackedDaily(stackedDailyData.rows || []);
        setJsonlMeta(projectData.meta || modelData.meta || hourData.meta || null);

        setSelectedProjectRef((current) => {
          if (!projectData.rows || projectData.rows.length === 0) {
            return '';
          }
          const exists = projectData.rows.some((row) => projectSelectorValue(row) === current);
          return exists ? current : projectSelectorValue(projectData.rows[0]);
        });
      })
      .catch((e) => {
        if (!cancelled) {
          setError(String(e));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setIsLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [range]);

  // Claude rate-limits: derived from ccusage blocks (5h billing window). Not in
  // the main Promise.all above because the endpoint shells out to `ccusage`
  // which is much slower than the JSONL-backed routes, and we don't want it
  // blocking the initial render.
  useEffect(() => {
    if (analyticsProvider !== 'claude') {
      return;
    }
    let cancelled = false;
    apiGet<ClaudeRateLimitsPayload>('/api/usage/claude/rate-limits')
      .then((data) => {
        if (!cancelled) setClaudeRateLimits(data.rateLimits || null);
      })
      .catch(() => {
        if (!cancelled) setClaudeRateLimits(null);
      });
    return () => {
      cancelled = true;
    };
  }, [analyticsProvider]);

  useEffect(() => {
    let cancelled = false;
    const { fromIso } = queryRange(range);

    setIsToolUsageLoading(true);
    setToolUsageError(null);

    const selected = byProject.find((row) => projectSelectorValue(row) === selectedProjectRef);
    const url = !selectedProjectRef
      ? `/api/usage/tool-usage?from=${fromIso}`
      : selected?.projectId
        ? `/api/usage/tool-usage?from=${fromIso}&projectId=${encodeURIComponent(selected.projectId)}`
        : selected
          ? `/api/usage/tool-usage?from=${fromIso}&project=${encodeURIComponent(selected.projectKey)}`
          : `/api/usage/tool-usage?from=${fromIso}`;

    apiGet<ToolUsageResponse>(url)
      .then((result) => {
        if (cancelled) {
          return;
        }
        setToolUsage(result.rows || []);
      })
      .catch((e) => {
        if (!cancelled) {
          setToolUsageError(String(e));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setIsToolUsageLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [selectedProjectRef, byProject, range]);

  useEffect(() => {
    if (analyticsProvider !== 'codex') {
      return;
    }

    let cancelled = false;
    const { fromIso } = queryRange(range);

    setIsCodexLoading(true);
    setCodexError(null);

    Promise.all([
      apiGet<CodexUsageResponse<CodexProjectUsageRow>>(
        `/api/usage/codex/by-project?from=${fromIso}&limit=80`,
      ),
      apiGet<CodexUsageResponse<CodexModelUsageRow>>(`/api/usage/codex/by-model?from=${fromIso}`),
      apiGet<CodexUsageResponse<CodexHourDistributionRow>>(
        `/api/usage/codex/hour-distribution?from=${fromIso}`,
      ),
      apiGet<CodexRateLimitsPayload>(`/api/usage/codex/rate-limits?from=${fromIso}`),
    ])
      .then(([projectData, modelData, hourData, rateLimitsData]) => {
        if (cancelled) {
          return;
        }
        setCodexByProject(projectData.rows || []);
        setCodexByModel(modelData.rows || []);
        setCodexHourly(hourData.rows || []);
        setCodexRateLimits(rateLimitsData.rateLimits || null);
        setCodexJsonlMeta(projectData.meta || modelData.meta || hourData.meta || null);
        setSelectedCodexProjectRef((current) => {
          if (!projectData.rows || projectData.rows.length === 0) {
            return '';
          }
          const exists = projectData.rows.some((row) => projectSelectorValue(row) === current);
          return exists ? current : projectSelectorValue(projectData.rows[0]);
        });
      })
      .catch((e) => {
        if (!cancelled) {
          setCodexError(String(e));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setIsCodexLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [analyticsProvider, range]);

  useEffect(() => {
    if (analyticsProvider !== 'codex') {
      return;
    }

    let cancelled = false;
    const { fromIso } = queryRange(range);

    setIsCodexToolLoading(true);
    setCodexToolError(null);

    const selected = codexByProject.find(
      (row) => projectSelectorValue(row) === selectedCodexProjectRef,
    );
    const url = !selectedCodexProjectRef
      ? `/api/usage/codex/tool-usage?from=${fromIso}`
      : selected?.projectId
        ? `/api/usage/codex/tool-usage?from=${fromIso}&projectId=${encodeURIComponent(selected.projectId)}`
        : selected
          ? `/api/usage/codex/tool-usage?from=${fromIso}&project=${encodeURIComponent(selected.projectKey)}`
          : `/api/usage/codex/tool-usage?from=${fromIso}`;

    apiGet<CodexToolUsageResponse>(url)
      .then((result) => {
        if (cancelled) {
          return;
        }
        setCodexTools(result.rows || []);
      })
      .catch((e) => {
        if (!cancelled) {
          setCodexToolError(String(e));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setIsCodexToolLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [analyticsProvider, selectedCodexProjectRef, codexByProject, range]);

  const chartData = useMemo(() => {
    const rows = [...dailyCombined]
      .map((row) => {
        // Token conventions (critical — fixes previous double-count + label drift):
        //   active = tokens computed fresh (billed at full rate, never from cache).
        //   cache  = tokens read/written via the prompt cache.
        //   all    = active + cache (no overlap).
        // Claude JSONL keeps input and cache_read separate; Codex JSONL rolls
        // cached_input_tokens INTO input_tokens, so we subtract to reach the
        // fresh-only figure. Reasoning output is fresh work → counted in active.
        const claudeIn = Number(row.claudeInputTokens || 0);
        const claudeOut = Number(row.claudeOutputTokens || 0);
        const claudeCacheCreate = Number(row.claudeCacheCreateTokens || 0);
        const claudeCacheRead = Number(row.claudeCacheReadTokens || 0);
        const claudeActive = claudeIn + claudeOut;
        const claudeCache = claudeCacheCreate + claudeCacheRead;
        const claudeAll = claudeActive + claudeCache;

        const codexInTotal = Number(row.codexInputTokens || 0);
        const codexCached = Number(row.codexCachedInputTokens || 0);
        const codexOut = Number(row.codexOutputTokens || 0);
        const codexReasoning = Number(row.codexReasoningOutputTokens || 0);
        const codexFreshIn = Math.max(0, codexInTotal - codexCached);
        const codexActive = codexFreshIn + codexOut + codexReasoning;
        const codexCache = codexCached;
        const codexAll = codexActive + codexCache;

        return {
          date: String(row.date),
          claudeActiveTokens: claudeActive,
          claudeCacheTokens: claudeCache,
          claudeAllTokens: claudeAll,
          codexActiveTokens: codexActive,
          codexCacheTokens: codexCache,
          codexAllTokens: codexAll,
          totalActiveTokens: claudeActive + codexActive,
          totalAllTokens: claudeAll + codexAll,
          claudeSelectedTokens: tokenLens === 'all' ? claudeAll : claudeActive,
          codexSelectedTokens: tokenLens === 'all' ? codexAll : codexActive,
          totalSelectedTokens: 0,
          claudeCost: Number(row.claudeSubCostUsd ?? row.claudeCostUsd ?? 0),
          codexCost: Number(row.codexSubCostUsd ?? row.codexCostUsd ?? 0),
          totalCost: Number(row.totalSubCostUsd ?? row.totalCostUsd ?? 0),
        } satisfies ChartRow;
      })
      .map((row) => ({
        ...row,
        totalSelectedTokens: row.claudeSelectedTokens + row.codexSelectedTokens,
      }))
      .sort((a, b) => a.date.localeCompare(b.date));

    if (range === '30d') {
      return rows.slice(-30);
    }
    if (range === '90d') {
      return rows.slice(-90);
    }
    return rows;
  }, [dailyCombined, range, tokenLens]);

  // Per-project daily series feeding the cumul stacked-bars view. One
  // segment per project (not per provider) so the chart shows the user's
  // project mix over time. Both providers are folded together at the
  // server level (see /api/usage/by-project/stacked-daily) so a project's
  // segment is its TOTAL across claude+codex.
  //
  // We collapse multiple same-day rows of the same project (same project
  // contributing under both providers on the same day) into a single
  // {project: total} entry per date. Tokens follow the active/all lens;
  // cost is provider-agnostic (sum of cost_usd, both sources).
  //
  // RECONCILIATION: the project scanner only sees Claude sessions whose
  // `cwd` matches a configured project root, while ccusage (driving the
  // TOTAL TOKENS card via `usage_daily`) scans every JSONL on disk. The
  // resulting per-day gap is emitted as an "__untracked__" segment so the
  // header total reconciles with the top card and the user can SEE the
  // unattributed mass. Cost reconciles by construction (subscription
  // rate split among active projects, sums to the daily rate).
  const heatmapStackedDaily = useMemo<{
    tokens: StackedDailyRow[];
    cost: StackedDailyRow[];
    untrackedLabel: string;
    idleLabel: string;
    // Per composite key ("project · claude" / "project · codex"), maps
    // back to the underlying project name. Used by the colour map to
    // pick the right hue, and by the chart sort to group siblings.
    tokenKeyToProject: Map<string, string>;
  }>(() => {
    const tokenField: keyof ProjectStackedDailyRow =
      tokenLens === 'all' ? 'tokensAll' : 'tokensActive';
    const untrackedLabel = t('usage.heatmap.untracked');
    const idleLabel = t('usage.heatmap.idle');

    const fromIso = chartData[0]?.date;
    const toIso = chartData[chartData.length - 1]?.date;
    const inRange = (d: string): boolean => (!fromIso || d >= fromIso) && (!toIso || d <= toIso);

    const tokenMap = new Map<string, Record<string, number>>();
    const costMap = new Map<string, Record<string, number>>();
    // Tokens view: split each project into "{project} · claude" and
    // "{project} · codex" so the user reads the per-provider mix INSIDE
    // each project segment. Cost view stays folded — no source split, the
    // EUR accrual is provider-agnostic from the user's perspective.
    const tokenKeyToProject = new Map<string, string>();
    for (const row of projectStackedDaily) {
      if (!inRange(row.date)) continue;
      const isIdle = row.project === '__idle__';
      const projectLabel = isIdle ? idleLabel : row.project;

      if (!isIdle) {
        // source can only be null on idle rows; this branch always has it.
        const sourceLabel = row.source === 'codex' ? 'codex' : 'claude';
        const tokenKey = `${projectLabel} · ${sourceLabel}`;
        tokenKeyToProject.set(tokenKey, projectLabel);
        const tBucket = tokenMap.get(row.date) ?? {};
        tBucket[tokenKey] = (tBucket[tokenKey] ?? 0) + Number(row[tokenField] ?? 0);
        tokenMap.set(row.date, tBucket);
      }

      const cBucket = costMap.get(row.date) ?? {};
      cBucket[projectLabel] = (cBucket[projectLabel] ?? 0) + Number(row.realEur ?? 0);
      costMap.set(row.date, cBucket);
    }

    // Top-up the tokens series with the untracked diff per day. We only
    // do this for tokens — cost reconciles automatically (daily rate is
    // distributed among active projects, no unattributed mass possible).
    for (const row of chartData) {
      if (!inRange(row.date)) continue;
      const tBucket = tokenMap.get(row.date) ?? {};
      const summed = Object.values(tBucket).reduce((a, b) => a + b, 0);
      const expected = row.totalSelectedTokens;
      const diff = expected - summed;
      if (diff > 0) {
        tBucket[untrackedLabel] = (tBucket[untrackedLabel] ?? 0) + diff;
        tokenMap.set(row.date, tBucket);
      }
    }

    const toRows = (m: Map<string, Record<string, number>>): StackedDailyRow[] =>
      [...m.entries()]
        .map(([date, values]) => ({ date, values }))
        .sort((a, b) => a.date.localeCompare(b.date));

    return {
      tokens: toRows(tokenMap),
      cost: toRows(costMap),
      untrackedLabel,
      idleLabel,
      tokenKeyToProject,
    };
  }, [projectStackedDaily, chartData, tokenLens, t]);

  const totals = useMemo(() => {
    return chartData.reduce(
      (acc, row) => {
        acc.claudeActiveTokens += row.claudeActiveTokens;
        acc.claudeCacheTokens += row.claudeCacheTokens;
        acc.claudeAllTokens += row.claudeAllTokens;
        acc.codexActiveTokens += row.codexActiveTokens;
        acc.codexCacheTokens += row.codexCacheTokens;
        acc.codexAllTokens += row.codexAllTokens;
        acc.totalActiveTokens += row.totalActiveTokens;
        acc.totalAllTokens += row.totalAllTokens;
        acc.totalSelectedTokens += row.totalSelectedTokens;
        acc.totalCost += row.totalCost;
        acc.claudeCost += row.claudeCost;
        acc.codexCost += row.codexCost;
        return acc;
      },
      {
        claudeActiveTokens: 0,
        claudeCacheTokens: 0,
        claudeAllTokens: 0,
        codexActiveTokens: 0,
        codexCacheTokens: 0,
        codexAllTokens: 0,
        totalActiveTokens: 0,
        totalAllTokens: 0,
        totalSelectedTokens: 0,
        totalCost: 0,
        claudeCost: 0,
        codexCost: 0,
      },
    );
  }, [chartData]);

  const monthly = useMemo(() => {
    const map = new Map<
      string,
      {
        month: string;
        claudeSelectedTokens: number;
        codexSelectedTokens: number;
        totalSelectedTokens: number;
        totalCost: number;
        claudeCost: number;
        codexCost: number;
      }
    >();

    for (const row of chartData) {
      const month = row.date.slice(0, 7);
      const current = map.get(month) || {
        month,
        claudeSelectedTokens: 0,
        codexSelectedTokens: 0,
        totalSelectedTokens: 0,
        totalCost: 0,
        claudeCost: 0,
        codexCost: 0,
      };

      current.claudeSelectedTokens += row.claudeSelectedTokens;
      current.codexSelectedTokens += row.codexSelectedTokens;
      current.totalSelectedTokens += row.totalSelectedTokens;
      current.totalCost += row.totalCost;
      current.claudeCost += row.claudeCost;
      current.codexCost += row.codexCost;
      map.set(month, current);
    }

    return [...map.values()].sort((a, b) => a.month.localeCompare(b.month));
  }, [chartData]);

  const baseHeatmapDays = useMemo(() => {
    const key =
      heatmapSource === 'claude'
        ? 'claudeSelectedTokens'
        : heatmapSource === 'codex'
          ? 'codexSelectedTokens'
          : 'totalSelectedTokens';

    return chartData.map((row) => ({
      date: row.date,
      count: Number(row[key] || 0),
      color: null,
    }));
  }, [chartData, heatmapSource]);

  const heatmapModel = useMemo(() => {
    const scoped = baseHeatmapDays.map((day) => {
      const weekend = isWeekEnd(day.date);
      const inScope =
        heatmapDayFilter === 'all' || (heatmapDayFilter === 'weekday' ? !weekend : weekend);
      return {
        ...day,
        inScope,
      };
    });

    const positiveScopedCounts = scoped
      .filter((day) => day.inScope && day.count > 0)
      .map((day) => day.count);

    const threshold =
      heatmapIntensity === 'p50'
        ? quantile(positiveScopedCounts, 0.5)
        : heatmapIntensity === 'p75'
          ? quantile(positiveScopedCounts, 0.75)
          : 0;

    const filteredDays = scoped.map((day) => {
      if (!day.inScope) {
        return {
          date: day.date,
          count: 0,
          color: null,
        };
      }

      const aboveThreshold = day.count >= threshold;
      const raw = aboveThreshold ? day.count : 0;
      const scaled =
        heatmapScale === 'log' && raw > 0 ? Math.round(Math.log10(raw + 1) * 1000) : raw;
      return {
        date: day.date,
        count: scaled,
        color: null,
      };
    });

    return {
      days: filteredDays,
      rawTotalInScope: scoped.filter((day) => day.inScope).reduce((sum, day) => sum + day.count, 0),
      visibleDays: filteredDays.filter((day) => day.count > 0).length,
      scopedDays: scoped.filter((day) => day.inScope).length,
      threshold,
    };
  }, [baseHeatmapDays, heatmapDayFilter, heatmapIntensity, heatmapScale]);

  const heatmapPalette = useMemo(() => {
    if (heatmapSource === 'claude') {
      return 'cyan' as const;
    }
    if (heatmapSource === 'codex') {
      return 'amber' as const;
    }
    return 'github' as const;
  }, [heatmapSource]);

  const selectedProject = useMemo(() => {
    return byProject.find((row) => projectSelectorValue(row) === selectedProjectRef) || null;
  }, [byProject, selectedProjectRef]);

  const hasCombinedData = chartData.length > 0;
  const hasClaudeData =
    chartData.some((row) => row.claudeAllTokens > 0 || row.claudeCost > 0) || byProject.length > 0;
  const hasCodexData = chartData.some((row) => row.codexAllTokens > 0 || row.codexCost > 0);

  const claudeTokenShare = percentage(
    tokenLens === 'all' ? totals.claudeAllTokens : totals.claudeActiveTokens,
    totals.totalSelectedTokens,
  );
  const codexTokenShare = percentage(
    tokenLens === 'all' ? totals.codexAllTokens : totals.codexActiveTokens,
    totals.totalSelectedTokens,
  );
  const claudeCostShare = percentage(totals.claudeCost, totals.totalCost);
  const codexCostShare = percentage(totals.codexCost, totals.totalCost);

  // All-time aggregates for EconomyCard — indépendants du period selector
  const allTimeTotals = useMemo(() => {
    const claudeCostUsd = allTimeDaily.reduce(
      (acc, row) => acc + Number(row.claudeCostUsd || 0),
      0,
    );
    const codexCostUsd = allTimeDaily.reduce((acc, row) => acc + Number(row.codexCostUsd || 0), 0);
    const firstDate =
      allTimeDaily.length > 0
        ? [...allTimeDaily].sort((a, b) => String(a.date).localeCompare(String(b.date)))[0].date
        : null;
    const lastDate =
      allTimeDaily.length > 0
        ? [...allTimeDaily].sort((a, b) => String(b.date).localeCompare(String(a.date)))[0].date
        : null;
    return { claudeCostUsd, codexCostUsd, firstDate, lastDate };
  }, [allTimeDaily]);

  const allTimePaid = useMemo(() => {
    const sumCharges = (charges: BillingHistory['claude'] | undefined) =>
      (charges || []).reduce((acc, c) => acc + c.amountEur, 0);
    return {
      claude: sumCharges(billingHistory?.claude),
      codex: sumCharges(billingHistory?.codex),
    };
  }, [billingHistory]);

  // Première date d'engagement = min(première charge abo, première donnée métrée)
  const allTimeFirstDate = useMemo(() => {
    const billingDates = [...(billingHistory?.claude || []), ...(billingHistory?.codex || [])].map(
      (c) => c.date,
    );
    const meteredDate = allTimeTotals.firstDate;
    const candidates = [...billingDates, meteredDate].filter(
      (d): d is string => typeof d === 'string' && d.length > 0,
    );
    if (candidates.length === 0) {
      return null;
    }
    return candidates.sort()[0];
  }, [billingHistory, allTimeTotals.firstDate]);

  const topToolMax = toolUsage[0]?.count || 1;

  // Composite colour map for the cumul views.
  //   - Untracked (tokens-only sentinel): mid grey
  //   - Idle      (cost-only sentinel)  : darker grey
  //   - Tokens view, per composite key "{project} · claude" / "… · codex":
  //       base hue from project hash inside the cyan family;
  //       claude = base lightness, codex = base + 15 (lighter) so the user
  //       reads "same project, two providers" inside one stack block.
  // Cost view keys are project-only and fall through to the scheme hash
  // colour (no override needed).
  const cumulColorMap = useMemo<Record<string, string>>(() => {
    const map: Record<string, string> = {
      [heatmapStackedDaily.untrackedLabel]: 'hsl(0, 0%, 38%)',
      [heatmapStackedDaily.idleLabel]: 'hsl(0, 0%, 28%)',
    };
    if (heatmapMetric !== 'tokens') return map;
    const lighten = (hsl: string, deltaL: number): string => {
      const m = hsl.match(/hsl\(\s*([\d.]+)\s*,\s*([\d.]+)%\s*,\s*([\d.]+)%\s*\)/);
      if (!m) return hsl;
      const h = m[1];
      const s = m[2];
      const l = Math.max(20, Math.min(78, Number(m[3]) + deltaL));
      return `hsl(${h}, ${s}%, ${l}%)`;
    };
    for (const [tokenKey, project] of heatmapStackedDaily.tokenKeyToProject.entries()) {
      const base = repoColor(project, 'cyan');
      map[tokenKey] = tokenKey.endsWith('· codex') ? lighten(base, 15) : base;
    }
    return map;
  }, [heatmapStackedDaily, heatmapMetric]);

  return (
    <div className="flex flex-col gap-6">
      <div className="section-head">
        <div className="flex flex-col gap-0.5">
          <h2 className="section-title">{t('usage.title')}</h2>
          <div className="section-meta">{t('usage.headerMeta')}</div>
        </div>
        {/* Page-level range filter: drives the chart + Claude/Codex provider
            cards + MetricCards below. EconomyCard and ProjectsUsageLLM keep
            their own all-time / period selectors on purpose. */}
        <Segmented<TimeRange>
          value={range}
          options={[
            { value: '30d', label: t('common.daysAgo', { n: 30 }) },
            { value: '90d', label: t('common.daysAgo', { n: 90 }) },
            { value: 'all', label: t('common.allTime') },
          ]}
          onChange={setRange}
        />
      </div>

      {error ? (
        <div className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-200">
          {error}
        </div>
      ) : null}

      {subscriptions ? (
        <EconomyCard
          claudeCostUsd={allTimeTotals.claudeCostUsd}
          codexCostUsd={allTimeTotals.codexCostUsd}
          claudePaidEur={allTimePaid.claude}
          codexPaidEur={allTimePaid.codex}
          firstDate={allTimeFirstDate}
          lastDate={allTimeTotals.lastDate}
          meteredFirstDate={allTimeTotals.firstDate}
          subs={subscriptions}
        />
      ) : null}

      <ProjectsUsageLLM />

      <div className="grid grid-cols-1 gap-3 xl:grid-cols-4">
        <ProviderSummaryCard
          title="Claude"
          tone="cyan"
          lens={tokenLens}
          selectedTokens={tokenLens === 'all' ? totals.claudeAllTokens : totals.claudeActiveTokens}
          activeTokens={totals.claudeActiveTokens}
          cacheTokens={totals.claudeCacheTokens}
          cost={totals.claudeCost}
          tokenShare={claudeTokenShare}
          costShare={claudeCostShare}
        />

        <ProviderSummaryCard
          title="Codex"
          tone="amber"
          lens={tokenLens}
          selectedTokens={tokenLens === 'all' ? totals.codexAllTokens : totals.codexActiveTokens}
          activeTokens={totals.codexActiveTokens}
          cacheTokens={totals.codexCacheTokens}
          cost={totals.codexCost}
          tokenShare={codexTokenShare}
          costShare={codexCostShare}
        />

        <MetricCard
          title={t('usage.metrics.totalTokens')}
          value={numberLabel(totals.totalSelectedTokens)}
        >
          <MetricLine
            label={providerTokenTitle(tokenLens)}
            value={numberLabel(totals.totalSelectedTokens)}
          />
          <MetricLine
            label={t('usage.metricLines.totalCost')}
            value={currencyLabel(totals.totalCost)}
          />
          <MetricLine label={t('common.days')} value={String(chartData.length)} />
        </MetricCard>

        <MetricCard
          title={t('usage.metrics.coverage')}
          value={hasCombinedData ? 'OK' : t('common.empty')}
          valueTone="text-emerald-200"
        >
          <MetricLine
            label={t('usage.metricLines.combinedDaily')}
            value={
              hasCombinedData
                ? t('usage.metricLines.daysCount', { n: chartData.length })
                : t('usage.metricLines.noLine')
            }
          />
          <MetricLine
            label={t('usage.metricLines.jsonlFiles')}
            value={jsonlMeta ? String(jsonlMeta.filesScanned) : 'n/a'}
          />
          <MetricLine
            label={t('usage.metricLines.jsonlMessages')}
            value={
              jsonlMeta ? numberLabel(jsonlMeta.assistantMessages + jsonlMeta.userMessages) : 'n/a'
            }
          />
        </MetricCard>
      </div>

      {/* Merged module: calendar heatmap (Grille) + cumulative stacked bars
          per provider (Cumul). The cumul view absorbs the former "Volume
          tokens + coût" panel — same daily series, displayed cumulatively
          per provider with a metric switch (tokens / coût). Mirrors the
          github heatmap module's grid/cumul UX. */}
      <Panel
        title={t('usage.metrics.heatmapUsage')}
        subtitle={
          heatmapView === 'grid'
            ? `${t('usage.filters.source')}: ${heatmapSourceLabel(heatmapSource)} · ${providerTokenTitle(tokenLens)}`
            : heatmapMetric === 'tokens'
              ? providerTokenTitle(tokenLens)
              : t('usage.heatmap.metricCostSubtitle')
        }
      >
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <Segmented
            value={heatmapView}
            options={[
              { value: 'grid', label: t('usage.heatmap.viewGrid') },
              { value: 'cumul', label: t('usage.heatmap.viewCumul') },
            ]}
            onChange={(value) => setHeatmapView(value as 'grid' | 'cumul')}
          />
          {heatmapView === 'cumul' ? (
            <>
              <Segmented
                value={heatmapMetric}
                options={[
                  { value: 'tokens', label: t('usage.heatmap.metricTokens') },
                  { value: 'cost', label: t('usage.heatmap.metricCost') },
                ]}
                onChange={(value) => setHeatmapMetric(value as 'tokens' | 'cost')}
              />
              <Segmented
                value={heatmapBucket}
                options={[
                  { value: 'day', label: t('usage.heatmap.bucketDay') },
                  { value: 'week', label: t('usage.heatmap.bucketWeek') },
                  { value: 'biweekly', label: t('usage.heatmap.bucketBiweekly') },
                  { value: 'month', label: t('usage.heatmap.bucketMonth') },
                  { value: 'quarter', label: t('usage.heatmap.bucketQuarter') },
                ]}
                onChange={(value) => setHeatmapBucket(value as GroupBy)}
              />
            </>
          ) : null}
        </div>

        {heatmapView === 'grid' ? (
          <>
            <div className="mb-3 flex flex-wrap items-end gap-3">
              <LabeledSelect
                label={t('usage.filters.source')}
                value={heatmapSource}
                options={HEATMAP_KEYS.map((k) => ({
                  value: k,
                  label: t(`usage.heatmapSource.${k}`),
                }))}
                onChange={(value) => setHeatmapSource(value as HeatmapSource)}
              />
              <LabeledSelect
                label={t('usage.filters.dayFilter')}
                value={heatmapDayFilter}
                options={HEATMAP_DAY_KEYS.map((k) => ({
                  value: k,
                  label: t(`usage.heatmapDayFilter.${k}`),
                }))}
                onChange={(value) => setHeatmapDayFilter(value as HeatmapDayFilter)}
              />
              <LabeledSelect
                label={t('usage.filters.intensity')}
                value={heatmapIntensity}
                options={HEATMAP_INTENSITY_KEYS.map((k) => ({
                  value: k,
                  label: t(`usage.heatmapIntensity.${k}`),
                }))}
                onChange={(value) => setHeatmapIntensity(value as HeatmapIntensityFilter)}
              />
              <LabeledSelect
                label={t('usage.filters.scale')}
                value={heatmapScale}
                options={HEATMAP_SCALE_KEYS.map((k) => ({
                  value: k,
                  label: t(`usage.heatmapScale.${k}`),
                }))}
                onChange={(value) => setHeatmapScale(value as HeatmapScale)}
              />
            </div>

            <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-slate-500">
              <span className="ui-chip">
                {t('usage.filters.visibleDays', {
                  visible: heatmapModel.visibleDays,
                  total: heatmapModel.scopedDays,
                })}
              </span>
              <span className="ui-chip">
                {t('usage.filters.threshold', {
                  value:
                    heatmapIntensity === 'all'
                      ? t('usage.filters.thresholdNone')
                      : numberLabel(heatmapModel.threshold),
                })}
              </span>
              <span className="ui-chip">
                {t('usage.filters.scaleLabel', {
                  value:
                    heatmapScale === 'log'
                      ? t('usage.filters.scaleLog')
                      : t('usage.filters.scaleLinear'),
                })}
              </span>
            </div>

            {heatmapModel.days.length === 0 ? (
              <EmptyBlock message={t('usage.filters.emptyHeatmap')} />
            ) : (
              <Heatmap
                days={heatmapModel.days}
                palette={heatmapPalette}
                totalLabel={providerTokenTitle(tokenLens).toLowerCase()}
                totalValue={heatmapModel.rawTotalInScope}
                cellSize={14}
                cellGap={4}
                minWidth={1040}
              />
            )}
          </>
        ) : chartData.length === 0 ? (
          <EmptyBlock message={t('usage.noSeriesData')} />
        ) : (
          <HeatmapStackedBars
            daily={
              heatmapMetric === 'tokens' ? heatmapStackedDaily.tokens : heatmapStackedDaily.cost
            }
            fromDate={chartData[0]?.date}
            toDate={chartData[chartData.length - 1]?.date}
            groupBy={heatmapBucket}
            cumulative
            // Tokens=cyan family / cost=magenta family. Per-project hue is
            // hash-derived inside the family so adjacent projects stay
            // distinguishable while the metric remains visually identifiable.
            scheme={heatmapMetric === 'tokens' ? 'cyan' : 'magenta'}
            // Composite color map. Both views share the synthetic neutrals
            // (untracked / idle); the tokens view additionally derives a
            // per-source variant per project — claude = base hue, codex
            // = same hue lightened (+15) — so the user sees "this project,
            // its claude part, its codex part" inside one segment block.
            colorMap={cumulColorMap}
            totalLabel={
              heatmapMetric === 'tokens'
                ? providerTokenTitle(tokenLens).toLowerCase()
                : t('usage.heatmap.metricCostLabel')
            }
            // Cost view: render values as locale-aware EUR currency (no
            // decimals at compact magnitudes). Header/tooltip share the
            // same formatter as the Y-axis ticks for consistent readout.
            valueFormatter={
              heatmapMetric === 'cost'
                ? (value: number) =>
                    new Intl.NumberFormat(numberLocale(locale), {
                      style: 'currency',
                      currency: 'EUR',
                      maximumFractionDigits: 0,
                    }).format(value)
                : undefined
            }
            height={360}
          />
        )}
      </Panel>

      <div className="rounded-xl border border-slate-800 bg-slate-950/45 p-3">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-slate-100">{t('usage.analytics.title')}</h2>
            <p className="text-xs text-slate-500">
              {t('usage.analytics.subtitle', {
                claudePath: '`~/.claude/projects`',
                codexPath: '`~/.codex/sessions`',
              })}
            </p>
          </div>

          <div className="flex items-center gap-3">
            <LabeledSelect
              label={t('usage.filters.source')}
              value={analyticsProvider}
              options={ANALYTICS_PROVIDER_KEYS.map((k) => ({
                value: k,
                label: t(`usage.analyticsProvider.${k}`),
              }))}
              onChange={(value) => setAnalyticsProvider(value as AnalyticsProvider)}
            />

            {analyticsProvider === 'claude' && jsonlMeta ? (
              <div className="text-right text-xs text-slate-500">
                <div>
                  {t('usage.analytics.filesLines', {
                    files: jsonlMeta.filesScanned,
                    lines: numberLabel(jsonlMeta.linesParsed),
                  })}
                </div>
                <div>
                  {t('usage.analytics.repliesPrompts', {
                    replies: numberLabel(jsonlMeta.assistantMessages),
                    prompts: numberLabel(jsonlMeta.userMessages),
                  })}
                </div>
              </div>
            ) : null}

            {analyticsProvider === 'codex' && codexJsonlMeta ? (
              <div className="text-right text-xs text-slate-500">
                <div>
                  {codexJsonlMeta.filesScanned >= 0
                    ? t('usage.analytics.filesLines', {
                        files: codexJsonlMeta.filesScanned,
                        lines: numberLabel(codexJsonlMeta.linesParsed),
                      })
                    : t('usage.analytics.dbAggregated')}
                </div>
                <div>
                  {numberLabel(codexJsonlMeta.turns ?? 0)} {t('usage.metricLines.userPrompts')} ·{' '}
                  {numberLabel(codexJsonlMeta.sessions ?? 0)} sessions
                </div>
              </div>
            ) : null}
          </div>
        </div>

        {analyticsProvider === 'claude' ? (
          <ClaudeAnalytics
            byProject={byProject}
            byModel={byModel}
            hourly={hourly}
            toolUsage={toolUsage}
            rateLimits={claudeRateLimits}
            selectedProjectRef={selectedProjectRef}
            setSelectedProjectRef={setSelectedProjectRef}
            selectedProject={selectedProject}
            isToolUsageLoading={isToolUsageLoading}
            toolUsageError={toolUsageError}
          />
        ) : (
          <CodexAnalytics
            byProject={codexByProject}
            byModel={codexByModel}
            hourly={codexHourly}
            tools={codexTools}
            rateLimits={codexRateLimits}
            selectedProjectRef={selectedCodexProjectRef}
            setSelectedProjectRef={setSelectedCodexProjectRef}
            isLoading={isCodexLoading}
            isToolsLoading={isCodexToolLoading}
            error={codexError}
            toolsError={codexToolError}
          />
        )}
      </div>

      {isLoading ? (
        <p className="text-[12px] text-[var(--text-dim)]">{t('usage.analytics.refreshing')}</p>
      ) : null}
    </div>
  );
}

function Panel({
  title,
  subtitle,
  children,
  className,
  action,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  className?: string;
  action?: ReactNode;
}) {
  return (
    <div
      className={`rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface-1)] p-4 ${className || ''}`.trim()}
    >
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-[14px] font-semibold text-[var(--text)]">{title}</h2>
          {subtitle ? (
            <p className="mt-0.5 text-[12px] text-[var(--text-dim)]">{subtitle}</p>
          ) : null}
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </div>
      {children}
    </div>
  );
}

function LabeledSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
}) {
  return (
    <label className="flex flex-col gap-1.5 text-[11px] uppercase tracking-[0.08em] text-[var(--text-dim)]">
      <span>{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function SourceBadge({
  label,
  hasData,
  warning,
  tone: _tone,
}: {
  label: string;
  hasData: boolean;
  warning: string | null;
  tone: ProviderTone;
}) {
  const banner = warning ? 'warning' : hasData ? 'ready' : 'empty';
  const chipTone =
    banner === 'ready' ? 'success' : banner === 'warning' ? 'warn' : ('neutral' as const);
  return (
    <span
      className={`chip chip-${chipTone} text-[11px]`.replace('chip-neutral', '')}
      title={warning || undefined}
    >
      <span className="font-medium">{label}</span>
      <span className="opacity-70">{banner}</span>
    </span>
  );
}

function ProviderSummaryCard({
  title,
  tone,
  lens,
  selectedTokens,
  activeTokens,
  cacheTokens,
  cost,
  tokenShare,
  costShare,
}: {
  title: string;
  tone: ProviderTone;
  lens: TokenLens;
  selectedTokens: number;
  activeTokens: number;
  cacheTokens: number;
  cost: number;
  tokenShare: number;
  costShare: number;
}) {
  const { t } = useTranslation();
  const accent =
    tone === 'cyan'
      ? { value: 'text-[#64d2ff]', border: 'border-[rgba(100,210,255,0.28)]' }
      : { value: 'text-[#ffd60a]', border: 'border-[rgba(255,214,10,0.28)]' };

  return (
    <div className={`rounded-[var(--radius-lg)] border ${accent.border} bg-[var(--surface-1)] p-4`}>
      <div className="text-[11px] uppercase tracking-[0.08em] text-[var(--text-dim)]">{title}</div>
      <div className={`mt-1 text-[26px] font-semibold tracking-tight num ${accent.value}`}>
        {numberLabel(selectedTokens)}
      </div>
      <div className="mt-0.5 text-[12px] text-[var(--text-dim)]">{providerTokenTitle(lens)}</div>

      <div className="mt-3 flex flex-col gap-1">
        <MetricLine label={t('usage.metricLines.active')} value={numberLabel(activeTokens)} />
        <MetricLine label={t('usage.metricLines.cache')} value={numberLabel(cacheTokens)} />
        <MetricLine label={t('usage.metricLines.cost')} value={currencyLabel(cost)} />
        <MetricLine label={t('usage.metricLines.tokenShare')} value={percentLabel(tokenShare)} />
        <MetricLine label={t('usage.metricLines.costShare')} value={percentLabel(costShare)} />
      </div>
    </div>
  );
}

function MetricCard({
  title,
  value,
  valueTone,
  children,
}: {
  title: string;
  value: string;
  valueTone?: string;
  children: ReactNode;
}) {
  return (
    <div className="rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface-1)] p-4">
      <div className="text-[11px] uppercase tracking-[0.08em] text-[var(--text-dim)]">{title}</div>
      <div
        className={`mt-1 text-[26px] font-semibold tracking-tight num ${valueTone || 'text-[#30d158]'}`}
      >
        {value}
      </div>
      <div className="mt-3 flex flex-col gap-1">{children}</div>
    </div>
  );
}

function MetricLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-2 text-[12px]">
      <span className="text-[var(--text-dim)]">{label}</span>
      <span className="num text-[var(--text-mute)]">{value}</span>
    </div>
  );
}

function EmptyBlock({ message }: { message: string }) {
  return (
    <div className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-1)] px-3 py-6 text-center text-sm text-[var(--text-dim)]">
      {message}
    </div>
  );
}

function euroLabel(value: number): string {
  return new Intl.NumberFormat(numberLocale(currentLocale()), {
    style: 'currency',
    currency: 'EUR',
    maximumFractionDigits: 0,
  }).format(Math.round(value));
}

function EconomyCard({
  claudeCostUsd,
  codexCostUsd,
  claudePaidEur,
  codexPaidEur,
  firstDate,
  lastDate,
  meteredFirstDate,
  subs,
}: {
  claudeCostUsd: number;
  codexCostUsd: number;
  claudePaidEur: number;
  codexPaidEur: number;
  firstDate: string | null;
  lastDate: string | null;
  meteredFirstDate: string | null;
  subs: SubscriptionSettings;
}) {
  const { t } = useTranslation();
  // All-time vue : cumul réel payé (cash basis depuis billingHistory) vs cumul PAYG simulé.
  const claudeMeteredEur = claudeCostUsd * subs.usdToEur;
  const codexMeteredEur = codexCostUsd * subs.usdToEur;
  const totalMeteredEur = claudeMeteredEur + codexMeteredEur;

  const totalPaidEur = claudePaidEur + codexPaidEur;
  const claudeSavingsEur = claudeMeteredEur - claudePaidEur;
  const codexSavingsEur = codexMeteredEur - codexPaidEur;
  const totalSavingsEur = totalMeteredEur - totalPaidEur;
  const ratio = totalPaidEur > 0 ? totalMeteredEur / totalPaidEur : 0;

  const spanDays =
    firstDate && lastDate
      ? Math.max(
          1,
          Math.round(
            (new Date(`${lastDate}T00:00:00Z`).getTime() -
              new Date(`${firstDate}T00:00:00Z`).getTime()) /
              86_400_000,
          ) + 1,
        )
      : 0;
  const firstLabel = firstDate
    ? new Date(`${firstDate}T00:00:00Z`).toLocaleDateString(dateLocale(currentLocale()), {
        day: '2-digit',
        month: 'short',
        year: '2-digit',
      })
    : '—';

  // Durée réelle couverte par les données métrées ccusage
  // (peut être plus courte que l'historique d'abo si ccusage n'a pas tout synchronisé).
  const meteredDays =
    meteredFirstDate && lastDate
      ? Math.max(
          1,
          Math.round(
            (new Date(`${lastDate}T00:00:00Z`).getTime() -
              new Date(`${meteredFirstDate}T00:00:00Z`).getTime()) /
              86_400_000,
          ) + 1,
        )
      : 0;

  return (
    <div className="rounded-[var(--radius-lg)] border border-[rgba(48,209,88,0.28)] bg-[rgba(48,209,88,0.05)] p-4">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <div className="text-[11px] uppercase tracking-[0.08em] text-[var(--text-dim)]">
            {t('usage.economy.headline')}
          </div>
          <div className="mt-1 flex items-baseline gap-2">
            <span className="num text-[32px] font-semibold tracking-tight text-[#30d158]">
              {totalSavingsEur >= 0 ? '+' : '−'}
              {euroLabel(Math.abs(totalSavingsEur))}
            </span>
            <span className="text-[12px] text-[var(--text-dim)]">
              {t('usage.economy.savedSuffix')}
            </span>
          </div>
          <div className="mt-0.5 text-[12px] text-[var(--text-mute)]">
            {t('usage.economy.summary', {
              paid: euroLabel(totalPaidEur),
              metered: euroLabel(totalMeteredEur),
              ratio: ratio.toFixed(1),
            })}
          </div>
        </div>
        <div className="text-right text-[11px] text-[var(--text-dim)]">
          {t('usage.economy.sinceSingle', { date: firstLabel })}
          <br />
          {t('usage.economy.historyDays', { n: spanDays })}
          {meteredDays > 0 && meteredDays !== spanDays ? (
            <>
              {' · '}
              {t('usage.economy.meteredDays', { n: meteredDays })}
            </>
          ) : null}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
        <EconomyRow
          provider="Claude"
          plan={subs.claude.plan}
          paidEur={claudePaidEur}
          meteredEur={claudeMeteredEur}
          savingsEur={claudeSavingsEur}
          tone="cyan"
        />
        <EconomyRow
          provider="Codex"
          plan={subs.codex.plan}
          paidEur={codexPaidEur}
          meteredEur={codexMeteredEur}
          savingsEur={codexSavingsEur}
          tone="amber"
        />
      </div>

      <div className="mt-3 text-[11px] text-[var(--text-faint)]">
        {t('usage.economy.basedOnRate', { rate: subs.usdToEur.toFixed(2) })}{' '}
        <a href="/settings" className="text-[var(--accent)]">
          {t('usage.economy.settingsLink')}
        </a>
        .
      </div>
    </div>
  );
}

function EconomyRow({
  provider,
  plan,
  paidEur,
  meteredEur,
  savingsEur,
  tone,
}: {
  provider: string;
  plan: string;
  paidEur: number;
  meteredEur: number;
  savingsEur: number;
  tone: 'cyan' | 'amber';
}) {
  const { t } = useTranslation();
  const accent = tone === 'cyan' ? 'text-[#64d2ff]' : 'text-[#ffd60a]';
  const savingsTone = savingsEur >= 0 ? 'text-[#30d158]' : 'text-[#ff453a]';
  const ratio = paidEur > 0 ? meteredEur / paidEur : 0;
  return (
    <div className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-1)] px-3 py-2">
      <div className="flex items-baseline justify-between gap-2">
        <div>
          <div className={`text-[13px] font-medium ${accent}`}>{provider}</div>
          <div className="text-[11px] text-[var(--text-dim)]">{plan}</div>
        </div>
        <div className={`num text-[18px] font-semibold ${savingsTone}`}>
          {savingsEur >= 0 ? '+' : '−'}
          {euroLabel(Math.abs(savingsEur))}
        </div>
      </div>
      <div className="mt-2 flex flex-col gap-1 text-[12px]">
        <div className="flex items-center justify-between">
          <span className="text-[var(--text-dim)]">{t('usage.economyRow.paidCumul')}</span>
          <span className="num text-[var(--text-mute)]">{euroLabel(paidEur)}</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-[var(--text-dim)]">{t('usage.economyRow.ifPayg')}</span>
          <span className="num text-[var(--text-mute)]">{euroLabel(meteredEur)}</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-[var(--text-dim)]">{t('usage.economyRow.ratio')}</span>
          <span className={`num ${savingsTone}`}>×{ratio.toFixed(1)}</span>
        </div>
      </div>
    </div>
  );
}

type CompactStatTone = 'default' | 'emerald' | 'amber' | 'cyan' | 'rose';

function CompactStatsStrip({
  items,
}: {
  items: Array<{ label: string; value: string; tone?: CompactStatTone; hint?: string }>;
}) {
  const toneClass = (tone?: CompactStatTone) => {
    switch (tone) {
      case 'emerald':
        return 'text-[#30d158]';
      case 'amber':
        return 'text-[#ffd60a]';
      case 'cyan':
        return 'text-[#64d2ff]';
      case 'rose':
        return 'text-[#ff453a]';
      default:
        return 'text-[var(--text)]';
    }
  };
  return (
    <div className="grid grid-cols-3 gap-2 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-1)] px-3 py-2 sm:grid-cols-6">
      {items.map((item) => (
        <div key={item.label} className="min-w-0" title={item.hint || undefined}>
          <div className="truncate text-[10px] uppercase tracking-[0.08em] text-[var(--text-dim)]">
            {item.label}
          </div>
          <div
            className={`num truncate text-[16px] font-semibold tracking-tight ${toneClass(item.tone)}`}
          >
            {item.value}
          </div>
        </div>
      ))}
    </div>
  );
}

function HourSparkline({
  data,
  accent,
  height = 36,
}: {
  data: Array<{ hour: number; value: number }>;
  accent: string;
  height?: number;
}) {
  if (data.length === 0) {
    return null;
  }
  const max = Math.max(1, ...data.map((d) => d.value));
  const step = 100 / Math.max(1, data.length);
  return (
    <div className="mt-3 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-1)] px-3 py-2">
      <div className="flex items-center justify-between text-[10px] uppercase tracking-[0.08em] text-[var(--text-dim)]">
        <span>0h</span>
        <span>12h</span>
        <span>23h</span>
      </div>
      <svg
        role="img"
        aria-label="Hourly distribution"
        className="mt-1 block w-full"
        viewBox={`0 0 100 ${height}`}
        preserveAspectRatio="none"
        style={{ height }}
      >
        {data.map((d) => {
          const h = Math.max(1, Math.round((d.value / max) * (height - 2)));
          const x = d.hour * step;
          return (
            <rect
              key={d.hour}
              x={x + step * 0.15}
              y={height - h}
              width={step * 0.7}
              height={h}
              fill={accent}
              opacity={d.value === 0 ? 0.15 : 0.85}
              rx={0.6}
            />
          );
        })}
      </svg>
    </div>
  );
}

function CompactPanel({
  title,
  subtitle,
  action,
  children,
}: {
  title: string;
  subtitle?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-1)] px-3 py-2">
      <div className="mb-2 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="truncate text-[12px] font-semibold text-[var(--text)]">{title}</h3>
          {subtitle ? (
            <p className="truncate text-[10.5px] text-[var(--text-dim)]">{subtitle}</p>
          ) : null}
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </div>
      {children}
    </div>
  );
}

function ModelStackBar({
  items,
  accent: _accent,
}: {
  items: Array<{ model: string; tokens: number }>;
  accent: string;
}) {
  const palette = ['#64d2ff', '#30d158', '#ffd60a', '#bf5af2', '#ff9f0a', '#ff453a'];
  const total = items.reduce((acc, item) => acc + item.tokens, 0);
  if (total === 0) {
    return null;
  }
  return (
    <div>
      <div className="flex h-2 w-full overflow-hidden rounded bg-[var(--surface-2)]">
        {items.map((item, idx) => {
          const pct = (item.tokens / total) * 100;
          if (pct <= 0) return null;
          return (
            <div
              key={item.model}
              style={{ width: `${pct}%`, background: palette[idx % palette.length] }}
              title={`${item.model} · ${numberLabel(item.tokens)}`}
            />
          );
        })}
      </div>
      <ul className="mt-2 space-y-1">
        {items.map((item, idx) => {
          const pct = (item.tokens / total) * 100;
          return (
            <li key={item.model} className="flex items-center justify-between gap-2 text-[11.5px]">
              <span className="flex min-w-0 items-center gap-1.5">
                <span
                  className="inline-block h-2 w-2 shrink-0 rounded-sm"
                  style={{ background: palette[idx % palette.length] }}
                />
                <span className="truncate text-[var(--text)]">{item.model}</span>
              </span>
              <span className="flex shrink-0 items-center gap-2 text-[var(--text-dim)]">
                <span className="num">{numberLabel(item.tokens)}</span>
                <span className="num text-[var(--text-mute)]">{pct.toFixed(1)}%</span>
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function ToolsList({
  tools,
  accent,
}: {
  tools: ToolUsageRow[];
  accent: string;
}) {
  if (tools.length === 0) {
    return null;
  }
  const max = Math.max(1, ...tools.map((t) => t.count));
  return (
    <ul className="space-y-1">
      {tools.map((tool) => {
        const width = Math.max(4, Math.round((tool.count / max) * 100));
        return (
          <li key={tool.name} className="flex items-center gap-2 text-[11.5px]">
            <span className="w-28 shrink-0 truncate text-[var(--text)]" title={tool.name}>
              {tool.name}
            </span>
            <span className="relative h-1.5 flex-1 rounded bg-[var(--surface-2)]">
              <span
                className={`absolute inset-y-0 left-0 rounded ${accent}`}
                style={{ width: `${width}%` }}
              />
            </span>
            <span className="num w-12 shrink-0 text-right text-[var(--text-dim)]">
              {tool.count}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function ClaudeAnalytics({
  byProject,
  byModel,
  hourly,
  toolUsage,
  rateLimits,
  selectedProjectRef,
  setSelectedProjectRef,
  selectedProject,
  isToolUsageLoading,
  toolUsageError,
}: {
  byProject: ProjectUsageRow[];
  byModel: ModelUsageRow[];
  hourly: HourDistributionRow[];
  toolUsage: ToolUsageRow[];
  rateLimits: ClaudeRateLimitsPayload['rateLimits'];
  selectedProjectRef: string;
  setSelectedProjectRef: (value: string) => void;
  selectedProject: ProjectUsageRow | null;
  isToolUsageLoading: boolean;
  toolUsageError: string | null;
}) {
  const { t } = useTranslation();

  const totals = byProject.reduce(
    (acc, row) => {
      acc.inputTokens += row.inputTokens;
      acc.outputTokens += row.outputTokens;
      acc.cacheRead += row.cacheRead;
      acc.cacheCreate += row.cacheCreate;
      acc.sessions += row.sessions;
      acc.assistantMessages += row.assistantMessages;
      acc.userMessages += row.userMessages;
      return acc;
    },
    {
      inputTokens: 0,
      outputTokens: 0,
      cacheRead: 0,
      cacheCreate: 0,
      sessions: 0,
      assistantMessages: 0,
      userMessages: 0,
    },
  );
  const avgOutput =
    totals.assistantMessages > 0 ? totals.outputTokens / totals.assistantMessages : 0;
  const cachePct =
    totals.cacheRead + totals.inputTokens > 0
      ? (totals.cacheRead / (totals.cacheRead + totals.inputTokens)) * 100
      : 0;

  const models = byModel.slice(0, 6).map((row) => ({
    model: row.model,
    tokens: row.inputTokens + row.outputTokens + row.cacheRead + row.cacheCreate,
  }));

  return (
    <>
      {toolUsageError ? (
        <div className="mb-3 rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-200">
          {toolUsageError}
        </div>
      ) : null}

      <CompactStatsStrip
        items={[
          { label: t('usage.metricLines.projectsShort'), value: String(byProject.length) },
          { label: 'Sessions', value: numberLabel(totals.sessions) },
          { label: t('usage.metricLines.replies'), value: numberLabel(totals.assistantMessages) },
          { label: t('usage.metricLines.userPrompts'), value: numberLabel(totals.userMessages) },
          {
            label: t('usage.metricLines.reuseRatio'),
            value: percentLabel(cachePct),
            tone: 'emerald',
          },
          { label: 'Output/reply', value: numberLabel(avgOutput), tone: 'amber' },
        ]}
      />

      {rateLimits && (rateLimits.primary || rateLimits.secondary || rateLimits.tertiary) ? (
        <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-3">
          <RateLimitRow
            label={t('usage.metricLines.limit5h')}
            rate={rateLimits.primary}
            planType={rateLimits.planType || null}
            observedAt={rateLimits.observedAt || null}
            tone="cyan"
          />
          <RateLimitRow
            label={t('usage.metricLines.limit7d')}
            rate={rateLimits.secondary}
            planType={rateLimits.planType || null}
            observedAt={rateLimits.observedAt || null}
            tone="amber"
          />
          <RateLimitRow
            label={t('usage.metricLines.limit7dSonnet')}
            rate={rateLimits.tertiary}
            planType={rateLimits.planType || null}
            observedAt={rateLimits.observedAt || null}
            tone="cyan"
          />
        </div>
      ) : null}

      <HourSparkline
        data={hourly.map((h) => ({ hour: h.hour, value: h.tokens }))}
        accent="#22d3ee"
      />

      <div className="mt-3 grid grid-cols-1 gap-3 xl:grid-cols-2">
        <CompactPanel
          title={t('usage.panels.modelMix')}
          subtitle={t('usage.panels.modelMixClaudeSub')}
        >
          {models.length === 0 ? (
            <EmptyBlock message={t('usage.empty.models')} />
          ) : (
            <ModelStackBar items={models} accent="#10b981" />
          )}
        </CompactPanel>

        <CompactPanel
          title={t('usage.panels.toolUsage')}
          subtitle={t('usage.panels.toolUsageClaudeSub')}
          action={
            <select
              aria-label="Projet"
              className="max-w-[200px] rounded-md border border-slate-700 bg-slate-900 px-2 py-1 text-[11px] text-slate-200"
              value={selectedProjectRef}
              onChange={(event) => setSelectedProjectRef(event.target.value)}
              disabled={byProject.length === 0}
            >
              {byProject.length === 0 ? (
                <option value="">{t('usage.empty.projectNone')}</option>
              ) : null}
              {byProject.map((row) => (
                <option key={projectSelectorValue(row)} value={projectSelectorValue(row)}>
                  {shortProjectName(row)}
                </option>
              ))}
            </select>
          }
        >
          {selectedProject ? (
            <p className="mb-1.5 truncate text-[10.5px] text-slate-500">
              {shortProjectName(selectedProject)} · {numberLabel(selectedProject.totalTokens)} tok ·{' '}
              {selectedProject.assistantMessages} replies · {selectedProject.sessions} sess
            </p>
          ) : null}
          {isToolUsageLoading ? (
            <EmptyBlock message={t('common.loading')} />
          ) : toolUsage.length === 0 ? (
            <EmptyBlock message={t('usage.empty.toolsUsage')} />
          ) : (
            <ToolsList tools={toolUsage.slice(0, 8)} accent="bg-cyan-400" />
          )}
        </CompactPanel>
      </div>
    </>
  );
}

function CodexAnalytics({
  byProject,
  byModel,
  hourly,
  tools,
  rateLimits,
  selectedProjectRef,
  setSelectedProjectRef,
  isLoading,
  isToolsLoading,
  error,
  toolsError,
}: {
  byProject: CodexProjectUsageRow[];
  byModel: CodexModelUsageRow[];
  hourly: CodexHourDistributionRow[];
  tools: ToolUsageRow[];
  rateLimits: CodexRateLimitsPayload['rateLimits'];
  selectedProjectRef: string;
  setSelectedProjectRef: (value: string) => void;
  isLoading: boolean;
  isToolsLoading: boolean;
  error: string | null;
  toolsError: string | null;
}) {
  const { t } = useTranslation();
  const selected = byProject.find((row) => projectSelectorValue(row) === selectedProjectRef);

  const totals = byProject.reduce(
    (acc, row) => {
      acc.tokens += row.totalTokens;
      acc.turns += row.turns;
      acc.sessions += row.sessions;
      acc.input += row.inputTokens;
      acc.cached += row.cachedInputTokens;
      acc.reasoning += row.reasoningOutputTokens;
      return acc;
    },
    { tokens: 0, turns: 0, sessions: 0, input: 0, cached: 0, reasoning: 0 },
  );
  // cache hit ratio = cached / total input seen (inputNet + cached).
  // `totals.input` stores inputNet (raw − cached) from the Codex parser, so
  // the denominator must add `cached` back to reconstruct the raw input.
  // Previously used `cached / inputNet`, which could exceed 100% (observed
  // 2193.8% when the vast majority of tokens were cache hits).
  const cacheDenom = totals.input + totals.cached;
  const cacheRatio = cacheDenom > 0 ? (totals.cached / cacheDenom) * 100 : 0;

  const models = byModel.slice(0, 6).map((row) => ({
    model: row.model,
    tokens: row.totalTokens,
  }));

  return (
    <>
      {error ? (
        <div className="mb-3 rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-200">
          {error}
        </div>
      ) : null}

      {isLoading ? (
        <p className="mb-2 text-[11px] text-[var(--text-dim)]">
          {t('usage.analytics.codexLoading')}
        </p>
      ) : null}

      <CompactStatsStrip
        items={[
          { label: t('usage.metricLines.projectsShort'), value: String(byProject.length) },
          { label: 'Sessions', value: numberLabel(totals.sessions) },
          { label: 'Turns', value: numberLabel(totals.turns) },
          { label: 'Tokens', value: numberLabel(totals.tokens) },
          {
            label: t('usage.metricLines.cacheHitRatio'),
            value: percentLabel(cacheRatio),
            tone: 'emerald',
          },
          { label: 'Reasoning', value: numberLabel(totals.reasoning), tone: 'amber' },
        ]}
      />

      <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
        <RateLimitRow
          label={t('usage.metricLines.limit5h')}
          rate={rateLimits?.primary || null}
          planType={rateLimits?.planType || null}
          observedAt={rateLimits?.observedAt || null}
          tone="cyan"
        />
        <RateLimitRow
          label={t('usage.metricLines.limit7d')}
          rate={rateLimits?.secondary || null}
          planType={rateLimits?.planType || null}
          observedAt={rateLimits?.observedAt || null}
          tone="amber"
        />
      </div>

      <HourSparkline
        data={hourly.map((h) => ({ hour: h.hour, value: h.tokens }))}
        accent="#ffd60a"
      />

      <div className="mt-3 grid grid-cols-1 gap-3 xl:grid-cols-2">
        <CompactPanel
          title={t('usage.panels.modelMix')}
          subtitle={t('usage.panels.modelMixCodexSub')}
        >
          {models.length === 0 ? (
            <EmptyBlock message={t('usage.empty.modelsCodex')} />
          ) : (
            <ModelStackBar items={models} accent="#ffd60a" />
          )}
        </CompactPanel>

        <CompactPanel
          title={t('usage.panels.toolUsage')}
          subtitle={t('usage.panels.toolUsageCodexSub')}
          action={
            <select
              aria-label="Projet"
              id="codex-project-tool-filter"
              className="max-w-[200px] rounded-md border border-slate-700 bg-slate-900 px-2 py-1 text-[11px] text-slate-200"
              value={selectedProjectRef}
              onChange={(event) => setSelectedProjectRef(event.target.value)}
              disabled={byProject.length === 0}
            >
              {byProject.length === 0 ? (
                <option value="">{t('usage.empty.projectNone')}</option>
              ) : null}
              {byProject.map((row) => (
                <option key={projectSelectorValue(row)} value={projectSelectorValue(row)}>
                  {shortProjectName(row)}
                </option>
              ))}
            </select>
          }
        >
          {selected ? (
            <p className="mb-1.5 truncate text-[10.5px] text-slate-500">
              {shortProjectName(selected)} · {numberLabel(selected.totalTokens)} tok ·{' '}
              {selected.turns} turns · {selected.sessions} sess
            </p>
          ) : null}
          {toolsError ? (
            <div className="mb-2 rounded-md border border-red-500/40 bg-red-500/10 px-2 py-1 text-xs text-red-200">
              {toolsError}
            </div>
          ) : null}
          {isToolsLoading ? (
            <EmptyBlock message={t('common.loading')} />
          ) : tools.length === 0 ? (
            <EmptyBlock message={t('usage.empty.toolsUsage')} />
          ) : (
            <ToolsList tools={tools.slice(0, 8)} accent="bg-amber-400" />
          )}
        </CompactPanel>
      </div>
    </>
  );
}

function RateLimitRow({
  label,
  rate,
  planType,
  observedAt,
  tone,
}: {
  label: string;
  rate: { usedPercent: number; windowMinutes: number; resetsAt: number } | null;
  planType: string | null;
  observedAt: number | null;
  tone: ProviderTone;
}) {
  const { t } = useTranslation();
  const accent =
    tone === 'cyan'
      ? { bar: 'bg-[#64d2ff]', value: 'text-[#64d2ff]', border: 'border-[rgba(100,210,255,0.28)]' }
      : { bar: 'bg-[#ffd60a]', value: 'text-[#ffd60a]', border: 'border-[rgba(255,214,10,0.28)]' };

  if (!rate) {
    return (
      <div
        className={`rounded-[var(--radius)] border ${accent.border} bg-[var(--surface-1)] px-3 py-2`}
      >
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-[11px] uppercase tracking-[0.08em] text-[var(--text-dim)]">
            {label}
          </span>
          <span className="num text-[14px] text-[var(--text-mute)]">n/a</span>
        </div>
        <div className="mt-1 text-[10.5px] text-[var(--text-dim)]">
          {t('usage.metricLines.limitNotObserved')}
        </div>
      </div>
    );
  }

  const clamped = Math.max(0, Math.min(100, rate.usedPercent));
  const resetsLabel = rate.resetsAt
    ? new Date(rate.resetsAt * 1000).toLocaleString(dateLocale(currentLocale()))
    : 'n/a';

  // Staleness detection: rate limits live only in CLI transcript events, so
  // the dashboard only knows the value captured at the last token_count.
  // Two cases to surface:
  //  - `expired`: the window this value describes has reset since observation
  //    → displayed % is no longer meaningful, real usage may be much lower
  //    or different. Strongest signal to ignore the bar.
  //  - `aged`: observation older than 1h but window hasn't reset yet
  //    → value is directionally correct but may have grown since.
  const nowSec = Math.floor(Date.now() / 1000);
  const windowReset = rate.resetsAt > 0 && nowSec >= rate.resetsAt;
  const agedSec = observedAt ? nowSec - observedAt : 0;
  const aged = !windowReset && agedSec > 3600;
  const observedLabel = observedAt
    ? new Date(observedAt * 1000).toLocaleString(dateLocale(currentLocale()))
    : 'n/a';

  return (
    <div
      className={`rounded-[var(--radius)] border ${accent.border} bg-[var(--surface-1)] px-3 py-2`}
      title={observedAt ? `${t('usage.metricLines.limitObservedAt')} ${observedLabel}` : undefined}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[11px] uppercase tracking-[0.08em] text-[var(--text-dim)]">
          {label}
        </span>
        <span
          className={`num text-[16px] font-semibold ${
            windowReset ? 'text-[var(--text-faint)] line-through' : accent.value
          }`}
        >
          {rate.usedPercent.toFixed(1)}%
        </span>
      </div>
      <div className="mt-1.5 h-1.5 rounded bg-[var(--surface-2)]">
        <div
          className={`h-1.5 rounded ${windowReset ? 'bg-[var(--surface-2)]' : accent.bar}`}
          style={{ width: `${clamped}%`, opacity: windowReset ? 0.3 : 1 }}
        />
      </div>
      <div className="mt-1 flex items-center justify-between gap-2 text-[10.5px] text-[var(--text-dim)]">
        <span>{planType || '—'}</span>
        {windowReset ? (
          <span className="text-[var(--warn)]">{t('usage.metricLines.limitWindowReset')}</span>
        ) : aged ? (
          <span className="text-[var(--text-mute)]">
            {t('usage.metricLines.limitAged', {
              ago: formatAge(agedSec),
            })}
          </span>
        ) : null}
        <span className="truncate">reset · {resetsLabel}</span>
      </div>
    </div>
  );
}

function formatAge(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}
