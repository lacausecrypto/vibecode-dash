import { useMemo } from 'react';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import {
  type GroupBy,
  type RepoColorScheme,
  type StackedDailyRow,
  aggregateStacked,
  enumerateBuckets,
  repoColor,
} from '../lib/cumulStacks';
import { dateLocale, numberLocale, useTranslation } from '../lib/i18n';

/**
 * Cumulative stacked-bars counterpart to <HeatmapLine/>.
 *
 * Renders monthly columns where each column is the running cumulative
 * total at the END of that month, segmented into one coloured slice per
 * repo. Hover on a bar shows the breakdown sorted by share desc.
 *
 * The bar metaphor + cumulative semantics are intentional:
 *   - Monthly buckets keep the X axis readable (12 columns vs 365).
 *   - Cumulative reads naturally as "total YTD" at any month boundary.
 *   - Per-repo segments make the proportion of contribution legible at
 *     a glance — the user immediately sees which project drove the year.
 *
 * Data shape mirrors HeatmapLine to make swapping easy in github.tsx:
 * the caller passes `daily: StackedDailyRow[]` with one entry per day
 * carrying a {repo → count} map. Rows where every repo is 0 are fine —
 * the component just enumerates the wider date window so empty months
 * still render as zero-height columns (preserves the year framing).
 *
 * For metrics without per-repo breakdown (contribs, npm aggregate),
 * pass `{ values: { all: count } }` and the chart degrades to a single
 * coloured stack — visually identical to a column histogram.
 */

type HeatmapStackedBarsProps = {
  /** One entry per day, repo→count. Empty days can be omitted. */
  daily: StackedDailyRow[];
  /** First day of the X axis. Defaults to the earliest day in `daily`. */
  fromDate?: string;
  /** Last day of the X axis. Defaults to the latest day in `daily`. */
  toDate?: string;
  groupBy?: GroupBy;
  cumulative?: boolean;
  scheme?: RepoColorScheme;
  /**
   * Explicit colour overrides per series key. When `colorMap[key]` is set
   * it wins over the scheme-based hash colour. Useful when callers want
   * brand-stable colours for known keys (e.g. claude=cyan, codex=amber on
   * the usage page) rather than hash-derived hues.
   */
  colorMap?: Record<string, string>;
  /**
   * Optional formatter applied to all displayed values: header total, Y
   * axis ticks, tooltip rows. Defaults to locale integer formatting.
   * Use this when the metric is a currency or has a unit — e.g. cost in
   * EUR should render as "12,3 k €" / "152 €", not "12300" / "152".
   */
  valueFormatter?: (value: number) => string;
  totalLabel?: string;
  /** When provided, renders in the header instead of the auto-summed total. */
  totalValue?: number;
  height?: number;
  className?: string;
};

function formatBucketLong(dateIso: string, groupBy: GroupBy, dtLocale: string): string {
  const d = new Date(`${dateIso}T00:00:00Z`);
  if (groupBy === 'month') {
    return d.toLocaleDateString(dtLocale, { month: 'long', year: 'numeric' });
  }
  if (groupBy === 'quarter') {
    const month = d.getUTCMonth() + 1;
    const q = Math.ceil(month / 3);
    return `Q${q} ${d.getUTCFullYear()}`;
  }
  if (groupBy === 'week' || groupBy === 'biweekly') {
    const end = new Date(d);
    end.setUTCDate(end.getUTCDate() + (groupBy === 'biweekly' ? 13 : 6));
    return `${d.toLocaleDateString(dtLocale, { day: '2-digit', month: 'short' })} → ${end.toLocaleDateString(dtLocale, { day: '2-digit', month: 'short' })}`;
  }
  // 'day'
  return d.toLocaleDateString(dtLocale, {
    weekday: 'long',
    day: '2-digit',
    month: 'long',
    year: 'numeric',
  });
}

function shortTickFormatter(dateIso: string, groupBy: GroupBy, dtLocale: string): string {
  if (groupBy === 'month') {
    return new Date(`${dateIso}T00:00:00Z`)
      .toLocaleString(dtLocale, { month: 'short' })
      .toUpperCase();
  }
  if (groupBy === 'quarter') {
    const m = Number.parseInt(dateIso.slice(5, 7), 10);
    return `Q${Math.ceil(m / 3)}`;
  }
  if (groupBy === 'biweekly' || groupBy === 'week') {
    // Show DD/MM — narrow enough for ~26 ticks (biweekly) / ~52 (week).
    return `${dateIso.slice(8, 10)}/${dateIso.slice(5, 7)}`;
  }
  // 'day': X axis renders one tick per day → too dense to label everything.
  // We leave the tick label empty unless the date is a 1st-of-month (mirrors
  // the heatmap grid header convention). Recharts will still draw the bar
  // — only the textual label is dropped.
  return dateIso.endsWith('-01') ? dateIso.slice(5, 7) : '';
}

function numberLabel(value: number, nLocale: string): string {
  return new Intl.NumberFormat(nLocale).format(Math.round(value));
}

