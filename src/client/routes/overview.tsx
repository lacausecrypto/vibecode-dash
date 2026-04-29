import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Heatmap } from '../components/Heatmap';
import { Card, ErrorBanner, Section, Segmented, Stat } from '../components/ui';
import { apiGet } from '../lib/api';
import { type Locale, dateLocale, numberLocale, useTranslation } from '../lib/i18n';

type Project = {
  id: string;
  name: string;
  health_score: number;
  type: string;
  last_commit_at: number | null;
  uncommitted: number;
};

type HeatmapDay = { date: string; count: number; color?: string | null };
type HeatmapResponse = { total: number; days: HeatmapDay[]; year?: number };
type UsageHeatmapSource = 'total' | 'claude' | 'codex';

type HeatmapMetric =
  | 'contrib'
  | 'views'
  | 'clones'
  | 'llm-total'
  | 'llm-claude'
  | 'llm-codex'
  | 'notes';

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
type DailyCombinedRow = {
  date: string;
  claudeInputTokens: number;
  claudeOutputTokens: number;
  claudeCacheCreateTokens: number;
  claudeCacheReadTokens: number;
  claudeTokens: number;
  claudeCostUsd: number;
  codexInputTokens: number;
  codexCachedInputTokens: number;
  codexOutputTokens: number;
  codexReasoningOutputTokens: number;
  codexTokens: number;
  codexCostUsd: number;
  // Per-vendor subscription cost (USD/day) — flat per billing cycle. Returned
  // by the server but previously unused on Overview; now powers the
  // per-vendor sub-leverage comparator. Optional because older API clients
  // or cached responses may not include these fields.
  claudeSubCostUsd?: number;
  codexSubCostUsd?: number;
  totalTokens: number;
  totalCostUsd: number;
};
type DailyCombinedResponse = { rows: DailyCombinedRow[] };
type ObsidianActivityDay = { date: string; notes: number };

type SettingsResponse = {
  subscriptions: {
    usdToEur: number;
    claude: { monthlyEur: number };
    codex: { monthlyEur: number };
  };
};

type TrendCardData = {
  title: string;
  value: string;
  deltaLabel: string;
  deltaPositive: boolean;
  sparkline: number[];
};

type CombinedDay = {
  date: string;
  github: number;
  tokens: number;
  cost: number;
  notes: number;
  views: number;
  clones: number;
  viewsUniques: number;
  clonesUniques: number;
  // Raw totals including cache (kept for cache-ROI-style comparisons).
  claudeTokens: number;
  codexTokens: number;
  claudeCost: number;
  codexCost: number;
  // Per-vendor daily subscription cost in USD (flat per billing cycle).
  // Used by the sub-leverage comparator (PAYG ÷ sub per CLI).
  claudeSubCost: number;
  codexSubCost: number;
  // Per-provider cache volume (for Claude vs Codex cache comparator).
  // Claude = cache_create + cache_read, Codex = cached_input (no create).
  claudeCacheTotalTokens: number;
  codexCacheTotalTokens: number;
  // Fresh tokens = input + output, cache excluded. Apples-to-apples across
  // providers — cache_read for Claude and cached_input for Codex are removed
  // upstream so Codex's volume is not dwarfed by Claude's heavy cache reuse.
  claudeFreshTokens: number;
  codexFreshTokens: number;
  // Pure output (what the model actually wrote, visible to the user). Does
  // NOT include Codex reasoning (reasoning is internal thinking, surfaced
  // separately in `codexReasoningTokens`).
  claudeOutputTokens: number;
  codexOutputTokens: number;
  // Cross-provider aggregates, cache-excluded so percentages and ratios are
  // honest. inputTokens previously over-counted cached_input twice.
  activeTokens: number;
  cachedTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
  codexReasoningTokens: number;
  codexResponseTokens: number;
};

type VsModeKey =
  | 'cld-cdx-tokens'
  | 'cld-cdx-cost'
  | 'cld-cdx-sub-leverage'
  | 'active-cached'
  | 'payg-abo'
  | 'views-clones'
  | 'views-uniques'
  | 'commits-tokens'
  | 'input-output'
  | 'cache-read-create'
  | 'cld-cdx-cache'
  | 'codex-reason-output'
  | 'tokens-views'
  | 'clones-uniques'
  | 'commits-cost'
  | 'commits-output'
  | 'commits-notes'
  | 'cost-tokens'
  | 'cost-output';

type VsModeCtx = {
  subDailyUsd: number;
  subClaudeUsd: number;
  subCodexUsd: number;
};

type VsModeConfig = {
  segLabel?: string;
  title?: string;
  legendA?: string;
  legendB?: string;
  colorA: string;
  colorB: string;
  getA: (day: CombinedDay) => number;
  getB: (day: CombinedDay, ctx: VsModeCtx) => number;
  formatValue: (value: number) => string;
  leverageLabel?: string;
  leverageValue: (totalA: number, totalB: number, ctx?: VsModeCtx) => string;
  insight?: string;
  // Si true: les deux séries partagent la même échelle (100% = max des deux).
  // À activer uniquement quand A et B ont la même unité.
  sharedScale?: boolean;
};

