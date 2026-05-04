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
import { HeatmapStackedBars } from '../components/HeatmapStackedBars';
import { Card, ErrorBanner, Section, Segmented, Stat } from '../components/ui';
import { apiGet } from '../lib/api';
import { type GroupBy, type StackedDailyRow, bucketOf } from '../lib/cumulStacks';
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
  | 'npm'
  | 'pypi'
  | 'cargo'
  | 'llm-total'
  | 'llm-claude'
  | 'llm-codex'
  | 'notes';

// All package-registry endpoints share the same shape — npm, pypi,
// crates.io. Same row type, same response wrapper.
type PackageDailyByRepoRow = { date: string; repo: string; downloads: number };
type PackageDailyByRepoResponse = { rows: PackageDailyByRepoRow[] };

// Aliases kept so existing call sites read clearly. Functional twins.
type NpmDailyByRepoRow = PackageDailyByRepoRow;
type NpmDailyByRepoResponse = PackageDailyByRepoResponse;

// Granularities exposed on the cumul view. 'all' collapses everything into
// a single column (one bar = total cumulative on the displayed window).
type CumulBucket = 'day' | 'week' | 'biweekly' | 'month' | 'all';

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
  // NPM downloads aggregated across all packages on this date.
  npm: number;
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

// ─────────────────────────────────────────────────────────────────────────
// Modular VS comparator
//
// The comparator lets the user pick ANY two metrics from the dataset and
// plot them normalised over 14 days. Replaces the previous fixed-pair
// design (5 categories × ~4 hardcoded combinations) with a free-form
// picker. Single source of truth: METRICS — keyed by `MetricKey`, each
// entry carries the i18n label key, semantic category, default colour,
// unit (drives sharedScale + leverage formula), and the per-day getter.
// ─────────────────────────────────────────────────────────────────────────

type MetricUnit =
  | 'tokens' // any token count, whatever the provider
  | 'usd' // USD pay-as-you-go or sub-equivalent
  | 'commits' // GitHub contribution count
  | 'views' // GitHub traffic views
  | 'clones' // GitHub traffic clones
  | 'downloads' // npm package downloads
  | 'notes'; // vault notes touched

type MetricCategory = 'llm' | 'cache' | 'cost' | 'github' | 'npm' | 'vault';

// Keys are camelCase (no dots) because the i18n lookup splits on `.` to
// traverse nested objects — dotted keys would never resolve.
type MetricKey =
  // LLM volumes (cache excluded unless noted)
  | 'tokensTotal'
  | 'tokensActive'
  | 'tokensInput'
  | 'tokensOutput'
  | 'tokensClaudeTotal'
  | 'tokensClaudeFresh'
  | 'tokensClaudeOutput'
  | 'tokensCodexTotal'
  | 'tokensCodexFresh'
  | 'tokensCodexOutput'
  | 'tokensCodexReasoning'
  | 'tokensCodexResponse'
  // Cache
  | 'cacheTotal'
  | 'cacheRead'
  | 'cacheCreate'
  | 'cacheClaude'
  | 'cacheCodex'
  // Cost
  | 'costPaygTotal'
  | 'costPaygClaude'
  | 'costPaygCodex'
  | 'costSubDaily'
  | 'costSubClaude'
  | 'costSubCodex'
  // GitHub
  | 'ghCommits'
  | 'ghViews'
  | 'ghViewsUniques'
  | 'ghClones'
  | 'ghClonesUniques'
  // NPM
  | 'npmDownloads'
  // Vault
  | 'vaultNotes';

type Metric = {
  key: MetricKey;
  category: MetricCategory;
  unit: MetricUnit;
  // Default colour when the metric is rendered as series A. Series B reuses
  // a contrasting palette tone — picked at the call site to ensure A ≠ B
  // visually even when the user picks two metrics from the same family.
  color: string;
  getter: (day: CombinedDay, ctx: VsModeCtx) => number;
};

type VsModeCtx = {
  subDailyUsd: number;
  subClaudeUsd: number;
  subCodexUsd: number;
};

// Time windows the comparator can plot. Plain-number strings parse straight
// to `Number(value)` for the day count; 'all' means "everything we have"
// (capped server-side at 365 d in the daily-combined fetch).
type VsWindow = '1' | '7' | '14' | '30' | '60' | '90' | '150' | '365' | 'all';
const VS_WINDOWS: VsWindow[] = ['1', '7', '14', '30', '60', '90', '150', '365', 'all'];

