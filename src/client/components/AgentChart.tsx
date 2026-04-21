import { useMemo } from 'react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

/**
 * Renders an inline chart embedded by the agent in its markdown reply.
 *
 * The assistant emits a fenced block:
 *
 *   <chart type="bar" title="Tokens aujourd'hui" unit="tokens">
 *   {"labels":["Claude","Codex"], "values":[15000, 3200]}
 *   </chart>
 *
 * Supported types: bar, line, area, donut. Single-series uses `values[]`,
 * multi-series uses `series: [{name, values}]`. All rendering is via Recharts
 * with our design tokens.
 */

export type ChartSpec = {
  type: 'bar' | 'line' | 'area' | 'donut';
  title?: string;
  unit?: string;
  labels: string[];
  values?: number[];
  series?: Array<{ name: string; values: number[] }>;
};

const PALETTE = [
  '#64d2ff', // accent
  '#30d158', // success
  '#ffd60a', // warn
  '#bf5af2', // violet
  '#ff453a', // danger
  '#0a84ff', // accent-strong
  '#ff9f0a',
  '#64dd17',
];

function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return '0';
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (Math.abs(n) >= 10_000) return `${(n / 1_000).toFixed(0)}k`;
  if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n * 100) / 100);
}

function parseSpec(raw: string, attrs: Record<string, string | undefined>): ChartSpec | null {
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!payload || typeof payload !== 'object') return null;
  const p = payload as Record<string, unknown>;
  const labels = Array.isArray(p.labels) ? p.labels.map((l) => String(l)) : [];
  if (labels.length === 0) return null;

  const typeAttr = (attrs.type || 'bar').toLowerCase();
  const type: ChartSpec['type'] =
    typeAttr === 'line' || typeAttr === 'area' || typeAttr === 'donut' ? typeAttr : 'bar';

  const values = Array.isArray(p.values) ? (p.values as unknown[]).map(Number) : undefined;
  const series = Array.isArray(p.series)
    ? (p.series as Array<Record<string, unknown>>)
        .map((s) => ({
          name: typeof s.name === 'string' ? s.name : 'series',
          values: Array.isArray(s.values) ? (s.values as unknown[]).map(Number) : [],
        }))
        .filter((s) => s.values.length > 0)
    : undefined;

  if (!values && (!series || series.length === 0)) return null;

  return {
    type,
    title: attrs.title,
    unit: attrs.unit,
    labels,
    values,
    series,
  };
}

/** Accepts the raw `<chart ...>...</chart>` substring (attributes + body). */
export function AgentChartFromRaw({ raw }: { raw: string }) {
  const parsed = useMemo(() => {
    const match = raw.match(/^<chart\b([^>]*)>([\s\S]*?)<\/chart>$/i);
    if (!match) return null;
    const attrStr = match[1] || '';
    const body = match[2] || '';
    const attrs: Record<string, string> = {};
    for (const m of attrStr.matchAll(/(\w+)\s*=\s*"([^"]*)"/g)) {
      attrs[m[1].toLowerCase()] = m[2];
    }
    return parseSpec(body.trim(), attrs);
  }, [raw]);

  if (!parsed) {
    return (
      <pre className="whitespace-pre-wrap rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-1)] px-3 py-2 text-[11px] text-[var(--text-dim)]">
        {raw}
      </pre>
    );
  }

  return <AgentChart spec={parsed} />;
}