function yyyymmddFromDate(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

function daysAgo(days: number): Date {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  return date;
}

function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function addUtcDays(date: Date, days: number): Date {
  const copy = new Date(date);
  copy.setUTCDate(copy.getUTCDate() + days);
  return copy;
}

function isoUtcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function sumDateRange(
  valuesByDate: Map<string, number>,
  startInclusive: Date,
  endInclusive: Date,
): number {
  let sumValue = 0;
  for (let day = startOfUtcDay(startInclusive); day <= endInclusive; day = addUtcDays(day, 1)) {
    sumValue += valuesByDate.get(isoUtcDay(day)) || 0;
  }
  return sumValue;
}

function valuesDateRange(
  valuesByDate: Map<string, number>,
  startInclusive: Date,
  endInclusive: Date,
): number[] {
  const out: number[] = [];
  for (let day = startOfUtcDay(startInclusive); day <= endInclusive; day = addUtcDays(day, 1)) {
    out.push(valuesByDate.get(isoUtcDay(day)) || 0);
  }
  return out;
}

function usageHeatmapSourceLabel(source: UsageHeatmapSource): string {
  if (source === 'claude') {
    return 'Claude';
  }
  if (source === 'codex') {
    return 'Codex';
  }
  return 'Total';
}

type HeatmapMetricConfig = {
  label: string;
  palette: 'github' | 'cyan' | 'amber';
  unit: string;
};

const HEATMAP_METRIC_CONFIG: Record<HeatmapMetric, HeatmapMetricConfig> = {
  contrib: { label: 'Contribs GitHub', palette: 'github', unit: 'contribs' },
  views: { label: 'Views', palette: 'cyan', unit: 'views' },
  clones: { label: 'Clones', palette: 'amber', unit: 'clones' },
  'llm-total': { label: 'LLM total', palette: 'github', unit: 'tokens' },
  'llm-claude': { label: 'LLM Claude', palette: 'cyan', unit: 'tokens' },
  'llm-codex': { label: 'LLM Codex', palette: 'amber', unit: 'tokens' },
  notes: { label: 'Notes vault', palette: 'cyan', unit: 'notes' },
};

function metricLabelKey(metric: HeatmapMetric): string {
  switch (metric) {
    case 'llm-total':
      return 'llmTotal';
    case 'llm-claude':
      return 'llmClaude';
    case 'llm-codex':
      return 'llmCodex';
    default:
      return metric;
  }
}

function buildAnnualDates(year: number): string[] {
  const out: string[] = [];
  const cursor = new Date(Date.UTC(year, 0, 1));
  const end = new Date(Date.UTC(year, 11, 31));
  while (cursor <= end) {
    out.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return out;
}

function toDateLabel(dateIso: string, locale: Locale): string {
  const date = new Date(`${dateIso}T00:00:00Z`);
  return date.toLocaleDateString(dateLocale(locale), { month: 'short', day: '2-digit' });
}

function percentageDelta(current: number, previous: number): number {
  if (previous <= 0) {
    return current > 0 ? 100 : 0;
  }
  return ((current - previous) / previous) * 100;
}

function formatDelta(
  current: number,
  previous: number,
  tr: (key: string, vars?: Record<string, string | number>) => string,
): { deltaLabel: string; deltaPositive: boolean } {
  const delta = percentageDelta(current, previous);
  const rounded = Math.round(delta);
  const deltaPositive = delta >= 0;
  const sign = deltaPositive ? '+' : '';
  return {
    deltaLabel: tr('overview.delta7d', { sign, value: rounded }),
    deltaPositive,
  };
}

function daysSinceCommit(ts: number | null): number | null {
  if (!ts) {
    return null;
  }
  const now = Math.floor(Date.now() / 1000);
  return Math.floor((now - ts) / 86400);
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

function numberLabel(value: number, locale: Locale = 'fr'): string {
  return Intl.NumberFormat(numberLocale(locale)).format(Math.round(value));
}

function compactNumberLabel(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) {
    return `${(value / 1_000_000_000).toFixed(abs >= 10_000_000_000 ? 0 : 1)} Md`;
  }
  if (abs >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1)} M`;
  }
  if (abs >= 1_000) {
    return `${(value / 1_000).toFixed(abs >= 10_000 ? 0 : 1)} k`;
  }
  return numberLabel(value);
}

function usdLabel(value: number): string {
  return `$${value.toFixed(2)}`;
}

function ratioLabel(a: number, b: number, suffix = '×'): string {
  if (b <= 0) {
    return a > 0 ? '∞' : '—';
  }
  const ratio = a / b;
  if (ratio >= 100) {
    return `${ratio.toFixed(0)}${suffix}`;
  }
  if (ratio >= 10) {
    return `${ratio.toFixed(1)}${suffix}`;
  }
  return `${ratio.toFixed(2)}${suffix}`;
}

function percentLabel(ratio: number): string {
  if (!Number.isFinite(ratio)) {
    return '—';
  }
  const pct = Math.round(ratio * 100);
  return `${pct >= 0 ? '+' : ''}${pct}%`;
}

const VS_MODES: Record<VsModeKey, VsModeConfig> = {
  'cld-cdx-tokens': {
    colorA: '#64d2ff',
    colorB: '#ff9500',
    // Fresh tokens (input + output, no cache) — apples-to-apples. Previously
    // used cache-inclusive totals, which made Claude 500× bigger than Codex
    // on days with heavy cache_read and hid Codex's actual work.
    getA: (day) => day.claudeFreshTokens,
    getB: (day) => day.codexFreshTokens,
    formatValue: compactNumberLabel,
    leverageValue: (a, b) => ratioLabel(a, b),
    sharedScale: true,
  },
  'cld-cdx-cost': {
    colorA: '#64d2ff',
    colorB: '#ff9500',
    getA: (day) => day.claudeCost,
    getB: (day) => day.codexCost,
    formatValue: usdLabel,
    leverageValue: (a, b) => ratioLabel(a, b),
    sharedScale: true,
  },
  'active-cached': {
    colorA: '#30d158',
    colorB: '#64d2ff',
    getA: (day) => day.activeTokens,
    getB: (day) => day.cachedTokens,
    formatValue: compactNumberLabel,
    leverageValue: (a, b) => {
      const total = a + b;
      return total > 0 ? percentLabel(b / total) : '—';
    },
    sharedScale: true,
  },
  'payg-abo': {
    colorA: '#ffd60a',
    colorB: '#30d158',
    getA: (day) => day.cost,
    getB: (_day, ctx) => ctx.subDailyUsd,
    formatValue: usdLabel,
    leverageValue: (a, b) => ratioLabel(a, b),
    sharedScale: true,
  },
  'views-clones': {
    colorA: '#0a84ff',
    colorB: '#ff9500',
    getA: (day) => day.views,
    getB: (day) => day.clones,
    formatValue: numberLabel,
    leverageValue: (a, b) => ratioLabel(a, b),
  },
  'views-uniques': {
    colorA: '#0a84ff',
    colorB: '#bf5af2',
    getA: (day) => day.views,
    getB: (day) => day.viewsUniques,
    formatValue: numberLabel,
    leverageValue: (a, b) => ratioLabel(a, b),
    sharedScale: true,
  },
  'commits-tokens': {
    colorA: '#30d158',
    colorB: '#64d2ff',
    getA: (day) => day.github,
    getB: (day) => day.tokens,
    formatValue: numberLabel,
    leverageValue: (a, b) => (a > 0 ? compactNumberLabel(b / a) : '—'),
  },
  'input-output': {
    colorA: '#5e5ce6',
    colorB: '#ff9500',
    getA: (day) => day.inputTokens,
    getB: (day) => day.outputTokens,
    formatValue: compactNumberLabel,
    leverageValue: (a, b) => ratioLabel(a, b),
    sharedScale: true,
  },
  'cache-read-create': {
    colorA: '#30d158',
    colorB: '#ff453a',
    getA: (day) => day.cacheReadTokens,
    getB: (day) => day.cacheCreateTokens,
    formatValue: compactNumberLabel,
    leverageValue: (a, b) => ratioLabel(a, b),
    sharedScale: true,
  },
  'codex-reason-output': {
    colorA: '#bf5af2',
    colorB: '#ff9500',
    getA: (day) => day.codexReasoningTokens,
    getB: (day) => day.codexResponseTokens,
    formatValue: compactNumberLabel,
    leverageValue: (a, b) => ratioLabel(a, b),
    sharedScale: true,
  },
  'tokens-views': {
    colorA: '#64d2ff',
    colorB: '#0a84ff',
    getA: (day) => day.tokens,
    getB: (day) => day.views,
    formatValue: compactNumberLabel,
    leverageValue: (a, b) => (b > 0 ? compactNumberLabel(a / b) : '—'),
  },
  'clones-uniques': {
    colorA: '#ff9500',
    colorB: '#bf5af2',
    getA: (day) => day.clones,
    getB: (day) => day.clonesUniques,
    formatValue: numberLabel,
    leverageValue: (a, b) => ratioLabel(a, b),
    sharedScale: true,
  },
  'cld-cdx-cache': {
    colorA: '#64d2ff',
    colorB: '#ff9500',
    // Cache volume per CLI — reveals who leans harder on the prompt cache.
    // Claude = cache_create + cache_read (both billed categories on Anthropic
    // side). Codex = cached_input (OpenAI only has the read-side concept,
    // cache creation is implicit).
    getA: (day) => day.claudeCacheTotalTokens,
    getB: (day) => day.codexCacheTotalTokens,
    formatValue: compactNumberLabel,
    leverageValue: (a, b) => ratioLabel(a, b),
    sharedScale: true,
  },
  'commits-cost': {
    colorA: '#30d158',
    colorB: '#ffd60a',
    getA: (day) => day.github,
    getB: (day) => day.cost,
    formatValue: (value) =>
      value > 999 ? compactNumberLabel(value) : numberLabel(Math.round(value)),
    leverageValue: (a, b) => (a > 0 ? usdLabel(b / a) : '—'),
  },
  'commits-output': {
    colorA: '#30d158',
    colorB: '#ff9500',
    getA: (day) => day.github,
    getB: (day) => day.outputTokens,
    formatValue: compactNumberLabel,
    leverageValue: (a, b) => (a > 0 ? compactNumberLabel(b / a) : '—'),
  },
  'commits-notes': {
    colorA: '#30d158',
    colorB: '#bf5af2',
    // Execution (versioned code) vs reflection (vault notes). Reveals which
    // days you shipped vs which days you planned / designed. Notes come from
    // the Obsidian vault activity feed, already populated in CombinedDay.
    getA: (day) => day.github,
    getB: (day) => day.notes,
    formatValue: numberLabel,
    leverageValue: (a, b) => (a > 0 ? ratioLabel(b, a) : '—'),
  },
  'cld-cdx-sub-leverage': {
    colorA: '#64d2ff',
    colorB: '#ff9500',
    // Per-vendor subscription ROI: daily PAYG cost that the sub "covers".
    // We plot PAYG raw per-day per vendor (directly visible on chart), and
    // expose the sub-leverage ratio (ΣPAYG / Σsub) via leverageValue so the
    // user sees which CLI's sub is more profitable. Normalizing the two
    // vendors against the sharedMax lets you compare magnitudes day-over-day.
    getA: (day) => day.claudeCost,
    getB: (day) => day.codexCost,
    formatValue: usdLabel,
    // Ratio of totals is computed elsewhere via sums of aRaw/bRaw — but the
    // real insight here is (PAYG Claude / sub Claude) vs (PAYG Codex / sub
    // Codex). We fold that into the label: leverageValue receives the two
    // PAYG totals, then we re-derive sub totals from the same row set via
    // the ctx hook below.
    leverageValue: (a, b, ctx) => {
      const subClaude = ctx?.subClaudeUsd ?? 0;
      const subCodex = ctx?.subCodexUsd ?? 0;
      const levA = subClaude > 0 ? a / subClaude : 0;
      const levB = subCodex > 0 ? b / subCodex : 0;
      if (levA <= 0 && levB <= 0) return '—';
      return `${levA.toFixed(1)}× · ${levB.toFixed(1)}×`;
    },
    sharedScale: true,
  },
  'cost-tokens': {
    colorA: '#ffd60a',
    colorB: '#64d2ff',
    getA: (day) => day.cost,
    getB: (day) => day.tokens,
    formatValue: (value) => (value > 999 ? compactNumberLabel(value) : usdLabel(value)),
    leverageValue: (a, b) => (b > 0 ? usdLabel((a / b) * 1_000_000) : '—'),
  },
  'cost-output': {
    colorA: '#ffd60a',
    colorB: '#ff9500',
    getA: (day) => day.cost,
    getB: (day) => day.outputTokens,
    formatValue: (value) => (value > 999 ? compactNumberLabel(value) : usdLabel(value)),
    leverageValue: (a, b) => (b > 0 ? usdLabel((a / b) * 1_000_000) : '—'),
  },
};

function computeSubscriptionDailyUsd(settings: SettingsResponse | null): number {
  if (!settings) {
    return 0;
  }
  const usdToEur = Math.max(0.01, Number(settings.subscriptions.usdToEur || 0.93));
  const monthlyEur =
    Number(settings.subscriptions.claude?.monthlyEur || 0) +
    Number(settings.subscriptions.codex?.monthlyEur || 0);
  const monthlyUsd = monthlyEur / usdToEur;
  return monthlyUsd / 30;
}

function computeSubscriptionDailyPerVendor(settings: SettingsResponse | null): {
  claude: number;
  codex: number;
} {
  if (!settings) return { claude: 0, codex: 0 };
  const usdToEur = Math.max(0.01, Number(settings.subscriptions.usdToEur || 0.93));
  const claudeMonthlyEur = Number(settings.subscriptions.claude?.monthlyEur || 0);
  const codexMonthlyEur = Number(settings.subscriptions.codex?.monthlyEur || 0);
  return {
    claude: claudeMonthlyEur / usdToEur / 30,
    codex: codexMonthlyEur / usdToEur / 30,
  };
}

type VsCategoryKey = 'llm' | 'cache' | 'cost' | 'trafic' | 'effort';

type VsCategory = {
  key: VsCategoryKey;
  modes: VsModeKey[];
};

const VS_CATEGORIES: VsCategory[] = [
  {
    key: 'llm',
    modes: ['cld-cdx-tokens', 'cld-cdx-cost', 'cld-cdx-sub-leverage', 'input-output'],
  },
  {
    key: 'cache',
    modes: ['active-cached', 'cache-read-create', 'cld-cdx-cache', 'codex-reason-output'],
  },
  {
    key: 'cost',
    modes: ['payg-abo', 'cost-tokens', 'cost-output'],
  },
  {
    key: 'trafic',
    modes: ['views-clones', 'views-uniques', 'clones-uniques', 'tokens-views'],
  },
  {
    key: 'effort',
    modes: ['commits-tokens', 'commits-output', 'commits-cost', 'commits-notes'],
  },
];

function getVsCategoryKey(mode: VsModeKey): VsCategoryKey {
  for (const cat of VS_CATEGORIES) {
    if ((cat.modes as readonly string[]).includes(mode)) {
      return cat.key;
    }
  }
  return 'llm';
}

function getVsCategory(key: VsCategoryKey): VsCategory {
  return VS_CATEGORIES.find((c) => c.key === key) || VS_CATEGORIES[0];
}

export default function OverviewRoute() {
  const { t, locale } = useTranslation();
  const [projects, setProjects] = useState<Project[]>([]);
  const [heatmap, setHeatmap] = useState<HeatmapResponse | null>(null);
  const [daily, setDaily] = useState<DailyCombinedRow[]>([]);
  const [obsidianActivity, setObsidianActivity] = useState<ObsidianActivityDay[]>([]);
  const [trafficSeries, setTrafficSeries] = useState<TrafficTimeseriesResponse | null>(null);
  const [settings, setSettings] = useState<SettingsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [heatmapMetric, setHeatmapMetric] = useState<HeatmapMetric>('contrib');
  const [vsMode, setVsMode] = useState<VsModeKey>('cld-cdx-tokens');

  useEffect(() => {
    let mounted = true;
    const usageFrom = yyyymmddFromDate(daysAgo(365));

    Promise.all([
      apiGet<Project[]>('/api/projects'),
      apiGet<HeatmapResponse>('/api/github/heatmap'),
      apiGet<DailyCombinedResponse>(`/api/usage/daily-combined?from=${usageFrom}`),
      apiGet<ObsidianActivityDay[]>('/api/obsidian/activity?days=365'),
      apiGet<TrafficTimeseriesResponse>('/api/github/traffic/timeseries?days=365'),
      apiGet<SettingsResponse>('/api/settings'),
    ])
      .then(
        ([projectsData, heatmapData, dailyData, obsidianData, trafficSeriesData, settingsData]) => {
          if (!mounted) {
            return;
          }
          setProjects(projectsData);
          setHeatmap(heatmapData);
          setDaily(dailyData.rows || []);
          setObsidianActivity(obsidianData || []);
          setTrafficSeries(trafficSeriesData);
          setSettings(settingsData);
        },
      )
      .catch((e) => {
        if (mounted) {
          setError(String(e));
        }
      });

    return () => {
      mounted = false;
    };
  }, []);

  const unifiedHeatmap = useMemo(() => {
    const year = heatmap?.year || new Date().getUTCFullYear();
    const annualDates = buildAnnualDates(year);

    const dataByDate = new Map<string, number>();

    if (heatmapMetric === 'contrib') {
      for (const d of heatmap?.days || []) {
        dataByDate.set(d.date, d.count);
      }
    } else if (heatmapMetric === 'views' || heatmapMetric === 'clones') {
      for (const row of trafficSeries?.rows || []) {
        const v =
          heatmapMetric === 'views' ? Number(row.viewsCount || 0) : Number(row.clonesCount || 0);
        dataByDate.set(row.date, (dataByDate.get(row.date) || 0) + v);
      }
    } else if (heatmapMetric === 'notes') {
      for (const d of obsidianActivity) {
        dataByDate.set(d.date, d.notes);
      }
    } else {
      // llm-total / llm-claude / llm-codex
      for (const row of daily) {
        const v =
          heatmapMetric === 'llm-claude'
            ? Number(row.claudeTokens || 0)
            : heatmapMetric === 'llm-codex'
              ? Number(row.codexTokens || 0)
              : Number(row.totalTokens || 0);
        dataByDate.set(String(row.date), v);
      }
    }

    const days = annualDates.map((date) => ({
      date,
      count: dataByDate.get(date) || 0,
      color: null,
    }));
    const total = days.reduce((acc, d) => acc + d.count, 0);
    const config = HEATMAP_METRIC_CONFIG[heatmapMetric];
    const localizedLabel = t(`overview.heatmap.${metricLabelKey(heatmapMetric)}`);
    return { days, total, palette: config.palette, label: localizedLabel, unit: config.unit };
  }, [heatmap, heatmapMetric, daily, obsidianActivity, trafficSeries, t]);

  const model = useMemo(() => {
    const today = startOfUtcDay(new Date());
    const todayIso = isoUtcDay(today);
    const weekStart = addUtcDays(today, -6);
    const prevWeekEnd = addUtcDays(weekStart, -1);
    const prevWeekStart = addUtcDays(prevWeekEnd, -6);
    const spark14Start = addUtcDays(today, -13);

    const githubDays = (heatmap?.days || [])
      .filter((day) => day.date <= todayIso)
      .sort((a, b) => a.date.localeCompare(b.date));

    const usageDays = [...daily]
      .map((row) => {
        const claudeInput = Number(row.claudeInputTokens || 0);
        const claudeOutput = Number(row.claudeOutputTokens || 0);
        const claudeCacheCreate = Number(row.claudeCacheCreateTokens || 0);
        const claudeCacheRead = Number(row.claudeCacheReadTokens || 0);
        // codexInput in the ccusage schema is the TOTAL input (cached +
        // fresh). Subtract cached to get fresh-only input, so provider
        // comparisons aren't skewed by cache.
        const codexInputTotal = Number(row.codexInputTokens || 0);
        const codexCached = Number(row.codexCachedInputTokens || 0);
        const codexFreshInput = Math.max(0, codexInputTotal - codexCached);
        const codexOutput = Number(row.codexOutputTokens || 0);
        const codexReasoning = Number(row.codexReasoningOutputTokens || 0);
        const claudeFresh = claudeInput + claudeOutput;
        const codexFresh = codexFreshInput + codexOutput + codexReasoning;
        return {
          date: String(row.date),
          tokens: Number(row.totalTokens || 0),
          cost: Number(row.totalCostUsd || 0),
          claudeTokens: Number(row.claudeTokens || 0),
          codexTokens: Number(row.codexTokens || 0),
          claudeCost: Number(row.claudeCostUsd || 0),
          codexCost: Number(row.codexCostUsd || 0),
          claudeFreshTokens: claudeFresh,
          codexFreshTokens: codexFresh,
          claudeOutputTokens: claudeOutput,
          codexOutputTokens: codexOutput,
          claudeSubCost: Number(row.claudeSubCostUsd || 0),
          codexSubCost: Number(row.codexSubCostUsd || 0),
          claudeCacheTotalTokens: claudeCacheCreate + claudeCacheRead,
          codexCacheTotalTokens: codexCached,
          activeTokens: claudeFresh + codexFresh,
          cachedTokens: claudeCacheRead + claudeCacheCreate + codexCached,
          inputTokens: claudeInput + codexFreshInput,
          outputTokens: claudeOutput + codexOutput + codexReasoning,
          cacheReadTokens: claudeCacheRead + codexCached,
          cacheCreateTokens: claudeCacheCreate,
          codexReasoningTokens: codexReasoning,
          codexResponseTokens: codexOutput,
        };
      })
      .filter((row) => row.date <= todayIso)
      .sort((a, b) => a.date.localeCompare(b.date));

    const notesDays = [...obsidianActivity]
      .map((day) => ({
        date: String(day.date),
        notes: Number(day.notes || 0),
      }))
      .filter((day) => day.date <= todayIso)
      .sort((a, b) => a.date.localeCompare(b.date));

    const githubByDate = new Map(githubDays.map((day) => [day.date, day.count]));
    const usageTokensByDate = new Map(usageDays.map((day) => [day.date, day.tokens]));
    const usageCostByDate = new Map(usageDays.map((day) => [day.date, day.cost]));
    const claudeTokensByDate = new Map(usageDays.map((day) => [day.date, day.claudeTokens]));
    const codexByDate = new Map(usageDays.map((day) => [day.date, day.codexTokens]));
    const claudeCostByDate = new Map(usageDays.map((day) => [day.date, day.claudeCost]));
    const codexCostByDate = new Map(usageDays.map((day) => [day.date, day.codexCost]));
    const activeTokensByDate = new Map(usageDays.map((day) => [day.date, day.activeTokens]));
    const cachedTokensByDate = new Map(usageDays.map((day) => [day.date, day.cachedTokens]));
    const inputTokensByDate = new Map(usageDays.map((day) => [day.date, day.inputTokens]));
    const outputTokensByDate = new Map(usageDays.map((day) => [day.date, day.outputTokens]));
    const cacheReadByDate = new Map(usageDays.map((day) => [day.date, day.cacheReadTokens]));
    const cacheCreateByDate = new Map(usageDays.map((day) => [day.date, day.cacheCreateTokens]));
    const claudeFreshByDate = new Map(usageDays.map((day) => [day.date, day.claudeFreshTokens]));
    const codexFreshByDate = new Map(usageDays.map((day) => [day.date, day.codexFreshTokens]));
    const claudeOutputByDate = new Map(usageDays.map((day) => [day.date, day.claudeOutputTokens]));
    const codexOutputByDate = new Map(usageDays.map((day) => [day.date, day.codexOutputTokens]));
    const claudeSubCostByDate = new Map(usageDays.map((day) => [day.date, day.claudeSubCost]));
    const codexSubCostByDate = new Map(usageDays.map((day) => [day.date, day.codexSubCost]));
    const claudeCacheTotalByDate = new Map(
      usageDays.map((day) => [day.date, day.claudeCacheTotalTokens]),
    );
    const codexCacheTotalByDate = new Map(
      usageDays.map((day) => [day.date, day.codexCacheTotalTokens]),
    );
    const codexReasoningByDate = new Map(
      usageDays.map((day) => [day.date, day.codexReasoningTokens]),
    );
    const codexResponseByDate = new Map(
      usageDays.map((day) => [day.date, day.codexResponseTokens]),
    );
    const notesByDate = new Map(notesDays.map((day) => [day.date, day.notes]));

    const viewsByDate = new Map<string, number>();
    const viewsUniquesByDate = new Map<string, number>();
    const clonesByDate = new Map<string, number>();
    const clonesUniquesByDate = new Map<string, number>();
    for (const row of trafficSeries?.rows || []) {
      viewsByDate.set(row.date, (viewsByDate.get(row.date) || 0) + Number(row.viewsCount || 0));
      viewsUniquesByDate.set(
        row.date,
        (viewsUniquesByDate.get(row.date) || 0) + Number(row.viewsUniques || 0),
      );
      clonesByDate.set(row.date, (clonesByDate.get(row.date) || 0) + Number(row.clonesCount || 0));
      clonesUniquesByDate.set(
        row.date,
        (clonesUniquesByDate.get(row.date) || 0) + Number(row.clonesUniques || 0),
      );
    }

    // Cartes top-level : signaux les plus actionnables sur 7 j vs 7 j précédents.
    // Choix : activité (commits), production IA (output), dépense (PAYG), ROI
    // (leverage abo), efficacité technique (cache hit), breadth (projets actifs).
    // On écarte Tokens total (gonfle avec cache), Part Codex (vanity), Notes
    // modifiées (vault = secondaire), Coût LLM non préfixé (ambigu).

    const outputSumByDate = new Map(usageDays.map((day) => [day.date, day.outputTokens]));
    const cacheReadSumByDate = new Map(usageDays.map((day) => [day.date, day.cacheReadTokens]));
    const contextSumByDate = new Map(
      usageDays.map((day) => [
        day.date,
        (day.inputTokens || 0) + (day.cacheReadTokens || 0) + (day.cacheCreateTokens || 0),
      ]),
    );

    // Abo quotidien (USD) — constant sur la fenêtre (billingHistory ignoré ici
    // pour garder le signal simple ; Usage page donne la version accrued fine).
    const dailyAboUsd = computeSubscriptionDailyUsd(settings);

    // Leverage quotidien = cost_day / daily_abo (spark varie naturellement avec cost)
    const leverageByDate = new Map<string, number>();
    for (const day of usageDays) {
      leverageByDate.set(day.date, dailyAboUsd > 0 ? day.cost / dailyAboUsd : 0);
    }

    // Cache hit % quotidien (spark)
    const cacheHitByDate = new Map<string, number>();
    for (const day of usageDays) {
      const ctx =
        (day.inputTokens || 0) + (day.cacheReadTokens || 0) + (day.cacheCreateTokens || 0);
      cacheHitByDate.set(day.date, ctx > 0 ? (day.cacheReadTokens / ctx) * 100 : 0);
    }

    const tr = t;
    const githubLast7 = sumDateRange(githubByDate, weekStart, today);
    const githubPrev7 = sumDateRange(githubByDate, prevWeekStart, prevWeekEnd);

    const outputLast7 = sumDateRange(outputSumByDate, weekStart, today);
    const outputPrev7 = sumDateRange(outputSumByDate, prevWeekStart, prevWeekEnd);

    const costLast7 = sumDateRange(usageCostByDate, weekStart, today);
    const costPrev7 = sumDateRange(usageCostByDate, prevWeekStart, prevWeekEnd);

    const aboWindow7 = dailyAboUsd * 7;
    const leverageLast7 = aboWindow7 > 0 ? costLast7 / aboWindow7 : 0;
    const leveragePrev7 = aboWindow7 > 0 ? costPrev7 / aboWindow7 : 0;

    // Cache hit agrégé pondéré sur la fenêtre (≠ moyenne des ratios quotidiens)
    const cacheReadLast7 = sumDateRange(cacheReadSumByDate, weekStart, today);
    const contextLast7 = sumDateRange(contextSumByDate, weekStart, today);
    const cacheReadPrev7 = sumDateRange(cacheReadSumByDate, prevWeekStart, prevWeekEnd);
    const contextPrev7 = sumDateRange(contextSumByDate, prevWeekStart, prevWeekEnd);
    const cacheHitLast7 = contextLast7 > 0 ? (cacheReadLast7 / contextLast7) * 100 : 0;
    const cacheHitPrev7 = contextPrev7 > 0 ? (cacheReadPrev7 / contextPrev7) * 100 : 0;

    const githubSpark = valuesDateRange(githubByDate, spark14Start, today);
    const outputSpark = valuesDateRange(outputSumByDate, spark14Start, today);
    const usageCostSpark = valuesDateRange(usageCostByDate, spark14Start, today);
    const leverageSpark = valuesDateRange(leverageByDate, spark14Start, today);
    const cacheHitSpark = valuesDateRange(cacheHitByDate, spark14Start, today);

    const activeProjects7d = projects.filter((project) => {
      const days = daysSinceCommit(project.last_commit_at);
      return days !== null && days <= 7;
    }).length;
    const activeProjectsPrev7d = Math.max(activeProjects7d - 1, 0);

    const cards: TrendCardData[] = [
      {
        title: tr('overview.cards.githubCommits'),
        value: String(githubLast7),
        ...formatDelta(githubLast7, githubPrev7, tr),
        sparkline: githubSpark,
      },
      {
        title: tr('overview.cards.aiOutput'),
        value: compactNumberLabel(outputLast7),
        ...formatDelta(outputLast7, outputPrev7, tr),
        sparkline: outputSpark,
      },
      {
        title: tr('overview.cards.paygCost'),
        value: `$${costLast7.toFixed(2)}`,
        ...formatDelta(costLast7, costPrev7, tr),
        sparkline: usageCostSpark,
      },
      {
        title: tr('overview.cards.aboLeverage'),
        value: leverageLast7 > 0 ? `×${leverageLast7.toFixed(1)}` : '—',
        ...formatDelta(leverageLast7, leveragePrev7, tr),
        sparkline: leverageSpark,
      },
      {
        title: tr('overview.cards.cacheHit'),
        value: contextLast7 > 0 ? `${Math.round(cacheHitLast7)}%` : '—',
        ...formatDelta(cacheHitLast7, cacheHitPrev7, tr),
        sparkline: cacheHitSpark,
      },
      {
        title: tr('overview.cards.activeProjects'),
        value: String(activeProjects7d),
        ...formatDelta(activeProjects7d, activeProjectsPrev7d, tr),
        sparkline: Array.from({ length: 8 }, (_, i) =>
          i < 7 ? activeProjectsPrev7d : activeProjects7d,
        ),
      },
    ];

    const projectByName = [...projects]
      .sort((a, b) => {
        const ad = a.last_commit_at || 0;
        const bd = b.last_commit_at || 0;
        if (bd !== ad) {
          return bd - ad;
        }
        return b.health_score - a.health_score;
      })
      .slice(0, 6);

    const recentCombined: CombinedDay[] = [];
    for (let day = spark14Start; day <= today; day = addUtcDays(day, 1)) {
      const date = isoUtcDay(day);
      recentCombined.push({
        date,
        github: githubByDate.get(date) || 0,
        tokens: usageTokensByDate.get(date) || 0,
        cost: usageCostByDate.get(date) || 0,
        notes: notesByDate.get(date) || 0,
        views: viewsByDate.get(date) || 0,
        clones: clonesByDate.get(date) || 0,
        viewsUniques: viewsUniquesByDate.get(date) || 0,
        clonesUniques: clonesUniquesByDate.get(date) || 0,
        claudeTokens: claudeTokensByDate.get(date) || 0,
        codexTokens: codexByDate.get(date) || 0,
        claudeCost: claudeCostByDate.get(date) || 0,
        codexCost: codexCostByDate.get(date) || 0,
        claudeFreshTokens: claudeFreshByDate.get(date) || 0,
        codexFreshTokens: codexFreshByDate.get(date) || 0,
        claudeOutputTokens: claudeOutputByDate.get(date) || 0,
        codexOutputTokens: codexOutputByDate.get(date) || 0,
        claudeSubCost: claudeSubCostByDate.get(date) || 0,
        codexSubCost: codexSubCostByDate.get(date) || 0,
        claudeCacheTotalTokens: claudeCacheTotalByDate.get(date) || 0,
        codexCacheTotalTokens: codexCacheTotalByDate.get(date) || 0,
        activeTokens: activeTokensByDate.get(date) || 0,
        cachedTokens: cachedTokensByDate.get(date) || 0,
        inputTokens: inputTokensByDate.get(date) || 0,
        outputTokens: outputTokensByDate.get(date) || 0,
        cacheReadTokens: cacheReadByDate.get(date) || 0,
        cacheCreateTokens: cacheCreateByDate.get(date) || 0,
        codexReasoningTokens: codexReasoningByDate.get(date) || 0,
        codexResponseTokens: codexResponseByDate.get(date) || 0,
      });
    }

    const subUsd = computeSubscriptionDailyUsd(settings);
    const subPerVendor = computeSubscriptionDailyPerVendor(settings);

    const recentMax = {
      github: Math.max(1, ...recentCombined.map((day) => day.github)),
      tokens: Math.max(1, ...recentCombined.map((day) => day.tokens)),
      cost: Math.max(1, ...recentCombined.map((day) => day.cost)),
      notes: Math.max(1, ...recentCombined.map((day) => day.notes)),
      views: Math.max(1, ...recentCombined.map((day) => day.views)),
      clones: Math.max(1, ...recentCombined.map((day) => day.clones)),
    };

    return {
      cards,
      projectByName,
      recentCombined,
      recentMax,
      githubDays,
      subDailyUsd: subUsd,
      subClaudeUsd: subPerVendor.claude,
      subCodexUsd: subPerVendor.codex,
    };
  }, [projects, heatmap, daily, obsidianActivity, trafficSeries, settings, t]);

  const vsCategory = getVsCategoryKey(vsMode);

  const vsData = useMemo(() => {
    const base = VS_MODES[vsMode];
    // Overlay text fields with locale translations — structural fields (functions, colors, scale) stay from base.
    const config: VsModeConfig = {
      ...base,
      segLabel: t(`overview.vsModes.${vsMode}.segLabel`),
      title: t(`overview.vsModes.${vsMode}.title`),
      legendA: t(`overview.vsModes.${vsMode}.legendA`),
      legendB: t(`overview.vsModes.${vsMode}.legendB`),
      leverageLabel: t(`overview.vsModes.${vsMode}.leverageLabel`),
      insight: t(`overview.vsModes.${vsMode}.insight`),
    };
    const ctx: VsModeCtx = {
      subDailyUsd: model.subDailyUsd,
      subClaudeUsd: model.subClaudeUsd,
      subCodexUsd: model.subCodexUsd,
    };
    const rows = model.recentCombined.map((day) => ({
      aRaw: config.getA(day),
      bRaw: config.getB(day, ctx),
      date: day.date,
    }));
    const maxA = Math.max(1, ...rows.map((r) => r.aRaw));
    const maxB = Math.max(1, ...rows.map((r) => r.bRaw));
    const totalA = rows.reduce((acc, r) => acc + r.aRaw, 0);
    const totalB = rows.reduce((acc, r) => acc + r.bRaw, 0);
    const sharedMax = Math.max(maxA, maxB);
    const denomA = config.sharedScale ? sharedMax : maxA;
    const denomB = config.sharedScale ? sharedMax : maxB;
    const chart = rows.map((r) => ({
      dateLabel: r.date.slice(5),
      aRaw: r.aRaw,
      bRaw: r.bRaw,
      aIndex: (r.aRaw / denomA) * 100,
      bIndex: (r.bRaw / denomB) * 100,
    }));
    return { config, chart, totalA, totalB, ctx };
  }, [vsMode, model.recentCombined, model.subDailyUsd, model.subClaudeUsd, model.subCodexUsd, t]);

  return (
    <div className="flex flex-col gap-6">
      <Section title={t('overview.title')} meta={t('overview.meta')}>
        <ErrorBanner>{error}</ErrorBanner>

        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
          {model.cards.map((card) => (
            <TrendCard key={card.title} data={card} />
          ))}
        </div>
      </Section>

      <Section
        actionWide
        title={t('overview.heatmap.title')}
        meta={t('overview.heatmap.meta', {
          label: unifiedHeatmap.label,
          total: numberLabel(unifiedHeatmap.total, locale),
          unit: unifiedHeatmap.unit,
        })}
        action={
          <Segmented<HeatmapMetric>
            value={heatmapMetric}
            options={[
              { value: 'contrib', label: t('overview.heatmap.contrib') },
              { value: 'views', label: t('overview.heatmap.views') },
              { value: 'clones', label: t('overview.heatmap.clones') },
              { value: 'llm-total', label: 'LLM' },
              { value: 'llm-claude', label: 'Claude' },
              { value: 'llm-codex', label: 'Codex' },
              { value: 'notes', label: t('overview.heatmap.notes') },
            ]}
            onChange={setHeatmapMetric}
          />
        }
      >
        <Card>
          <Heatmap
            days={unifiedHeatmap.days}
            palette={unifiedHeatmap.palette}
            totalLabel={unifiedHeatmap.unit}
            totalValue={unifiedHeatmap.total}
          />
        </Card>
      </Section>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[1.5fr_1fr]">
        <Section
          actionWide
          title={t('overview.comparator.title')}
          meta={t('overview.comparator.subtitle', {
            modeTitle: vsData.config.title ?? '',
          })}
          action={
            <Segmented<VsCategoryKey>
              value={vsCategory}
              options={VS_CATEGORIES.map((c) => ({
                value: c.key,
                label: t(`overview.comparator.categories.${c.key}`),
              }))}
              onChange={(key) => {
                const next = getVsCategory(key).modes[0];
                if (next) {
                  setVsMode(next);
                }
              }}
            />
          }
        >
          {model.recentCombined.length === 0 ? (
            <Card>
              <p className="text-sm text-[var(--text-dim)]">
                {t('overview.comparator.notEnoughData')}
              </p>
            </Card>
          ) : (
            <Card>
              <div className="mb-4 flex flex-wrap items-center gap-1.5">
                {getVsCategory(vsCategory).modes.map((key) => {
                  const cfg = VS_MODES[key];
                  const active = key === vsMode;
                  return (
                    <button
                      key={key}
                      type="button"
                      onClick={() => setVsMode(key)}
                      className={`group inline-flex items-center gap-2 rounded-full border px-3 py-1 text-[11px] font-medium transition-all ${active ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--text)]' : 'border-[var(--border)] bg-[var(--surface-1)] text-[var(--text-dim)] hover:border-[var(--border-strong)] hover:text-[var(--text)]'}`}
                      aria-pressed={active}
                    >
                      <span
                        aria-hidden="true"
                        className="h-1.5 w-1.5 rounded-full"
                        style={{ backgroundColor: cfg.colorA }}
                      />
                      {t(`overview.vsModes.${key}.segLabel`)}
                      <span
                        aria-hidden="true"
                        className="h-1.5 w-1.5 rounded-full"
                        style={{ backgroundColor: cfg.colorB }}
                      />
                    </button>
                  );
                })}
              </div>

              <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
                <VsKpi
                  label={vsData.config.legendA ?? ''}
                  value={vsData.config.formatValue(vsData.totalA)}
                  color={vsData.config.colorA}
                />
                <VsKpi
                  label={vsData.config.legendB ?? ''}
                  value={vsData.config.formatValue(vsData.totalB)}
                  color={vsData.config.colorB}
                />
                <VsKpi
                  label={vsData.config.leverageLabel ?? ''}
                  value={vsData.config.leverageValue(vsData.totalA, vsData.totalB, vsData.ctx)}
                  color="var(--text)"
                  accent
                />
              </div>

              <div className="h-56 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart
                    data={vsData.chart}
                    margin={{ top: 4, right: 4, left: -16, bottom: 0 }}
                  >
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                    <XAxis
                      dataKey="dateLabel"
                      tick={{ fill: 'rgba(245,245,247,0.48)', fontSize: 11 }}
                      axisLine={{ stroke: 'rgba(255,255,255,0.08)' }}
                      tickLine={false}
                      minTickGap={16}
                    />
                    <YAxis
                      domain={[0, 100]}
                      tick={{ fill: 'rgba(245,245,247,0.48)', fontSize: 11 }}
                      axisLine={{ stroke: 'rgba(255,255,255,0.08)' }}
                      tickLine={false}
                      tickFormatter={(value: number) => `${Math.round(value)}%`}
                    />
                    <Tooltip
                      contentStyle={{
                        backgroundColor: '#0b0d11',
                        border: '1px solid rgba(255,255,255,0.1)',
                        borderRadius: 10,
                        color: '#f5f5f7',
                        fontSize: 12,
                      }}
                      formatter={(_value, name, item) => {
                        const row = (
                          item as { payload?: { aRaw: number; bRaw: number } } | undefined
                        )?.payload;
                        const label = String(name ?? '');
                        if (!row) {
                          return ['0', label];
                        }
                        if (label === vsData.config.legendA) {
                          return [vsData.config.formatValue(row.aRaw), label];
                        }
                        if (label === vsData.config.legendB) {
                          return [vsData.config.formatValue(row.bRaw), label];
                        }
                        return ['0', label];
                      }}
                    />
                    <Legend iconType="circle" wrapperStyle={{ fontSize: 11 }} />
                    <Line
                      type="monotone"
                      dataKey="aIndex"
                      name={vsData.config.legendA}
                      stroke={vsData.config.colorA}
                      strokeWidth={2}
                      dot={false}
                    />
                    <Line
                      type="monotone"
                      dataKey="bIndex"
                      name={vsData.config.legendB}
                      stroke={vsData.config.colorB}
                      strokeWidth={2}
                      dot={false}
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>

              <p className="mt-3 text-[11px] text-[var(--text-faint)]">{vsData.config.insight}</p>
            </Card>
          )}
        </Section>

        <Section
          title={t('overview.activeProjectsSection.title')}
          meta={t('overview.activeProjectsSection.meta', { count: model.projectByName.length })}
        >
          {model.projectByName.length === 0 ? (
            <Card tight>
              <span className="text-sm text-[var(--text-dim)]">
                {t('overview.activeProjectsSection.noProject')}
              </span>
            </Card>
          ) : (
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {model.projectByName.map((project) => (
                <ActiveProjectTile key={project.id} project={project} />
              ))}
            </div>
          )}
        </Section>
      </div>

      {model.recentCombined.length > 0 ? (
        <Section
          title={t('overview.dailyBreakdown.title')}
          meta={t('overview.dailyBreakdown.meta')}
        >
          <Card>
            <DailyBreakdown days={model.recentCombined} max={model.recentMax} />
          </Card>
        </Section>
      ) : null}
    </div>
  );
}