// Single source of truth for all comparable metrics. Keep this list in
// sync with `MetricKey`. Order roughly mirrors the menu grouping: LLM →
// cache → cost → github → npm → vault.
const METRICS: Record<MetricKey, Metric> = {
  // LLM volumes
  tokensTotal: {
    key: 'tokensTotal',
    category: 'llm',
    unit: 'tokens',
    color: '#64d2ff',
    getter: (d) => d.tokens,
  },
  tokensActive: {
    key: 'tokensActive',
    category: 'llm',
    unit: 'tokens',
    color: '#30d158',
    getter: (d) => d.activeTokens,
  },
  tokensInput: {
    key: 'tokensInput',
    category: 'llm',
    unit: 'tokens',
    color: '#5e5ce6',
    getter: (d) => d.inputTokens,
  },
  tokensOutput: {
    key: 'tokensOutput',
    category: 'llm',
    unit: 'tokens',
    color: '#ff9500',
    getter: (d) => d.outputTokens,
  },
  tokensClaudeTotal: {
    key: 'tokensClaudeTotal',
    category: 'llm',
    unit: 'tokens',
    color: '#64d2ff',
    getter: (d) => d.claudeTokens,
  },
  tokensClaudeFresh: {
    key: 'tokensClaudeFresh',
    category: 'llm',
    unit: 'tokens',
    color: '#0a84ff',
    getter: (d) => d.claudeFreshTokens,
  },
  tokensClaudeOutput: {
    key: 'tokensClaudeOutput',
    category: 'llm',
    unit: 'tokens',
    color: '#5ac8fa',
    getter: (d) => d.claudeOutputTokens,
  },
  tokensCodexTotal: {
    key: 'tokensCodexTotal',
    category: 'llm',
    unit: 'tokens',
    color: '#ff9500',
    getter: (d) => d.codexTokens,
  },
  tokensCodexFresh: {
    key: 'tokensCodexFresh',
    category: 'llm',
    unit: 'tokens',
    color: '#ffd60a',
    getter: (d) => d.codexFreshTokens,
  },
  tokensCodexOutput: {
    key: 'tokensCodexOutput',
    category: 'llm',
    unit: 'tokens',
    color: '#ff9f0a',
    getter: (d) => d.codexOutputTokens,
  },
  tokensCodexReasoning: {
    key: 'tokensCodexReasoning',
    category: 'llm',
    unit: 'tokens',
    color: '#bf5af2',
    getter: (d) => d.codexReasoningTokens,
  },
  tokensCodexResponse: {
    key: 'tokensCodexResponse',
    category: 'llm',
    unit: 'tokens',
    color: '#ff9500',
    getter: (d) => d.codexResponseTokens,
  },
  // Cache
  cacheTotal: {
    key: 'cacheTotal',
    category: 'cache',
    unit: 'tokens',
    color: '#64d2ff',
    getter: (d) => d.cachedTokens,
  },
  cacheRead: {
    key: 'cacheRead',
    category: 'cache',
    unit: 'tokens',
    color: '#30d158',
    getter: (d) => d.cacheReadTokens,
  },
  cacheCreate: {
    key: 'cacheCreate',
    category: 'cache',
    unit: 'tokens',
    color: '#ff453a',
    getter: (d) => d.cacheCreateTokens,
  },
  cacheClaude: {
    key: 'cacheClaude',
    category: 'cache',
    unit: 'tokens',
    color: '#64d2ff',
    getter: (d) => d.claudeCacheTotalTokens,
  },
  cacheCodex: {
    key: 'cacheCodex',
    category: 'cache',
    unit: 'tokens',
    color: '#ff9500',
    getter: (d) => d.codexCacheTotalTokens,
  },
  // Cost
  costPaygTotal: {
    key: 'costPaygTotal',
    category: 'cost',
    unit: 'usd',
    color: '#ffd60a',
    getter: (d) => d.cost,
  },
  costPaygClaude: {
    key: 'costPaygClaude',
    category: 'cost',
    unit: 'usd',
    color: '#64d2ff',
    getter: (d) => d.claudeCost,
  },
  costPaygCodex: {
    key: 'costPaygCodex',
    category: 'cost',
    unit: 'usd',
    color: '#ff9500',
    getter: (d) => d.codexCost,
  },
  costSubDaily: {
    key: 'costSubDaily',
    category: 'cost',
    unit: 'usd',
    color: '#30d158',
    getter: (_d, ctx) => ctx.subDailyUsd,
  },
  costSubClaude: {
    key: 'costSubClaude',
    category: 'cost',
    unit: 'usd',
    color: '#0a84ff',
    getter: (d) => d.claudeSubCost,
  },
  costSubCodex: {
    key: 'costSubCodex',
    category: 'cost',
    unit: 'usd',
    color: '#ff9f0a',
    getter: (d) => d.codexSubCost,
  },
  // GitHub
  ghCommits: {
    key: 'ghCommits',
    category: 'github',
    unit: 'commits',
    color: '#30d158',
    getter: (d) => d.github,
  },
  ghViews: {
    key: 'ghViews',
    category: 'github',
    unit: 'views',
    color: '#0a84ff',
    getter: (d) => d.views,
  },
  ghViewsUniques: {
    key: 'ghViewsUniques',
    category: 'github',
    unit: 'views',
    color: '#bf5af2',
    getter: (d) => d.viewsUniques,
  },
  ghClones: {
    key: 'ghClones',
    category: 'github',
    unit: 'clones',
    color: '#ff9500',
    getter: (d) => d.clones,
  },
  ghClonesUniques: {
    key: 'ghClonesUniques',
    category: 'github',
    unit: 'clones',
    color: '#ffd60a',
    getter: (d) => d.clonesUniques,
  },
  // NPM
  npmDownloads: {
    key: 'npmDownloads',
    category: 'npm',
    unit: 'downloads',
    color: '#ff2d95',
    getter: (d) => d.npm,
  },
  // Vault
  vaultNotes: {
    key: 'vaultNotes',
    category: 'vault',
    unit: 'notes',
    color: '#bf5af2',
    getter: (d) => d.notes,
  },
};

