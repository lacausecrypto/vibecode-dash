import { useMemo, useState } from 'react';
import { dateLocale, numberLocale, useTranslation } from '../lib/i18n';

type HeatmapDay = {
  date: string;
  count: number;
  color?: string | null;
};

type HeatmapProps = {
  days: HeatmapDay[];
  palette?: 'github' | 'cyan' | 'amber' | 'magenta';
  className?: string;
  totalLabel?: string;
  totalValue?: number;
  cellSize?: number;
  cellGap?: number;
  minWidth?: number | null;
  showWeekdays?: boolean;
  onSelect?: (day: HeatmapDay | null) => void;
};

type Cell = {
  date: string;
  count: number;
  color?: string | null;
  inRange: boolean;
};

const PALETTES = {
  github: ['rgba(255,255,255,0.04)', '#0e3321', '#155f39', '#27a34a', '#30d158'],
  cyan: ['rgba(255,255,255,0.04)', '#0b344b', '#16546f', '#0a8fbf', '#64d2ff'],
  amber: ['rgba(255,255,255,0.04)', '#3a1f04', '#6b3c0a', '#c98306', '#ffd60a'],
  magenta: ['rgba(255,255,255,0.04)', '#2e0b2a', '#4e1248', '#a02080', '#ff2d95'],
};

function dateOnly(value: string): Date {
  const [year, month, day] = value.split('-').map((part) => Number(part));
  return new Date(Date.UTC(year, month - 1, day, 0, 0, 0));
}

function isoDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function startOfWeekSunday(value: Date): Date {
  const copy = new Date(value);
  const day = copy.getUTCDay();
  copy.setUTCDate(copy.getUTCDate() - day);
  return copy;
}

function endOfWeekSaturday(value: Date): Date {
  const copy = new Date(value);
  const day = copy.getUTCDay();
  copy.setUTCDate(copy.getUTCDate() + (6 - day));
  return copy;
}