function TrendCard({ data }: { data: TrendCardData }) {
  const width = 220;
  const height = 36;
  const path = sparklinePath(data.sparkline, width, height);
  const stroke = data.deltaPositive ? '#30d158' : '#ff453a';

  return (
    <Stat
      label={data.title}
      value={data.value}
      hint={
        <span className={data.deltaPositive ? 'text-[#30d158]' : 'text-[#ff453a]'}>
          {data.deltaLabel}
        </span>
      }
    >
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="mt-1 h-9 w-full"
        preserveAspectRatio="none"
      >
        <title>{`Sparkline ${data.title}`}</title>
        <path d={path} fill="none" stroke={stroke} strokeWidth={1.6} />
      </svg>
    </Stat>
  );
}

function VsKpi({
  label,
  value,
  color,
  accent,
}: {
  label: string;
  value: string;
  color: string;
  accent?: boolean;
}) {
  return (
    <div
      className={`flex flex-col gap-0.5 rounded-[var(--radius)] border px-3 py-2 ${accent ? 'border-[var(--border-strong)] bg-[var(--surface-2)]' : 'border-[var(--border)] bg-[var(--surface-1)]'}`}
    >
      <span className="text-[11px] uppercase tracking-[0.08em] text-[var(--text-dim)]">
        {label}
      </span>
      <span className="num text-[18px] font-semibold" style={{ color }}>
        {value}
      </span>
    </div>
  );
}