const METRIC_CATEGORIES: MetricCategory[] = ['llm', 'cache', 'cost', 'github', 'npm', 'vault'];

// Format a metric VALUE according to its unit. Used by header KPIs and
// the chart tooltip. Compact for token volumes (often 5-7 digits), dollar
// for cost, plain integer for counts.
function formatMetricValue(value: number, unit: MetricUnit): string {
  if (unit === 'usd') return value > 999 ? compactNumberLabel(value) : usdLabel(value);
  if (unit === 'tokens') return compactNumberLabel(Math.round(value));
  return numberLabel(Math.round(value));
}

// Leverage / rate / ratio between two metrics' totals. Same unit → "×N.N"
// pure ratio; different units → rate with both units in the label so the
// reader can interpret the number.
function formatLeverage(
  totalA: number,
  totalB: number,
  unitA: MetricUnit,
  unitB: MetricUnit,
): string {
  if (totalB <= 0) return '—';
  const r = totalA / totalB;
  if (unitA === unitB) return `×${r.toFixed(2)}`;
  // Special-case the common money-per-tokens ratio: per-Mtoken reads better
  // than per-token (raw value < 0.001 otherwise).
  if (unitA === 'usd' && unitB === 'tokens') return `${usdLabel(r * 1_000_000)} / Mtok`;
  if (unitA === 'tokens' && unitB === 'usd') return `${compactNumberLabel(r)} tok / $`;
  // Generic: unit A per unit B with 2 sig figs (rounds 0.42 to "0.42").
  const formatted = Math.abs(r) >= 100 ? compactNumberLabel(r) : r.toFixed(2);
  return `${formatted}`;
}

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
  npm: { label: 'NPM', palette: 'amber', unit: 'downloads' },
  pypi: { label: 'PyPI', palette: 'cyan', unit: 'downloads' },
  cargo: { label: 'Cargo', palette: 'amber', unit: 'downloads' },
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