function monthShort(dateIso: string, dtLocale: string): string {
  return new Date(`${dateIso}T00:00:00Z`).toLocaleString(dtLocale, { month: 'short' });
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

export function Heatmap({
  days,
  palette = 'github',
  className,
  totalLabel,
  totalValue,
  cellSize = 12,
  cellGap = 3,
  minWidth = null,
  showWeekdays = true,
  onSelect,
}: HeatmapProps) {
  const { t, locale } = useTranslation();
  const dtLocale = dateLocale(locale);
  const nLocale = numberLocale(locale);
  const effectiveTotalLabel = totalLabel ?? t('common.heatmapContributions');
  const weekdayLabels = [
    t('common.weekdaySun'),
    t('common.weekdayMon'),
    t('common.weekdayTue'),
    t('common.weekdayWed'),
    t('common.weekdayThu'),
    t('common.weekdayFri'),
    t('common.weekdaySat'),
  ];
  const normalizedCellSize = Math.max(8, Math.min(22, Math.round(cellSize)));
  const normalizedCellGap = Math.max(1, Math.min(8, Math.round(cellGap)));
  const columnStride = normalizedCellSize + normalizedCellGap;

  const [hoveredDate, setHoveredDate] = useState<string | null>(null);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);

  const model = useMemo(() => {
    if (days.length === 0) {
      return {
        weeks: [] as Cell[][],
        monthLabels: [] as Array<{ label: string; index: number }>,
        maxCount: 0,
        total: 0,
        byDate: new Map<string, Cell>(),
      };
    }

    const sorted = [...days].sort((a, b) => a.date.localeCompare(b.date));
    const byDate = new Map(sorted.map((d) => [d.date, d]));
    const minDate = dateOnly(sorted[0].date);
    const maxDate = dateOnly(sorted[sorted.length - 1].date);
    const gridStart = startOfWeekSunday(minDate);
    const gridEnd = endOfWeekSaturday(maxDate);

    const allCells: Cell[] = [];
    const cellMap = new Map<string, Cell>();
    for (
      let cursor = new Date(gridStart);
      cursor <= gridEnd;
      cursor.setUTCDate(cursor.getUTCDate() + 1)
    ) {
      const key = isoDate(cursor);
      const value = byDate.get(key);
      const cell: Cell = {
        date: key,
        count: value?.count ?? 0,
        color: value?.color ?? null,
        inRange: key >= sorted[0].date && key <= sorted[sorted.length - 1].date,
      };
      allCells.push(cell);
      cellMap.set(key, cell);
    }

    const weeks: Cell[][] = [];
    for (let i = 0; i < allCells.length; i += 7) {
      weeks.push(allCells.slice(i, i + 7));
    }

    const monthLabels: Array<{ label: string; index: number }> = [];
    const seen = new Set<string>();
    for (let i = 0; i < weeks.length; i += 1) {
      const week = weeks[i];
      const firstActive = week.find((cell) => cell.inRange);
      if (!firstActive) {
        continue;
      }

      const monthKey = firstActive.date.slice(0, 7);
      if (seen.has(monthKey)) {
        continue;
      }

      seen.add(monthKey);
      monthLabels.push({
        label: monthShort(firstActive.date, dtLocale),
        index: i,
      });
    }

    return {
      weeks,
      monthLabels,
      maxCount: sorted.reduce((max, day) => Math.max(max, day.count), 0),
      total: sorted.reduce((sum, day) => sum + day.count, 0),
      byDate: cellMap,
    };
  }, [days, dtLocale]);

  const scale = PALETTES[palette];

  function colorFor(cell: Cell): string {
    if (!cell.inRange) {
      return 'transparent';
    }

    if (palette === 'github' && cell.color && cell.count > 0) {
      return cell.color;
    }

    if (cell.count <= 0 || model.maxCount <= 0) {
      return scale[0];
    }

    const ratio = cell.count / model.maxCount;
    if (ratio < 0.25) {
      return scale[1];
    }
    if (ratio < 0.5) {
      return scale[2];
    }
    if (ratio < 0.75) {
      return scale[3];
    }
    return scale[4];
  }

  const focusedCell =
    (selectedDate && model.byDate.get(selectedDate)) ||
    (hoveredDate && model.byDate.get(hoveredDate)) ||
    null;

  if (days.length === 0) {
    return (
      <div className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-1)] p-4 text-sm text-[var(--text-dim)]">
        {t('common.heatmapEmpty')}
      </div>
    );
  }

  function onLeaveGrid() {
    setHoveredDate(null);
  }

  function handleSelect(cell: Cell) {
    if (!cell.inRange) {
      return;
    }
    const next = selectedDate === cell.date ? null : cell.date;
    setSelectedDate(next);
    if (onSelect) {
      onSelect(next ? { date: cell.date, count: cell.count, color: cell.color } : null);
    }
  }

  const weekdayColumnWidth = showWeekdays ? 22 : 0;

  return (
    <div className={className}>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-[12px] text-[var(--text-dim)]">
        <div className="flex items-baseline gap-2">
          <span className="num text-[14px] font-semibold text-[var(--text)]">
            {numberLabel(totalValue ?? model.total, nLocale)}
          </span>
          <span>{effectiveTotalLabel}</span>
        </div>

        <div className="flex items-center gap-1 text-[11px]">
          <span>{t('common.heatmapLess')}</span>
          {scale.map((color) => (
            <span
              key={color}
              className="inline-block h-3 w-3 rounded-sm"
              style={{
                backgroundColor:
                  color === 'rgba(255,255,255,0.04)' ? 'rgba(255,255,255,0.04)' : color,
              }}
            />
          ))}
          <span>{t('common.heatmapMore')}</span>
        </div>
      </div>

      {focusedCell ? (
        <div className="mb-2 flex items-center justify-between gap-2 rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-2)] px-3 py-1.5 text-[12px]">
          <span className="text-[var(--text-mute)]">
            {formatDateLong(focusedCell.date, dtLocale)}
          </span>
          <span className="num font-medium text-[var(--text)]">
            {numberLabel(focusedCell.count, nLocale)} {effectiveTotalLabel}
          </span>
        </div>
      ) : (
        <div className="mb-2 h-7" />
      )}

      <div className="overflow-auto pb-1">
        <div
          className="flex items-start"
          style={minWidth ? { minWidth: `${minWidth}px` } : undefined}
        >
          {showWeekdays ? (
            <div
              className="flex flex-col"
              style={{
                rowGap: `${normalizedCellGap}px`,
                marginTop: `${16 + normalizedCellGap}px`,
                width: `${weekdayColumnWidth}px`,
              }}
            >
              {weekdayLabels.map((label, index) => (
                <span
                  key={label}
                  className="text-[10px] leading-none text-[var(--text-faint)]"
                  style={{
                    height: `${normalizedCellSize}px`,
                    lineHeight: `${normalizedCellSize}px`,
                    visibility: index % 2 === 1 ? 'visible' : 'hidden',
                  }}
                >
                  {label}
                </span>
              ))}
            </div>
          ) : null}

          <div>
            <div
              className="relative mb-1 h-4"
              style={{ width: `${Math.max(1, model.weeks.length) * columnStride}px` }}
            >
              {model.monthLabels.map((item) => (
                <span
                  key={`${item.label}-${item.index}`}
                  className="absolute text-[10px] uppercase tracking-wide text-[var(--text-dim)]"
                  style={{ left: `${item.index * columnStride}px` }}
                >
                  {item.label}
                </span>
              ))}
            </div>

            <div
              className="flex"
              style={{ columnGap: `${normalizedCellGap}px` }}
              onMouseLeave={onLeaveGrid}
            >
              {model.weeks.map((week) => (
                <div
                  key={week[0]?.date || 'week-empty'}
                  className="grid grid-rows-7"
                  style={{ rowGap: `${normalizedCellGap}px` }}
                >
                  {week.map((cell) => {
                    const isSelected = selectedDate === cell.date;
                    const isHover = hoveredDate === cell.date;
                    return (
                      <button
                        type="button"
                        key={cell.date}
                        onClick={() => handleSelect(cell)}
                        onMouseEnter={() => cell.inRange && setHoveredDate(cell.date)}
                        onFocus={() => cell.inRange && setHoveredDate(cell.date)}
                        aria-label={`${cell.date} · ${cell.count}`}
                        disabled={!cell.inRange}
                        className="rounded-[3px] transition-transform duration-100 disabled:cursor-default"
                        style={{
                          backgroundColor: colorFor(cell),
                          width: `${normalizedCellSize}px`,
                          height: `${normalizedCellSize}px`,
                          border: isSelected
                            ? '1px solid var(--accent)'
                            : isHover && cell.inRange
                              ? '1px solid rgba(255,255,255,0.3)'
                              : cell.inRange
                                ? '1px solid rgba(255,255,255,0.05)'
                                : '1px solid transparent',
                          transform: isSelected || isHover ? 'scale(1.15)' : 'scale(1)',
                          boxShadow: isSelected ? '0 0 0 2px rgba(100,210,255,0.25)' : undefined,
                        }}
                      />
                    );
                  })}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