const METRIC_META = {
  github: { color: '#30d158', unit: 'commits' },
  tokens: { color: '#64d2ff', unit: 'tokens' },
  cost: { color: '#ffd60a', unit: '$' },
  notes: { color: '#bf5af2', unit: 'notes' },
  views: { color: '#0a84ff', unit: 'views' },
  clones: { color: '#ff9500', unit: 'clones' },
} as const;

type MetricKey = keyof typeof METRIC_META;

const WEEKDAY_HEADERS = ['L', 'M', 'M', 'J', 'V', 'S', 'D'] as const;

function mondayFirstWeekday(dateIso: string): number {
  const day = new Date(`${dateIso}T00:00:00Z`).getUTCDay();
  return (day + 6) % 7;
}

function DailyBreakdown({
  days,
  max,
}: {
  days: CombinedDay[];
  max: {
    github: number;
    tokens: number;
    cost: number;
    notes: number;
    views: number;
    clones: number;
  };
}) {
  const { t } = useTranslation();
  const [pinnedDate, setPinnedDate] = useState<string | null>(null);
  const [hoverDate, setHoverDate] = useState<string | null>(null);

  const focusedDate = pinnedDate || hoverDate;
  const focused = focusedDate ? days.find((d) => d.date === focusedDate) || null : null;

  function togglePin(date: string) {
    setPinnedDate((curr) => (curr === date ? null : date));
  }

  const dayNumber = (dateIso: string): string => {
    return String(new Date(`${dateIso}T00:00:00Z`).getUTCDate()).padStart(2, '0');
  };

  const firstDate = days[0]?.date;
  const lastDate = days[days.length - 1]?.date;
  const leadingBlanks = firstDate ? mondayFirstWeekday(firstDate) : 0;
  const trailingBlanks = lastDate ? 6 - mondayFirstWeekday(lastDate) : 0;
  const todayIso = isoUtcDay(startOfUtcDay(new Date()));

  return (
    <div className="flex flex-col gap-3">
      <FocusedDaySummary focused={focused} />

      <div className="grid grid-cols-7 gap-1.5 md:gap-2" onMouseLeave={() => setHoverDate(null)}>
        {WEEKDAY_HEADERS.map((letter, idx) => (
          <div
            key={`wd-${idx}-${letter}`}
            className="pb-0.5 text-center text-[9px] font-medium uppercase tracking-widest text-[var(--text-faint)]"
          >
            {letter}
          </div>
        ))}

        {Array.from({ length: leadingBlanks }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: placeholder cells with no content — index is the only stable key
          <div key={`lead-${i}`} aria-hidden="true" />
        ))}

        {days.map((day) => {
          const shares = {
            github: day.github / Math.max(1, max.github),
            tokens: day.tokens / Math.max(1, max.tokens),
            cost: day.cost / Math.max(1, max.cost),
            notes: day.notes / Math.max(1, max.notes),
            views: day.views / Math.max(1, max.views),
            clones: day.clones / Math.max(1, max.clones),
          };
          const composite =
            (shares.github +
              shares.tokens +
              shares.cost +
              shares.notes +
              shares.views +
              shares.clones) /
            6;

          const pinned = pinnedDate === day.date;
          const hover = hoverDate === day.date;
          const active = pinned || hover;
          const isToday = day.date === todayIso;

          return (
            <button
              type="button"
              key={day.date}
              onClick={() => togglePin(day.date)}
              onMouseEnter={() => setHoverDate(day.date)}
              onFocus={() => setHoverDate(day.date)}
              className={`group relative flex aspect-square flex-col items-stretch gap-1.5 overflow-hidden rounded-[var(--radius)] border px-1.5 py-1.5 transition-all ${active ? 'border-[var(--accent)] bg-[var(--accent-soft)]' : isToday ? 'border-[var(--border-strong)] bg-[var(--surface-2)] hover:border-[var(--accent)]' : 'border-[var(--border)] bg-[var(--surface-1)] hover:border-[var(--border-strong)] hover:bg-[var(--surface-2)]'}`}
              aria-label={t('overview.dailyBreakdown.dayAria', {
                date: day.date,
                pct: Math.round(composite * 100),
              })}
              aria-pressed={pinned}
            >
              <span
                aria-hidden="true"
                className="pointer-events-none absolute inset-0 opacity-50"
                style={{
                  background: `linear-gradient(180deg, rgba(255,255,255,0) 0%, rgba(255,255,255,0) ${Math.max(0, 100 - Math.round(composite * 100))}%, rgba(255,255,255,0.04) 100%)`,
                }}
              />
              <div className="relative flex items-baseline justify-between">
                <span
                  className={`num text-[13px] font-semibold leading-none ${active ? 'text-[var(--accent)]' : 'text-[var(--text)]'}`}
                >
                  {dayNumber(day.date)}
                </span>
                <span
                  className={`num text-[9px] font-medium tabular-nums ${active ? 'text-[var(--accent)]' : 'text-[var(--text-faint)]'}`}
                >
                  {Math.round(composite * 100)}
                </span>
              </div>
              <DayRings shares={shares} />
            </button>
          );
        })}

        {Array.from({ length: trailingBlanks }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: placeholder cells with no content — index is the only stable key
          <div key={`trail-${i}`} aria-hidden="true" />
        ))}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-[var(--text-dim)]">
        <div className="flex flex-wrap items-center gap-3">
          {(Object.keys(METRIC_META) as MetricKey[]).map((key) => (
            <span key={key} className="inline-flex items-center gap-1.5">
              <span
                className="inline-block h-1.5 w-4 rounded-full"
                style={{ backgroundColor: METRIC_META[key].color }}
              />
              {t(`overview.metricMeta.${key}`)}
            </span>
          ))}
        </div>
        <span>
          {pinnedDate ? (
            <button
              type="button"
              className="text-[var(--accent)] hover:underline"
              onClick={() => setPinnedDate(null)}
            >
              {t('overview.dailyBreakdown.unpin')}
            </button>
          ) : (
            t('overview.dailyBreakdown.clickToPin')
          )}
        </span>
      </div>
    </div>
  );
}

