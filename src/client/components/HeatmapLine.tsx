import { useMemo } from 'react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { dateLocale, numberLocale, useTranslation } from '../lib/i18n';

/**
 * Line-chart counterpart to <Heatmap/>: same input shape, same palette, same
 * total/legend framing, just rendered as a daily area-chart over time.
 *
 * Intent is "drop-in replacement" so the parent can toggle between grid and
 * line without remapping data. Cumulative/rolling-average modes are left to
 * callers to compute upstream — we render exactly what `days` contains so
 * the two views are always equivalent numerically.
 */

type HeatmapDay = {
  date: string;
  count: number;
  color?: string | null;
};

type Palette = 'github' | 'cyan' | 'amber' | 'magenta';

type HeatmapLineProps = {
  days: HeatmapDay[];
  palette?: Palette;
  className?: string;
  totalLabel?: string;
  totalValue?: number;
  height?: number;
};

// Single brand colour per palette, matching scale[4] of the grid's Heatmap.
const PALETTE_STROKE: Record<Palette, string> = {
  github: '#30d158',
  cyan: '#64d2ff',
  amber: '#ffd60a',
  magenta: '#ff2d95',
};

function monthShortTick(dateIso: string, dtLocale: string): string {
  // Empty string on days that aren't a month's 1st keeps the axis sparse
  // (matches the heatmap's one-label-per-month header convention).
  if (!dateIso.endsWith('-01')) return '';
  return new Date(`${dateIso}T00:00:00Z`)
    .toLocaleString(dtLocale, { month: 'short' })
    .toUpperCase();
}

function formatDateLong(dateIso: string, dtLocale: string): string {
  return new Date(`${dateIso}T00:00:00Z`).toLocaleDateString(dtLocale, {
    weekday: 'long',
    day: '2-digit',
    month: 'long',
    year: 'numeric',
  });
}

function numberLabel(value: number, nLocale: string): string {
  return new Intl.NumberFormat(nLocale).format(Math.round(value));
}

export function HeatmapLine({
  days,
  palette = 'github',
  className,
  totalLabel,
  totalValue,
  height = 220,
}: HeatmapLineProps) {
  const { t, locale } = useTranslation();
  const dtLocale = dateLocale(locale);
  const nLocale = numberLocale(locale);
  const effectiveTotalLabel = totalLabel ?? t('common.heatmapContributions');

  const model = useMemo(() => {
    if (days.length === 0) {
      return { points: [] as Array<{ date: string; count: number }>, total: 0, max: 0 };
    }
    const sorted = [...days].sort((a, b) => a.date.localeCompare(b.date));
    const total = sorted.reduce((s, d) => s + d.count, 0);
    const max = sorted.reduce((m, d) => Math.max(m, d.count), 0);
    return {
      points: sorted.map((d) => ({ date: d.date, count: d.count })),
      total,
      max,
    };
  }, [days]);

  const stroke = PALETTE_STROKE[palette];
  const gradientId = `heatmap-line-grad-${palette}`;

  if (days.length === 0) {
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
            {numberLabel(totalValue ?? model.total, nLocale)}
          </span>
          <span>{effectiveTotalLabel}</span>
        </div>
        <div className="text-[11px] text-[var(--text-faint)]">
          {t('common.heatmapMax')} ·{' '}
          <span className="num text-[var(--text-dim)]">{numberLabel(model.max, nLocale)}</span>
        </div>
      </div>

      <div style={{ height }}>
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={model.points} margin={{ top: 8, right: 4, left: -12, bottom: 0 }}>
            <defs>
              <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={stroke} stopOpacity={0.35} />
                <stop offset="100%" stopColor={stroke} stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
            <XAxis
              dataKey="date"
              tick={{ fill: 'rgba(245,245,247,0.48)', fontSize: 10 }}
              axisLine={{ stroke: 'rgba(255,255,255,0.08)' }}
              tickLine={false}
              tickFormatter={(v: string) => monthShortTick(v, dtLocale)}
              interval={0}
              minTickGap={0}
            />
            <YAxis
              tick={{ fill: 'rgba(245,245,247,0.48)', fontSize: 10 }}
              axisLine={{ stroke: 'rgba(255,255,255,0.08)' }}
              tickLine={false}
              tickFormatter={(v: number) => numberLabel(v, nLocale)}
              width={44}
            />
            <Tooltip
              cursor={{ stroke: 'rgba(255,255,255,0.08)' }}
              contentStyle={{
                backgroundColor: '#0b0d11',
                border: '1px solid rgba(255,255,255,0.1)',
                borderRadius: 10,
                color: '#f5f5f7',
                fontSize: 12,
              }}
              formatter={(value: unknown) => [
                numberLabel(Number(value ?? 0), nLocale),
                effectiveTotalLabel,
              ]}
              labelFormatter={(label) =>
                typeof label === 'string' ? formatDateLong(label, dtLocale) : ''
              }
            />
            <Area
              type="monotone"
              dataKey="count"
              stroke={stroke}
              strokeWidth={1.6}
              fill={`url(#${gradientId})`}
              dot={false}
              isAnimationActive={false}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