export function AgentChart({ spec }: { spec: ChartSpec }) {
  const multi = spec.series && spec.series.length > 0;
  const data = useMemo(() => {
    return spec.labels.map((label, i) => {
      const row: Record<string, number | string> = { label };
      if (multi && spec.series) {
        for (const s of spec.series) {
          row[s.name] = s.values[i] ?? 0;
        }
      } else {
        row.value = spec.values?.[i] ?? 0;
      }
      return row;
    });
  }, [spec, multi]);

  const seriesNames = multi && spec.series ? spec.series.map((s) => s.name) : ['value'];

  const chartBody = (() => {
    if (spec.type === 'donut') {
      const donutData = seriesNames.flatMap((name, si) =>
        data.map((row, i) => ({
          name: multi ? `${row.label} · ${name}` : String(row.label),
          value: Number(row[name] ?? 0),
          paletteIdx: multi ? si * spec.labels.length + i : i,
        })),
      );
      return (
        <PieChart>
          <Tooltip
            contentStyle={{
              background: 'rgba(11,13,17,0.96)',
              border: '1px solid rgba(255,255,255,0.12)',
              borderRadius: 10,
              color: '#f5f5f7',
              fontSize: 12,
            }}
            formatter={(v) => `${formatNumber(Number(v))}${spec.unit ? ` ${spec.unit}` : ''}`}
          />
          <Pie
            data={donutData}
            dataKey="value"
            innerRadius="55%"
            outerRadius="85%"
            paddingAngle={2}
          >
            {donutData.map((d) => (
              <Cell key={d.name} fill={PALETTE[d.paletteIdx % PALETTE.length]} />
            ))}
          </Pie>
          <Legend wrapperStyle={{ fontSize: 11, color: 'rgba(245,245,247,0.72)' }} iconSize={10} />
        </PieChart>
      );
    }

    const commonAxes = (
      <>
        <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
        <XAxis
          dataKey="label"
          tick={{ fill: 'rgba(245,245,247,0.48)', fontSize: 11 }}
          axisLine={{ stroke: 'rgba(255,255,255,0.08)' }}
          tickLine={false}
          minTickGap={8}
        />
        <YAxis
          tick={{ fill: 'rgba(245,245,247,0.48)', fontSize: 11 }}
          axisLine={{ stroke: 'rgba(255,255,255,0.08)' }}
          tickLine={false}
          tickFormatter={(v: number) => formatNumber(v)}
        />
        <Tooltip
          contentStyle={{
            background: 'rgba(11,13,17,0.96)',
            border: '1px solid rgba(255,255,255,0.12)',
            borderRadius: 10,
            color: '#f5f5f7',
            fontSize: 12,
          }}
          formatter={(v) => `${formatNumber(Number(v))}${spec.unit ? ` ${spec.unit}` : ''}`}
        />
        {multi ? (
          <Legend wrapperStyle={{ fontSize: 11, color: 'rgba(245,245,247,0.72)' }} iconSize={10} />
        ) : null}
      </>
    );

    if (spec.type === 'line') {
      return (
        <LineChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          {commonAxes}
          {seriesNames.map((name, i) => (
            <Line
              key={name}
              type="monotone"
              dataKey={name}
              stroke={PALETTE[i % PALETTE.length]}
              strokeWidth={2}
              dot={{ r: 2, stroke: PALETTE[i % PALETTE.length], fill: PALETTE[i % PALETTE.length] }}
              activeDot={{ r: 4 }}
            />
          ))}
        </LineChart>
      );
    }

    if (spec.type === 'area') {
      return (
        <AreaChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          {commonAxes}
          {seriesNames.map((name, i) => (
            <Area
              key={name}
              type="monotone"
              dataKey={name}
              stroke={PALETTE[i % PALETTE.length]}
              strokeWidth={2}
              fill={PALETTE[i % PALETTE.length]}
              fillOpacity={0.18}
            />
          ))}
        </AreaChart>
      );
    }

    // bar
    return (
      <BarChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        {commonAxes}
        {seriesNames.map((name, i) => (
          <Bar key={name} dataKey={name} fill={PALETTE[i % PALETTE.length]} radius={[6, 6, 0, 0]} />
        ))}
      </BarChart>
    );
  })();

  return (
    <figure className="my-3 flex flex-col gap-1.5 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-1)] px-3 py-3">
      {spec.title ? (
        <figcaption className="flex items-center justify-between text-[11px] text-[var(--text-dim)]">
          <span className="font-medium text-[var(--text-mute)]">{spec.title}</span>
          {spec.unit ? (
            <span className="text-[10px] text-[var(--text-faint)]">{spec.unit}</span>
          ) : null}
        </figcaption>
      ) : null}
      <div className="h-44 w-full">
        <ResponsiveContainer width="100%" height="100%">
          {chartBody}
        </ResponsiveContainer>
      </div>
    </figure>
  );
}