function DayRings({
  shares,
}: {
  shares: {
    github: number;
    tokens: number;
    cost: number;
    notes: number;
    views: number;
    clones: number;
  };
}) {
  const tracks: Array<{ value: number; color: string }> = [
    { value: shares.github, color: METRIC_META.github.color },
    { value: shares.tokens, color: METRIC_META.tokens.color },
    { value: shares.cost, color: METRIC_META.cost.color },
    { value: shares.notes, color: METRIC_META.notes.color },
    { value: shares.views, color: METRIC_META.views.color },
    { value: shares.clones, color: METRIC_META.clones.color },
  ];

  return (
    <div className="flex w-full flex-1 flex-col items-stretch gap-[3px]">
      {tracks.map((track) => (
        <span
          key={track.color}
          className="relative w-full flex-1 overflow-hidden rounded-full bg-[rgba(255,255,255,0.05)]"
        >
          <span
            className="absolute inset-y-0 left-0 rounded-full"
            style={{
              width: `${Math.max(4, Math.min(100, Math.round(track.value * 100)))}%`,
              backgroundColor: track.color,
              boxShadow: track.value > 0.02 ? `0 0 6px ${track.color}55` : undefined,
            }}
          />
        </span>
      ))}
    </div>
  );
}

function FocusedDaySummary({ focused }: { focused: CombinedDay | null }) {
  const { t, locale } = useTranslation();
  if (!focused) {
    return (
      <div className="flex items-center justify-between rounded-[var(--radius)] border border-dashed border-[var(--border)] bg-[var(--surface-1)] px-3 py-2 text-[12px] text-[var(--text-dim)]">
        <span>{t('overview.dailyBreakdown.hoverHint')}</span>
        <span className="text-[11px] text-[var(--text-faint)]">
          {t('overview.dailyBreakdown.tracksLabel')}
        </span>
      </div>
    );
  }

  return (
    <div className="rounded-[var(--radius)] border border-[var(--border-strong)] bg-[var(--surface-2)] px-3 py-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <div className="text-[12px] uppercase tracking-[0.08em] text-[var(--text-dim)]">
            {t('overview.dailyBreakdown.pinnedDay')}
          </div>
          <div className="text-[15px] font-semibold text-[var(--text)]">
            {new Date(`${focused.date}T00:00:00Z`).toLocaleDateString(dateLocale(locale), {
              weekday: 'long',
              day: '2-digit',
              month: 'long',
            })}
          </div>
        </div>
        <div className="flex flex-wrap items-baseline gap-4 text-[12px]">
          <SummaryMetric
            label={t('overview.metricMeta.github')}
            value={numberLabel(focused.github, locale)}
            color={METRIC_META.github.color}
          />
          <SummaryMetric
            label={t('overview.metricMeta.tokens')}
            value={compactNumberLabel(focused.tokens)}
            color={METRIC_META.tokens.color}
          />
          <SummaryMetric
            label={t('overview.metricMeta.cost')}
            value={`$${focused.cost.toFixed(2)}`}
            color={METRIC_META.cost.color}
          />
          <SummaryMetric
            label={t('overview.metricMeta.notes')}
            value={numberLabel(focused.notes, locale)}
            color={METRIC_META.notes.color}
          />
          <SummaryMetric
            label={t('overview.metricMeta.views')}
            value={numberLabel(focused.views, locale)}
            color={METRIC_META.views.color}
          />
          <SummaryMetric
            label={t('overview.metricMeta.clones')}
            value={numberLabel(focused.clones, locale)}
            color={METRIC_META.clones.color}
          />
        </div>
      </div>
    </div>
  );
}

