"use client";

import { useMemo } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { DisplayType, FieldUnit, WidgetQueryResult } from "../types";

// Pastel series palette mirroring the span-kind tints
// (violet=llm, blue=agent, amber=tool, slate=span), then softened extras.
export const SERIES_COLORS = [
  "#a78bfa",
  "#60a5fa",
  "#fbbf24",
  "#94a3b8",
  "#34d399",
  "#f472b6",
  "#22d3ee",
  "#fb923c",
];

const seriesColor = (i: number) => SERIES_COLORS[i % SERIES_COLORS.length];

// Recharts marks its wrapper and SVG internals keyboard-focusable, so clicking
// anywhere in a chart paints the browser's focus outline around the clicked
// wrapper/layer/sector — suppress it on every chart surface.
const CHART_FOCUS_RESET =
  "[&_.recharts-wrapper]:outline-none [&_.recharts-surface]:outline-none " +
  "[&_.recharts-layer]:outline-none [&_.recharts-sector]:outline-none";

// ClickHouse returns Decimal columns as strings; coerce them before charting
// or formatting — recharts (the pie especially) can't plot string values.
const coerceNumeric = (v: unknown): unknown =>
  typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : v;

export function pivotRows(columns: string[], rows: WidgetQueryResult["rows"]) {
  // Shapes: [value] | [bucket, value] | [dim, value] | [bucket, dim, value]
  const valueIdx = columns.length - 1;
  const hasBucket = columns[0] === "bucket";
  const dimIdx = hasBucket ? (columns.length === 3 ? 1 : -1) : columns.length === 2 ? 0 : -1;

  if (dimIdx === -1) {
    const key = hasBucket ? "bucket" : columns[0];
    return {
      seriesKeys: ["value"],
      data: rows.map((r) => ({
        [key]: r[0],
        value: coerceNumeric(r[valueIdx]),
      })) as Record<string, unknown>[],
    };
  }

  if (!hasBucket) {
    // categorical: one row per dimension value
    return {
      seriesKeys: rows.map((r) => String(r[dimIdx] ?? "null")),
      data: rows.map((r) => ({
        name: String(r[dimIdx] ?? "null"),
        value: coerceNumeric(r[valueIdx]),
      })),
    };
  }

  const seriesKeys: string[] = [];
  // O(1) membership check alongside the ordered array
  const seriesKeySet = new Set<string>();
  const byBucket = new Map<string, Record<string, unknown>>();

  for (const r of rows) {
    const bucket = String(r[0]);
    const rawDim = r[dimIdx];
    // The query's WITH FILL synthesizes rows for empty buckets, carrying the
    // breakdown column's default ('' — or NULL if a Nullable expr ever slips
    // past the compiler's type pin) and a zero value. They extend the x-axis
    // domain but are not a series: register the bucket and move on.
    if ((rawDim === "" || rawDim == null) && !Number(r[valueIdx])) {
      if (!byBucket.has(bucket)) byBucket.set(bucket, { bucket });
      continue;
    }
    // Guard against key collisions with internal properties: if a dim value is
    // "bucket" or "__proto__", prefix it so it doesn't stomp on the pivot row shape.
    const dim =
      rawDim === "bucket" || rawDim === "__proto__" ? `series:${rawDim}` : String(rawDim ?? "null");

    if (!seriesKeySet.has(dim)) {
      seriesKeys.push(dim);
      seriesKeySet.add(dim);
    }
    if (!byBucket.has(bucket)) byBucket.set(bucket, { bucket });
    byBucket.get(bucket)![dim] = coerceNumeric(r[valueIdx]);
  }

  // Uniform zero-fill: missing series keys per bucket are set to 0 so
  // line/area charts tell the same story. Honest for count/sum (the dominant
  // dashboard aggregations), slightly lossy for percentile gaps — accepted tradeoff.
  const data = [...byBucket.values()].map((row) => {
    const filled = { ...row };
    for (const k of seriesKeys) {
      if (!Object.hasOwn(filled, k)) filled[k] = 0;
    }
    return filled;
  });

  return { seriesKeys, data };
}

export const fmtNumber = (v: unknown) => {
  const n = coerceNumeric(v);
  if (typeof n !== "number") return String(n ?? "—");
  const abs = Math.abs(n);
  // Tiny non-zero values (e.g. sub-millidollar costs) would round to "0" with
  // maximumFractionDigits:4; fall back to significant-digit formatting instead.
  if (abs > 0 && abs < 0.001) {
    return Intl.NumberFormat("en", { maximumSignificantDigits: 2 }).format(n);
  }
  return Intl.NumberFormat("en", { maximumFractionDigits: 4 }).format(n);
};

// The query engine aliases the metric column literally as "value", which is
// also the single-series dataKey recharts reports as the tooltip name. When
// the caller passes the spec's measure name, show that instead; breakdown
// series keep their own names.
export const seriesNameFormatter = (seriesLabel?: string) => (name: string) =>
  name === "value" && seriesLabel ? seriesLabel : name;