/**
 * Compact number label for Y-axis ticks: 13953 → "13,9 k" (fr) / "14k" (en),
 * 1_200_000 → "1,2 M" / "1.2M". Keeps the axis gutter narrow on heavy
 * cumulative datasets where the absolute label would otherwise clip.
 *
 * Sub-1000 values render as plain numbers — "750" reads cleaner than
 * "0,75 k" at low magnitudes. The threshold matches how Intl Compact
 * already behaves but we make it explicit here to avoid the runtime
 * deciding to render "1k" for "1000" vs "1 k" with sub-locale variations.
 */
function compactNumberLabel(value: number, nLocale: string): string {
  const rounded = Math.round(value);
  if (Math.abs(rounded) < 1000) return new Intl.NumberFormat(nLocale).format(rounded);
  return new Intl.NumberFormat(nLocale, {
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(rounded);
}

export function HeatmapStackedBars({
  daily,
  fromDate,
  toDate,
  groupBy = 'month',
  cumulative = true,
  scheme = 'github',
  colorMap,
  valueFormatter,
  totalLabel,
  totalValue,
  height = 220,
  className,
}: HeatmapStackedBarsProps) {
  const { t, locale } = useTranslation();
  const dtLocale = dateLocale(locale);
  const nLocale = numberLocale(locale);
  const effectiveTotalLabel = totalLabel ?? t('common.heatmapContributions');
  // Default formatter: locale-aware integer for header + tooltip,
  // compact ("13,9 k") for Y-axis ticks. When the caller supplies
  // `valueFormatter` it OWNS the format everywhere — single source of
  // truth for unit-bearing metrics (e.g. EUR currency). The caller
  // typically picks compact + currency in one Intl.NumberFormat call
  // which reads fine on both axes.
  const formatValue = (value: number): string =>
    valueFormatter ? valueFormatter(value) : numberLabel(value, nLocale);
  const formatCompact = (value: number): string =>
    valueFormatter ? valueFormatter(value) : compactNumberLabel(value, nLocale);

  /**
   * Repos sorted by their final cumulative total (largest at the BOTTOM
   * of the stack, smallest at the TOP). Matches what users intuitively
   * expect from a "share over time" chart — the dominant repo anchors
   * each column, and the small contributors stack visibly above.
   */
  const model = useMemo(() => {
    if (daily.length === 0) {
      return {
        rows: [] as Array<Record<string, number | string>>,
        repos: [] as string[],
        repoTotals: new Map<string, number>(),
        totalAcrossAll: 0,
        maxBarHeight: 0,
      };
    }

    const earliest = fromDate ?? daily[0].date;
    const latest = toDate ?? daily[daily.length - 1].date;
    const buckets = enumerateBuckets(earliest, latest, groupBy);
    const aggregated = aggregateStacked(daily, {
      groupBy,
      cumulative,
      bucketsOverride: buckets,
    });

    // Repo set + final totals (used for stack ordering + legend hint).
    const repoTotals = new Map<string, number>();
    for (const row of aggregated) {
      for (const [repo, count] of Object.entries(row.values)) {
        // In cumulative mode, the LAST bucket carries the final total —
        // intermediate buckets are running snapshots, not deltas. We pick
        // them up by always overwriting (so the loop ends on the latest).
        repoTotals.set(repo, count);
      }
    }
    // Sort repos by descending final total so Recharts draws large at bottom.
    const repos = [...repoTotals.entries()].sort((a, b) => b[1] - a[1]).map(([r]) => r);

    // Flatten to Recharts' row shape: one object per bucket with each
    // repo as a top-level numeric field, plus the bucket key.
    const rows = aggregated.map((row) => {
      const flat: Record<string, number | string> = { bucket: row.bucket };
      for (const repo of repos) {
        flat[repo] = row.values[repo] ?? 0;
      }
      return flat;
    });

    const maxBarHeight = aggregated.reduce((m, r) => Math.max(m, r.total), 0);
    const totalAcrossAll = aggregated.length > 0 ? aggregated[aggregated.length - 1].total : 0;

    return { rows, repos, repoTotals, totalAcrossAll, maxBarHeight };
  }, [daily, fromDate, toDate, groupBy, cumulative]);

  if (daily.length === 0) {
    return (
      <div className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-1)] p-4 text-sm text-[var(--text-dim)]">
        {t('common.heatmapEmpty')}
      </div>
    );
  }

  return (
    <div className={className}>
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2 text-[12px] text-[var(--text-dim)]">
        <div className="flex items-baseline gap-2">
          <span className="num text-[14px] font-semibold text-[var(--text)]">
            {formatValue(totalValue ?? model.totalAcrossAll)}
          </span>
          <span>{effectiveTotalLabel}</span>
        </div>
        <div className="text-[11px] text-[var(--text-faint)]">
          {t('common.heatmapMax')} ·{' '}
          <span className="num text-[var(--text-dim)]">{formatValue(model.maxBarHeight)}</span>
        </div>
      </div>

      <div style={{ height }}>
        <ResponsiveContainer width="100%" height="100%">
          {/* `left: 0` (was -12) gives the Y axis labels their full reserved
              width back; the negative margin trick was clipping anything
              ≥ 5 chars (e.g. "13 953"). Compact tick formatting below keeps
              the gutter narrow even on large cumulative datasets. */}
          <BarChart data={model.rows} margin={{ top: 8, right: 4, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
            <XAxis
              dataKey="bucket"
              tick={{ fill: 'rgba(245,245,247,0.48)', fontSize: 10 }}
              axisLine={{ stroke: 'rgba(255,255,255,0.08)' }}
              tickLine={false}
              tickFormatter={(v: string) => shortTickFormatter(v, groupBy, dtLocale)}
              // Tick density per granularity:
              //   month (~12) / quarter (4)    → render every tick (interval 0).
              //   week (~52)  / biweekly (~26) → DD/MM labels are wider than
              //     a slot at typical container widths, so we let Recharts
              //     auto-thin via `preserveStartEnd` + a `minTickGap` floor.
              //     Without this every tick collided (cf. screenshot bug).
              //   day (~365)  → way too dense to label all; preserveEnd +
              //     a smaller gap keeps a thin sampling readable.
              interval={groupBy === 'month' || groupBy === 'quarter' ? 0 : 'preserveStartEnd'}
              minTickGap={
                groupBy === 'day' ? 8 : groupBy === 'week' ? 28 : groupBy === 'biweekly' ? 20 : 0
              }
            />
            <YAxis
              tick={{ fill: 'rgba(245,245,247,0.48)', fontSize: 10 }}
              axisLine={{ stroke: 'rgba(255,255,255,0.08)' }}
              tickLine={false}
              // Compact form ("13,9 k") so 4-5-digit cumulative totals fit
              // in the gutter. Tooltip + header still show the full number.
              tickFormatter={(v: number) => formatCompact(v)}
              width={48}
            />
            <Tooltip
              cursor={{ fill: 'rgba(255,255,255,0.04)' }}
              wrapperStyle={{ outline: 'none' }}
              content={({ active, payload, label }) => {
                if (!active || !payload || payload.length === 0) return null;
                // Recharts gives us one entry per Bar (one per repo). Filter
                // out zero-value segments and sort by share desc — readers
                // care about the dominant contributor first.
                const entries = payload
                  .map((p) => ({
                    repo: String(p.dataKey ?? '—'),
                    value: Number(p.value ?? 0),
                    color: String(p.color ?? p.fill ?? '#999'),
                  }))
                  .filter((e) => e.value > 0)
                  .sort((a, b) => b.value - a.value);
                const total = entries.reduce((s, e) => s + e.value, 0);
                const labelStr =
                  typeof label === 'string' ? formatBucketLong(label, groupBy, dtLocale) : '';
                return (
                  <div
                    style={{
                      backgroundColor: '#0b0d11',
                      border: '1px solid rgba(255,255,255,0.1)',
                      borderRadius: 10,
                      color: '#f5f5f7',
                      fontSize: 12,
                      padding: '8px 10px',
                      maxWidth: 280,
                    }}
                  >
                    <div style={{ marginBottom: 6, opacity: 0.7 }}>{labelStr}</div>
                    <div style={{ marginBottom: 6, fontWeight: 600 }}>
                      {formatValue(total)} {effectiveTotalLabel}
                    </div>
                    {entries.slice(0, 12).map((e) => {
                      const share = total > 0 ? Math.round((e.value / total) * 100) : 0;
                      return (
                        <div
                          key={e.repo}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 8,
                            justifyContent: 'space-between',
                            padding: '2px 0',
                          }}
                        >
                          <span
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: 6,
                              minWidth: 0,
                            }}
                          >
                            <span
                              aria-hidden
                              style={{
                                width: 10,
                                height: 10,
                                borderRadius: 2,
                                background: e.color,
                                flexShrink: 0,
                              }}
                            />
                            <span
                              style={{
                                whiteSpace: 'nowrap',
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                maxWidth: 170,
                              }}
                            >
                              {e.repo}
                            </span>
                          </span>
                          <span style={{ opacity: 0.85, whiteSpace: 'nowrap' }}>
                            <span className="num">{formatValue(e.value)}</span>{' '}
                            <span style={{ opacity: 0.5, fontSize: 10 }}>· {share}%</span>
                          </span>
                        </div>
                      );
                    })}
                    {entries.length > 12 ? (
                      <div style={{ marginTop: 4, opacity: 0.5, fontSize: 10 }}>
                        + {entries.length - 12} more
                      </div>
                    ) : null}
                  </div>
                );
              }}
            />
            {/* One Bar per repo, all sharing the same stackId. Reverse the
                array so the largest-total repo lands at the bottom of the
                stack (Recharts draws bars in array order, bottom-up). */}
            {[...model.repos].reverse().map((repo) => (
              <Bar
                key={repo}
                dataKey={repo}
                stackId="cumul"
                fill={colorMap?.[repo] ?? repoColor(repo, scheme)}
                isAnimationActive={false}
              />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