function SummaryMetric({
  label,
  value,
  color,
}: {
  label: string;
  value: string;
  color: string;
}) {
  return (
    <span className="inline-flex flex-col items-end">
      <span className="text-[10px] uppercase tracking-[0.08em] text-[var(--text-dim)]">
        {label}
      </span>
      <span className="num text-[14px] font-semibold" style={{ color }}>
        {value}
      </span>
    </span>
  );
}

function ActiveProjectTile({
  project,
}: {
  project: {
    id: string;
    name: string;
    type: string;
    health_score: number;
    last_commit_at: number | null;
    uncommitted: number;
  };
}) {
  const { t } = useTranslation();
  const since = daysSinceCommit(project.last_commit_at);
  const dotTone =
    since === null
      ? 'bg-[var(--text-faint)]'
      : since <= 2
        ? 'bg-[#30d158] shadow-[0_0_0_3px_rgba(48,209,88,0.18)]'
        : since <= 14
          ? 'bg-[#64d2ff] shadow-[0_0_0_3px_rgba(100,210,255,0.18)]'
          : since <= 60
            ? 'bg-[#ffd60a] shadow-[0_0_0_3px_rgba(255,214,10,0.18)]'
            : 'bg-[#ff453a] shadow-[0_0_0_3px_rgba(255,69,58,0.18)]';

  const sinceLabel =
    since === null
      ? t('overview.noCommit')
      : since === 0
        ? t('common.today')
        : t('common.daysAgo', { n: since });

  const healthTone =
    project.health_score >= 60
      ? 'text-[#30d158]'
      : project.health_score >= 30
        ? 'text-[#ffd60a]'
        : project.health_score > 0
          ? 'text-[#ff453a]'
          : 'text-[var(--text-dim)]';

  return (
    <Link
      to={`/projects/${project.id}`}
      className="group flex items-center gap-3 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-1)] px-3 py-2.5 transition-all hover:border-[var(--border-strong)] hover:bg-[var(--surface-2)]"
    >
      <span className={`h-2 w-2 shrink-0 rounded-full ${dotTone}`} />

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-[13.5px] font-medium text-[var(--text)] group-hover:text-white">
            {project.name}
          </span>
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-[var(--text-dim)]">
          <span className="whitespace-nowrap">{project.type}</span>
          <span aria-hidden="true">·</span>
          <span className="whitespace-nowrap">{sinceLabel}</span>
          {project.uncommitted > 0 ? (
            <>
              <span aria-hidden="true">·</span>
              <span className="whitespace-nowrap text-[#ffd60a]">
                {project.uncommitted} {t('common.dirty')}
              </span>
            </>
          ) : null}
        </div>
      </div>

      <div className="flex shrink-0 flex-col items-end">
        <span className={`num text-[18px] font-semibold leading-none ${healthTone}`}>
          {project.health_score}
        </span>
        <span className="mt-0.5 text-[9px] uppercase tracking-[0.1em] text-[var(--text-faint)]">
          {t('common.health')}
        </span>
      </div>
    </Link>
  );
}