// Metrics that have a per-repo (project) breakdown: their cumul view
// stacks proportionally per project. Other metrics (contrib aggregates
// across the user's GH activity, llm-* / notes don't carry a repo field)
// degrade to a single-color cumul stack.
function hasPerRepoBreakdown(metric: HeatmapMetric): boolean {
  return (
    metric === 'views' ||
    metric === 'clones' ||
    metric === 'npm' ||
    metric === 'pypi' ||
    metric === 'cargo'
  );
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

export default function OverviewRoute() {
  const { t, locale } = useTranslation();
  const [projects, setProjects] = useState<Project[]>([]);
  const [heatmap, setHeatmap] = useState<HeatmapResponse | null>(null);
  const [daily, setDaily] = useState<DailyCombinedRow[]>([]);
  const [obsidianActivity, setObsidianActivity] = useState<ObsidianActivityDay[]>([]);
  const [trafficSeries, setTrafficSeries] = useState<TrafficTimeseriesResponse | null>(null);
  // Per-repo daily downloads, one state per registry. Each feeds both
  // the heatmap (when the user picks the matching metric) and the cumul
  // view's per-project proportional stacking. They live as separate
  // arrays — not one merged map — because the chart aggregations key on
  // the active metric and need O(1) access to the right slice.
  const [npmByRepo, setNpmByRepo] = useState<NpmDailyByRepoRow[]>([]);
  const [pypiByRepo, setPypiByRepo] = useState<PackageDailyByRepoRow[]>([]);
  const [cargoByRepo, setCargoByRepo] = useState<PackageDailyByRepoRow[]>([]);
  const [settings, setSettings] = useState<SettingsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [heatmapMetric, setHeatmapMetric] = useState<HeatmapMetric>('contrib');
  // View toggle: calendar grid (existing) vs cumulative stacked bars.
  // Defaults to grid so the page reads the same on first paint.
  const [heatmapView, setHeatmapView] = useState<'grid' | 'cumul'>('grid');
  // Granularity for the cumul view. 'month' default — 12 columns reads
  // cleanly. 'all' collapses everything into one bar (sliding-year total).
  const [heatmapBucket, setHeatmapBucket] = useState<CumulBucket>('month');
  // Modular comparator: pick any two metrics to chart against each other.
  // Defaults to the canonical "Claude vs Codex fresh tokens" so the page
  // lands on a meaningful signal — but the picker is now free-form.
  const [vsA, setVsA] = useState<MetricKey>('tokensClaudeFresh');
  const [vsB, setVsB] = useState<MetricKey>('tokensCodexFresh');
  // Comparator window in days, or 'all' for the full available range
  // (capped at 365 d by the upstream fetches). Defaults to 14 d to match
  // the previous fixed behaviour.
  const [vsWindow, setVsWindow] = useState<VsWindow>('14');

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
      apiGet<NpmDailyByRepoResponse>('/api/github/npm/daily-by-repo?days=365'),
      apiGet<PackageDailyByRepoResponse>('/api/github/pypi/daily-by-repo?days=365'),
      apiGet<PackageDailyByRepoResponse>('/api/github/crates/daily-by-repo?days=365'),
    ])
      .then(
        ([
          projectsData,
          heatmapData,
          dailyData,
          obsidianData,
          trafficSeriesData,
          settingsData,
          npmByRepoData,
          pypiByRepoData,
          cargoByRepoData,
        ]) => {
          if (!mounted) {
            return;
          }
          setProjects(projectsData);
          setHeatmap(heatmapData);
          setDaily(dailyData.rows || []);
          setObsidianActivity(obsidianData || []);
          setTrafficSeries(trafficSeriesData);
          setSettings(settingsData);
          setNpmByRepo(npmByRepoData.rows || []);
          setPypiByRepo(pypiByRepoData.rows || []);
          setCargoByRepo(cargoByRepoData.rows || []);
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
    } else if (heatmapMetric === 'npm' || heatmapMetric === 'pypi' || heatmapMetric === 'cargo') {
      const source =
        heatmapMetric === 'npm' ? npmByRepo : heatmapMetric === 'pypi' ? pypiByRepo : cargoByRepo;
      for (const row of source) {
        dataByDate.set(row.date, (dataByDate.get(row.date) || 0) + Number(row.downloads || 0));
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
  }, [
    heatmap,
    heatmapMetric,
    daily,
    obsidianActivity,
    trafficSeries,
    npmByRepo,
    pypiByRepo,
    cargoByRepo,
    t,
  ]);

  // Per-repo daily series for the cumul stacked-bars view. We build all
  // three (views/clones/npm) eagerly — switching metric is a free toggle.
  // For metrics without a per-repo breakdown (contrib / llm-* / notes),
  // we fall back to a single-key series so the cumul view still renders
  // (one neutral coloured stack instead of N project segments).
  const heatmapStackedDaily = useMemo(() => {
    const buildPerRepo = (
      rows: Array<{ date: string; repo: string; value: number }>,
    ): StackedDailyRow[] => {
      const map = new Map<string, Record<string, number>>();
      for (const r of rows) {
        if (!r.repo || r.value <= 0) continue;
        const bucket = map.get(r.date) ?? {};
        bucket[r.repo] = (bucket[r.repo] ?? 0) + r.value;
        map.set(r.date, bucket);
      }
      return [...map.entries()]
        .map(([date, values]) => ({ date, values }))
        .sort((a, b) => a.date.localeCompare(b.date));
    };

    const buildSingle = (
      rows: Array<{ date: string; value: number }>,
      key: string,
    ): StackedDailyRow[] => {
      const map = new Map<string, number>();
      for (const r of rows) {
        if (r.value <= 0) continue;
        map.set(r.date, (map.get(r.date) ?? 0) + r.value);
      }
      return [...map.entries()]
        .map(([date, total]) => ({ date, values: { [key]: total } }))
        .sort((a, b) => a.date.localeCompare(b.date));
    };

    const views = buildPerRepo(
      (trafficSeries?.rows || []).map((r) => ({
        date: r.date,
        repo: r.repo,
        value: Number(r.viewsCount || 0),
      })),
    );
    const clones = buildPerRepo(
      (trafficSeries?.rows || []).map((r) => ({
        date: r.date,
        repo: r.repo,
        value: Number(r.clonesCount || 0),
      })),
    );
    const npm = buildPerRepo(
      npmByRepo.map((r) => ({
        date: r.date,
        repo: r.repo,
        value: Number(r.downloads || 0),
      })),
    );
    const pypi = buildPerRepo(
      pypiByRepo.map((r) => ({
        date: r.date,
        repo: r.repo,
        value: Number(r.downloads || 0),
      })),
    );
    const cargo = buildPerRepo(
      cargoByRepo.map((r) => ({
        date: r.date,
        repo: r.repo,
        value: Number(r.downloads || 0),
      })),
    );

    const contrib = buildSingle(
      (heatmap?.days || []).map((d) => ({ date: d.date, value: d.count })),
      'contrib',
    );
    const notes = buildSingle(
      obsidianActivity.map((d) => ({ date: d.date, value: d.notes })),
      'notes',
    );
    const llmTotal = buildSingle(
      daily.map((r) => ({ date: String(r.date), value: Number(r.totalTokens || 0) })),
      'tokens',
    );
    const llmClaude = buildSingle(
      daily.map((r) => ({ date: String(r.date), value: Number(r.claudeTokens || 0) })),
      'tokens',
    );
    const llmCodex = buildSingle(
      daily.map((r) => ({ date: String(r.date), value: Number(r.codexTokens || 0) })),
      'tokens',
    );

    return { views, clones, npm, pypi, cargo, contrib, notes, llmTotal, llmClaude, llmCodex };
  }, [heatmap, daily, obsidianActivity, trafficSeries, npmByRepo, pypiByRepo, cargoByRepo]);

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

    // NPM downloads aggregated across packages per date — feeds the
    // Comparator's "NPM downloads" metric (one of the recently exposed
    // levers the user wants to plot against tokens / commits / cost).
    const npmByDate = new Map<string, number>();
    for (const row of npmByRepo) {
      npmByDate.set(row.date, (npmByDate.get(row.date) || 0) + Number(row.downloads || 0));
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
        npm: npmByDate.get(date) || 0,
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
  }, [projects, heatmap, daily, obsidianActivity, trafficSeries, npmByRepo, settings, t]);

  // Variable-window comparator series. Built independently from the
  // 14-day `model.recentCombined` so changing the window doesn't trigger
  // the (heavier) overview-model rebuild. Inlined parsing mirrors the
  // logic in `model.usageDays` — kept duplicated rather than refactored
  // to keep the change scoped to this section.
  const vsCombined = useMemo<CombinedDay[]>(() => {
    const today = startOfUtcDay(new Date());
    const todayIso = isoUtcDay(today);
    // For 'all' we use the earliest date present in any source. Capped
    // implicitly at 365 d by the upstream daily-combined fetch — anything
    // older just won't render because we have no row for it.
    let startIso: string;
    if (vsWindow === 'all') {
      const earliest = [
        ...(heatmap?.days || []).map((d) => d.date),
        ...daily.map((r) => String(r.date)),
        ...obsidianActivity.map((d) => d.date),
        ...(trafficSeries?.rows || []).map((r) => r.date),
        ...npmByRepo.map((r) => r.date),
      ]
        .filter((d) => typeof d === 'string' && d.length === 10)
        .sort();
      startIso = earliest[0] || todayIso;
    } else {
      const days = Number.parseInt(vsWindow, 10) || 14;
      startIso = isoUtcDay(addUtcDays(today, -(days - 1)));
    }

    // Reuse the same per-date parsing as `model` (codex fresh = total −
    // cached_input, etc.). One pass, no duplication of Map building since
    // it stays local to this memo.
    const usageByDate = new Map<
      string,
      {
        tokens: number;
        cost: number;
        claudeTokens: number;
        codexTokens: number;
        claudeCost: number;
        codexCost: number;
        claudeFreshTokens: number;
        codexFreshTokens: number;
        claudeOutputTokens: number;
        codexOutputTokens: number;
        claudeSubCost: number;
        codexSubCost: number;
        claudeCacheTotalTokens: number;
        codexCacheTotalTokens: number;
        activeTokens: number;
        cachedTokens: number;
        inputTokens: number;
        outputTokens: number;
        cacheReadTokens: number;
        cacheCreateTokens: number;
        codexReasoningTokens: number;
        codexResponseTokens: number;
      }
    >();
    for (const row of daily) {
      const date = String(row.date);
      if (date < startIso || date > todayIso) continue;
      const claudeInput = Number(row.claudeInputTokens || 0);
      const claudeOutput = Number(row.claudeOutputTokens || 0);
      const claudeCacheCreate = Number(row.claudeCacheCreateTokens || 0);
      const claudeCacheRead = Number(row.claudeCacheReadTokens || 0);
      const codexInputTotal = Number(row.codexInputTokens || 0);
      const codexCached = Number(row.codexCachedInputTokens || 0);
      const codexFreshInput = Math.max(0, codexInputTotal - codexCached);
      const codexOutput = Number(row.codexOutputTokens || 0);
      const codexReasoning = Number(row.codexReasoningOutputTokens || 0);
      const claudeFresh = claudeInput + claudeOutput;
      const codexFresh = codexFreshInput + codexOutput + codexReasoning;
      usageByDate.set(date, {
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
      });
    }

    const githubByDate = new Map<string, number>();
    for (const d of heatmap?.days || []) {
      githubByDate.set(d.date, Number(d.count || 0));
    }
    const notesByDate = new Map<string, number>();
    for (const d of obsidianActivity) {
      notesByDate.set(d.date, Number(d.notes || 0));
    }
    const viewsByDate = new Map<string, number>();
    const viewsUniquesByDate = new Map<string, number>();
    const clonesByDate = new Map<string, number>();
    const clonesUniquesByDate = new Map<string, number>();
    for (const r of trafficSeries?.rows || []) {
      viewsByDate.set(r.date, (viewsByDate.get(r.date) || 0) + Number(r.viewsCount || 0));
      viewsUniquesByDate.set(
        r.date,
        (viewsUniquesByDate.get(r.date) || 0) + Number(r.viewsUniques || 0),
      );
      clonesByDate.set(r.date, (clonesByDate.get(r.date) || 0) + Number(r.clonesCount || 0));
      clonesUniquesByDate.set(
        r.date,
        (clonesUniquesByDate.get(r.date) || 0) + Number(r.clonesUniques || 0),
      );
    }
    const npmByDate = new Map<string, number>();
    for (const r of npmByRepo) {
      npmByDate.set(r.date, (npmByDate.get(r.date) || 0) + Number(r.downloads || 0));
    }

    const out: CombinedDay[] = [];
    for (
      let cursor = new Date(`${startIso}T00:00:00Z`);
      cursor <= today;
      cursor = addUtcDays(cursor, 1)
    ) {
      const date = isoUtcDay(cursor);
      const u = usageByDate.get(date);
      out.push({
        date,
        github: githubByDate.get(date) || 0,
        tokens: u?.tokens || 0,
        cost: u?.cost || 0,
        notes: notesByDate.get(date) || 0,
        views: viewsByDate.get(date) || 0,
        clones: clonesByDate.get(date) || 0,
        viewsUniques: viewsUniquesByDate.get(date) || 0,
        clonesUniques: clonesUniquesByDate.get(date) || 0,
        npm: npmByDate.get(date) || 0,
        claudeTokens: u?.claudeTokens || 0,
        codexTokens: u?.codexTokens || 0,
        claudeCost: u?.claudeCost || 0,
        codexCost: u?.codexCost || 0,
        claudeSubCost: u?.claudeSubCost || 0,
        codexSubCost: u?.codexSubCost || 0,
        claudeCacheTotalTokens: u?.claudeCacheTotalTokens || 0,
        codexCacheTotalTokens: u?.codexCacheTotalTokens || 0,
        claudeFreshTokens: u?.claudeFreshTokens || 0,
        codexFreshTokens: u?.codexFreshTokens || 0,
        claudeOutputTokens: u?.claudeOutputTokens || 0,
        codexOutputTokens: u?.codexOutputTokens || 0,
        activeTokens: u?.activeTokens || 0,
        cachedTokens: u?.cachedTokens || 0,
        inputTokens: u?.inputTokens || 0,
        outputTokens: u?.outputTokens || 0,
        cacheReadTokens: u?.cacheReadTokens || 0,
        cacheCreateTokens: u?.cacheCreateTokens || 0,
        codexReasoningTokens: u?.codexReasoningTokens || 0,
        codexResponseTokens: u?.codexResponseTokens || 0,
      });
    }
    return out;
  }, [vsWindow, heatmap, daily, obsidianActivity, trafficSeries, npmByRepo]);

  const vsData = useMemo(() => {
    const a = METRICS[vsA];
    const b = METRICS[vsB];
    const ctx: VsModeCtx = {
      subDailyUsd: model.subDailyUsd,
      subClaudeUsd: model.subClaudeUsd,
      subCodexUsd: model.subCodexUsd,
    };
    const rows = vsCombined.map((day) => ({
      aRaw: a.getter(day, ctx),
      bRaw: b.getter(day, ctx),
      date: day.date,
    }));
    const maxA = Math.max(1, ...rows.map((r) => r.aRaw));
    const maxB = Math.max(1, ...rows.map((r) => r.bRaw));
    const totalA = rows.reduce((acc, r) => acc + r.aRaw, 0);
    const totalB = rows.reduce((acc, r) => acc + r.bRaw, 0);
    // Same unit → both series share the same Y reference (so absolute
    // magnitudes are visually comparable). Different units → each series
    // is normalised against its own max (you compare SHAPES, not levels).
    const sharedScale = a.unit === b.unit;
    const sharedMax = Math.max(maxA, maxB);
    const denomA = sharedScale ? sharedMax : maxA;
    const denomB = sharedScale ? sharedMax : maxB;
    const chart = rows.map((r) => ({
      dateLabel: r.date.slice(5),
      aRaw: r.aRaw,
      bRaw: r.bRaw,
      aIndex: (r.aRaw / denomA) * 100,
      bIndex: (r.bRaw / denomB) * 100,
    }));
    // If A and B happen to share the same default colour (e.g. two
    // claude-tinted metrics), force a contrasting accent on B so the two
    // lines don't visually merge.
    const colorA = a.color;
    const colorB = a.color === b.color ? '#ff9500' : b.color;
    const labelA = t(`overview.comparator.metrics.${a.key}`);
    const labelB = t(`overview.comparator.metrics.${b.key}`);
    return {
      a,
      b,
      colorA,
      colorB,
      labelA,
      labelB,
      sharedScale,
      chart,
      totalA,
      totalB,
      ctx,
    };
  }, [vsA, vsB, vsCombined, model.subDailyUsd, model.subClaudeUsd, model.subCodexUsd, t]);

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
              { value: 'npm', label: t('overview.heatmap.npm') },
              { value: 'pypi', label: t('overview.heatmap.pypi') },
              { value: 'cargo', label: t('overview.heatmap.cargo') },
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
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <Segmented<'grid' | 'cumul'>
              value={heatmapView}
              options={[
                { value: 'grid', label: t('overview.heatmap.viewGrid') },
                { value: 'cumul', label: t('overview.heatmap.viewCumul') },
              ]}
              onChange={setHeatmapView}
            />
            {heatmapView === 'cumul' ? (
              <Segmented<CumulBucket>
                value={heatmapBucket}
                options={[
                  { value: 'day', label: t('overview.heatmap.bucketDay') },
                  { value: 'week', label: t('overview.heatmap.bucket7d') },
                  { value: 'biweekly', label: t('overview.heatmap.bucket14d') },
                  { value: 'month', label: t('overview.heatmap.bucket30d') },
                  { value: 'all', label: t('overview.heatmap.bucketAll') },
                ]}
                onChange={setHeatmapBucket}
              />
            ) : null}
          </div>

          {heatmapView === 'grid' ? (
            <Heatmap
              days={unifiedHeatmap.days}
              palette={unifiedHeatmap.palette}
              totalLabel={unifiedHeatmap.unit}
              totalValue={unifiedHeatmap.total}
            />
          ) : (
            (() => {
              const groupBy: GroupBy = heatmapBucket === 'all' ? 'year' : heatmapBucket;
              const stacked: StackedDailyRow[] =
                heatmapMetric === 'views'
                  ? heatmapStackedDaily.views
                  : heatmapMetric === 'clones'
                    ? heatmapStackedDaily.clones
                    : heatmapMetric === 'npm'
                      ? heatmapStackedDaily.npm
                      : heatmapMetric === 'pypi'
                        ? heatmapStackedDaily.pypi
                        : heatmapMetric === 'cargo'
                          ? heatmapStackedDaily.cargo
                          : heatmapMetric === 'contrib'
                            ? heatmapStackedDaily.contrib
                            : heatmapMetric === 'notes'
                              ? heatmapStackedDaily.notes
                              : heatmapMetric === 'llm-claude'
                                ? heatmapStackedDaily.llmClaude
                                : heatmapMetric === 'llm-codex'
                                  ? heatmapStackedDaily.llmCodex
                                  : heatmapStackedDaily.llmTotal;
              // Cumul X-axis runs from Jan 1 of the displayed year to TODAY
              // (clamped). Past today is the future — no point rendering
              // forward-extrapolated buckets that just carry the cumul flat.
              const year = heatmap?.year || new Date().getUTCFullYear();
              const todayIso = new Date().toISOString().slice(0, 10);
              const yearEnd = `${year}-12-31`;
              const toDate = todayIso < yearEnd ? todayIso : yearEnd;
              const palette =
                HEATMAP_METRIC_CONFIG[heatmapMetric].palette === 'amber'
                  ? 'amber'
                  : HEATMAP_METRIC_CONFIG[heatmapMetric].palette === 'cyan'
                    ? 'cyan'
                    : 'github';
              // Pending bucket cue: GitHub Traffic API (views/clones) and
              // package registries (npm / pypi / cargo) all lag the
              // current day by 6-48 h. Mark today's bucket at reduced
              // opacity + tooltip hint so the user understands why the
              // column hasn't grown yet instead of guessing the dashboard
              // is stale.
              const isPendingMetric =
                heatmapMetric === 'views' ||
                heatmapMetric === 'clones' ||
                heatmapMetric === 'npm' ||
                heatmapMetric === 'pypi' ||
                heatmapMetric === 'cargo';
              const pendingBucket = isPendingMetric ? bucketOf(todayIso, groupBy) : null;
              return (
                <HeatmapStackedBars
                  daily={stacked}
                  fromDate={`${year}-01-01`}
                  toDate={toDate}
                  groupBy={groupBy}
                  cumulative
                  scheme={palette}
                  pendingBucket={pendingBucket}
                  totalLabel={unifiedHeatmap.unit}
                  height={260}
                />
              );
            })()
          )}
        </Card>
      </Section>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[1.5fr_1fr]">
        <Section
          title={t('overview.comparator.title')}
          meta={t('overview.comparator.subtitleModular', {
            window:
              vsWindow === 'all'
                ? t('overview.comparator.windowAll')
                : t('overview.comparator.windowDays', { n: vsWindow }),
            scaleHint: vsData.sharedScale
              ? t('overview.comparator.scaleShared')
              : t('overview.comparator.scaleIndependent'),
          })}
        >
          {vsCombined.length === 0 ? (
            <Card>
              <p className="text-sm text-[var(--text-dim)]">
                {t('overview.comparator.notEnoughData')}
              </p>
            </Card>
          ) : (
            <Card>
              {/* Modular picker: two grouped <select>s drive the chart.
                  Native <select> handles 30+ options across 6 categories
                  more cleanly than chip lists; <optgroup> mirrors
                  METRIC_CATEGORIES so the user can scan by family. */}
              <div className="mb-3 flex flex-wrap items-center gap-2 text-[12px]">
                <span className="text-[var(--text-dim)]">
                  {t('overview.comparator.compareLabel')}
                </span>
                <MetricSelect value={vsA} onChange={setVsA} accentColor={vsData.colorA} />
                <span className="text-[var(--text-dim)]">{t('common.vs')}</span>
                <MetricSelect value={vsB} onChange={setVsB} accentColor={vsData.colorB} />
                <button
                  type="button"
                  onClick={() => {
                    const a = vsA;
                    setVsA(vsB);
                    setVsB(a);
                  }}
                  className="rounded-full border border-[var(--border)] bg-[var(--surface-1)] px-2.5 py-1 text-[11px] text-[var(--text-dim)] hover:border-[var(--border-strong)] hover:text-[var(--text)]"
                  title={t('overview.comparator.swap')}
                  aria-label={t('overview.comparator.swap')}
                >
                  ⇄
                </button>
              </div>

              {/* Window selector. Compact pill row — mirrors the Period
                  band on the Usage page so the user already knows the
                  control. flex-wrap keeps it readable on narrow viewports. */}
              <div className="mb-4 flex flex-wrap items-center gap-1.5 text-[11px]">
                <span className="mr-1 text-[var(--text-dim)]">
                  {t('overview.comparator.windowLabel')}
                </span>
                {VS_WINDOWS.map((w) => {
                  const active = w === vsWindow;
                  const label =
                    w === 'all'
                      ? t('overview.comparator.windowAll')
                      : t('overview.comparator.windowDays', { n: w });
                  return (
                    <button
                      key={w}
                      type="button"
                      onClick={() => setVsWindow(w)}
                      aria-pressed={active}
                      className={`rounded-full border px-2.5 py-0.5 transition ${
                        active
                          ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--text)]'
                          : 'border-[var(--border)] text-[var(--text-dim)] hover:border-[var(--border-strong)] hover:text-[var(--text)]'
                      }`}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>

              <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
                <VsKpi
                  label={vsData.labelA}
                  value={formatMetricValue(vsData.totalA, vsData.a.unit)}
                  color={vsData.colorA}
                />
                <VsKpi
                  label={vsData.labelB}
                  value={formatMetricValue(vsData.totalB, vsData.b.unit)}
                  color={vsData.colorB}
                />
                <VsKpi
                  label={`${vsData.labelA} / ${vsData.labelB}`}
                  value={formatLeverage(vsData.totalA, vsData.totalB, vsData.a.unit, vsData.b.unit)}
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
                        if (!row) return ['0', label];
                        if (label === vsData.labelA) {
                          return [formatMetricValue(row.aRaw, vsData.a.unit), label];
                        }
                        if (label === vsData.labelB) {
                          return [formatMetricValue(row.bRaw, vsData.b.unit), label];
                        }
                        return ['0', label];
                      }}
                    />
                    <Legend iconType="circle" wrapperStyle={{ fontSize: 11 }} />
                    <Line
                      type="monotone"
                      dataKey="aIndex"
                      name={vsData.labelA}
                      stroke={vsData.colorA}
                      strokeWidth={2}
                      dot={false}
                    />
                    <Line
                      type="monotone"
                      dataKey="bIndex"
                      name={vsData.labelB}
                      stroke={vsData.colorB}
                      strokeWidth={2}
                      dot={false}
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>

              <p className="mt-3 text-[11px] text-[var(--text-faint)]">
                {vsData.sharedScale
                  ? t('overview.comparator.insightShared', {
                      unit: t(`overview.comparator.units.${vsData.a.unit}`),
                    })
                  : t('overview.comparator.insightIndependent', {
                      unitA: t(`overview.comparator.units.${vsData.a.unit}`),
                      unitB: t(`overview.comparator.units.${vsData.b.unit}`),
                    })}
              </p>
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

function MetricSelect({
  value,
  onChange,
  accentColor,
}: {
  value: MetricKey;
  onChange: (next: MetricKey) => void;
  accentColor: string;
}) {
  const { t } = useTranslation();
  // Group metrics by category so the user can scan by family. Native
  // <select> with <optgroup> is the right primitive for ~30 options —
  // searchable from the keyboard, accessible, and zero ad-hoc UI work.
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        aria-hidden="true"
        className="h-2 w-2 rounded-full"
        style={{ backgroundColor: accentColor }}
      />
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as MetricKey)}
        className="rounded-md border border-[var(--border)] bg-[var(--surface-1)] px-2 py-1 text-[12px] text-[var(--text)] hover:border-[var(--border-strong)] focus:border-[var(--accent)] focus:outline-none"
      >
        {METRIC_CATEGORIES.map((cat) => {
          const items = (Object.keys(METRICS) as MetricKey[]).filter(
            (k) => METRICS[k].category === cat,
          );
          if (items.length === 0) return null;
          return (
            <optgroup key={cat} label={t(`overview.comparator.categories.${cat}`)}>
              {items.map((k) => (
                <option key={k} value={k}>
                  {t(`overview.comparator.metrics.${k}`)}
                </option>
              ))}
            </optgroup>
          );
        })}
      </select>
    </span>
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

// Subset of metric keys used by the lightweight Daily breakdown component
// below — distinct from the comparator's exhaustive `MetricKey`. Renamed
// to avoid the type-name collision when both lived in the same file.
type MiniMetricKey = keyof typeof METRIC_META;

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
          {(Object.keys(METRIC_META) as MiniMetricKey[]).map((key) => (
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