// Bucket keys come back ISO-ish ("2026-06-01T00:00:00"); a space reads better
// in the tooltip header than the "T" separator.
export const bucketLabel = (label: unknown) => String(label).replace("T", " ");

// Hover popup shared by every chart display: a card with an optional bold
// label header (time bucket / category) and one row per series — a color
// swatch square, the series name in muted text, and the value right-aligned
// in tabular figures.
export function ChartTip({
  active,
  payload,
  label,
  nameFormatter,
  labelFormatter,
}: {
  active?: boolean;
  payload?: {
    name?: string | number;
    value?: unknown;
    color?: string;
    payload?: { fill?: string };
  }[];
  label?: unknown;
  nameFormatter?: (name: string) => string;
  labelFormatter?: (label: unknown) => string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="grid min-w-32 gap-1.5 rounded-lg border border-border/50 bg-background px-2.5 py-1.5 text-xs shadow-xl">
      {label != null && label !== "" && (
        <div className="font-medium">{labelFormatter ? labelFormatter(label) : String(label)}</div>
      )}
      <div className="grid gap-1.5">
        {payload.map((item, i) => {
          const rawName = String(item.name ?? "");
          return (
            <div key={i} className="flex w-full items-center gap-2">
              <div
                className="h-2.5 w-2.5 shrink-0 rounded-[2px]"
                style={{ backgroundColor: item.payload?.fill ?? item.color ?? "currentColor" }}
              />
              <div className="flex min-w-0 flex-1 items-center justify-between gap-x-3 leading-tight">
                <span className="truncate text-muted-foreground">
                  {nameFormatter ? nameFormatter(rawName) : rawName}
                </span>
                <span className="shrink-0 whitespace-nowrap font-mono font-medium tabular-nums text-foreground">
                  {fmtNumber(item.value)}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Categorical rows tinted per-index; the `fill` on each row is also what the
// tooltip payload reads for its swatch.
function useColoredRows(result: WidgetQueryResult) {
  return useMemo(
    () =>
      pivotRows(result.columns, result.rows).data.map((d, i) => ({
        ...d,
        fill: seriesColor(i),
      })),
    [result],
  );
}

function TimeSeries({
  result,
  area,
  seriesLabel,
}: {
  result: WidgetQueryResult;
  area: boolean;
  seriesLabel?: string;
}) {
  const { seriesKeys, data } = useMemo(() => pivotRows(result.columns, result.rows), [result]);
  const Chart = area ? AreaChart : LineChart;
  const granularity = result.meta.granularity;

  // A breakdown window where every row is a WITH FILL gap row pivots to zero
  // series — show the empty state rather than a bare grid. (No-breakdown
  // all-zero windows keep their flat zero line: the "value" series exists.)
  if (seriesKeys.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-[12px] text-muted-foreground">
        No data in range
      </div>
    );
  }

  const tickFormatter =
    granularity === "day"
      ? (v: unknown) => String(v).slice(5, 10)
      : granularity === "hour"
        ? (v: unknown) => String(v).slice(5, 16).replace("T", " ")
        : (v: unknown) => String(v).slice(5, 16);

  return (
    <ResponsiveContainer width="100%" height="100%" className={CHART_FOCUS_RESET}>
      <Chart data={data} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
        <CartesianGrid strokeOpacity={0.15} vertical={false} />
        <XAxis dataKey="bucket" tick={{ fontSize: 10 }} tickFormatter={tickFormatter} />
        <YAxis tick={{ fontSize: 10 }} width={42} />
        <Tooltip
          isAnimationActive={false}
          content={
            <ChartTip
              nameFormatter={seriesNameFormatter(seriesLabel)}
              labelFormatter={bucketLabel}
            />
          }
        />
        {/* isAnimationActive={false} on every mark (here and in the other
            charts): the default ~1.4s geometry morph makes charts visibly lag
            behind their tile during grid resizes and data refreshes. */}
        {seriesKeys.map((k, i) =>
          area ? (
            <Area
              key={k}
              dataKey={k}
              stackId="1"
              stroke={seriesColor(i)}
              fill={seriesColor(i)}
              fillOpacity={0.35}
              isAnimationActive={false}
            />
          ) : (
            <Line
              key={k}
              dataKey={k}
              stroke={seriesColor(i)}
              dot={false}
              strokeWidth={1.5}
              isAnimationActive={false}
            />
          ),
        )}
      </Chart>
    </ResponsiveContainer>
  );
}

function Bars({ result, seriesLabel }: { result: WidgetQueryResult; seriesLabel?: string }) {
  const data = useColoredRows(result);
  return (
    <ResponsiveContainer width="100%" height="100%" className={CHART_FOCUS_RESET}>
      <BarChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
        <CartesianGrid strokeOpacity={0.15} vertical={false} />
        <XAxis dataKey="name" tick={{ fontSize: 10 }} />
        <YAxis tick={{ fontSize: 10 }} width={42} />
        <Tooltip
          isAnimationActive={false}
          content={<ChartTip nameFormatter={seriesNameFormatter(seriesLabel)} />}
        />
        <Bar dataKey="value" isAnimationActive={false}>
          {data.map((_, i) => (
            <Cell key={i} fill={seriesColor(i)} fillOpacity={0.7} stroke={seriesColor(i)} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

function PieView({ result }: { result: WidgetQueryResult }) {
  const data = useColoredRows(result);
  return (
    <ResponsiveContainer width="100%" height="100%" className={CHART_FOCUS_RESET}>
      <PieChart>
        <Tooltip isAnimationActive={false} content={<ChartTip />} />
        {/* Pie reads each sector's fill from its data row — no Cells needed. */}
        <Pie
          data={data}
          dataKey="value"
          nameKey="name"
          innerRadius="45%"
          outerRadius="80%"
          isAnimationActive={false}
        />
      </PieChart>
    </ResponsiveContainer>
  );
}

// Stat values must stay inside a fixed tile no matter how many digits arrive:
// large magnitudes compact ("706K", "12.3M") so the glyph count is bounded,
// and the font clamps to the tile's width for narrow resizes.
export const fmtStatNumber = (v: unknown) => {
  const n = coerceNumeric(v);
  if (typeof n === "number" && Math.abs(n) >= 100_000) {
    return Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(n);
  }
  return fmtNumber(v);
};

function NumberView({ result, unit }: { result: WidgetQueryResult; unit?: FieldUnit }) {
  const value = result.rows[0]?.[result.columns.length - 1];
  return (
    <div className="flex h-full items-center justify-center overflow-hidden [container-type:inline-size]">
      <div className="flex min-w-0 items-baseline gap-1">
        <span
          className="whitespace-nowrap font-semibold"
          style={{ fontSize: "clamp(1rem, 19cqw, 1.875rem)" }}
        >
          {unit?.prefix}
          {fmtStatNumber(value)}
        </span>
        {unit?.suffix && <span className="text-[13px] text-muted-foreground">{unit.suffix}</span>}
      </div>
    </div>
  );
}

function TableView({ result }: { result: WidgetQueryResult }) {
  // Only the metric column (always last, aliased "value" by the compiler) is
  // numeric — formatting every cell reformats string dimensions too, and a
  // numeric-looking identifier (user_id, session_id) silently loses digits
  // past 2^53 or its leading zeros in Number() coercion.
  const valueIdx = result.columns.length - 1;
  return (
    <div className="h-full overflow-auto">
      <table className="w-full text-[11.5px]">
        <thead>
          <tr className="text-left text-[10px] uppercase tracking-wide text-muted-foreground">
            {result.columns.map((c) => (
              <th key={c} className="pb-1.5 pr-3 font-medium">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {result.rows.map((r, i) => (
            <tr key={i} className="border-t border-border/60">
              {r.map((v, j) => (
                <td key={j} className="py-1 pr-3">
                  {j === valueIdx ? fmtNumber(v) : v == null ? "—" : String(v)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function HistogramView({
  result,
  seriesLabel,
}: {
  result: WidgetQueryResult;
  seriesLabel?: string;
}) {
  // rows: [lo, hi, height]
  const data = result.rows.map((r) => ({
    name: `${fmtNumber(r[0])}–${fmtNumber(r[1])}`,
    value: r[2],
    fill: "#93c5fd",
  }));
  return (
    <ResponsiveContainer width="100%" height="100%" className={CHART_FOCUS_RESET}>
      <BarChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
        <XAxis dataKey="name" tick={{ fontSize: 9 }} interval="preserveStartEnd" />
        <YAxis tick={{ fontSize: 10 }} width={42} />
        <Tooltip
          isAnimationActive={false}
          content={<ChartTip nameFormatter={seriesNameFormatter(seriesLabel)} />}
        />
        <Bar
          dataKey="value"
          fill="#93c5fd"
          fillOpacity={0.7}
          stroke="#60a5fa"
          isAnimationActive={false}
        />
      </BarChart>
    </ResponsiveContainer>
  );
}

export function QueryWidgetRenderer({
  display,
  result,
  unit,
  seriesLabel,
}: {
  display: DisplayType;
  result: WidgetQueryResult;
  unit?: FieldUnit;
  /** Measure name from the widget spec, shown as the single-series tooltip row name. */
  seriesLabel?: string;
}) {
  if (result.rows.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-[12px] text-muted-foreground">
        No data in range
      </div>
    );
  }
  switch (display) {
    case "line":
      return <TimeSeries result={result} area={false} seriesLabel={seriesLabel} />;
    case "area":
      return <TimeSeries result={result} area seriesLabel={seriesLabel} />;
    case "bar":
      return <Bars result={result} seriesLabel={seriesLabel} />;
    case "pie":
      return <PieView result={result} />;
    case "number":
      return <NumberView result={result} unit={unit} />;
    case "table":
      return <TableView result={result} />;
    case "histogram":
      return <HistogramView result={result} seriesLabel={seriesLabel} />;
  }
}
