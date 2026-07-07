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
        value: r[valueIdx],
      })) as Record<string, unknown>[],
    };
  }

  if (!hasBucket) {
    // categorical: one row per dimension value
    return {
      seriesKeys: rows.map((r) => String(r[dimIdx] ?? "null")),
      data: rows.map((r) => ({
        name: String(r[dimIdx] ?? "null"),
        value: r[valueIdx],
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
    // Guard against key collisions with internal properties: if a dim value is
    // "bucket" or "__proto__", prefix it so it doesn't stomp on the pivot row shape.
    const dim =
      rawDim === "bucket" || rawDim === "__proto__" ? `series:${rawDim}` : String(rawDim ?? "null");

    if (!seriesKeySet.has(dim)) {
      seriesKeys.push(dim);
      seriesKeySet.add(dim);
    }
    if (!byBucket.has(bucket)) byBucket.set(bucket, { bucket });
    byBucket.get(bucket)![dim] = r[valueIdx];
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

// ClickHouse returns Decimal columns as strings; coerce them before formatting.
const coerceNumeric = (v: unknown): unknown =>
  typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : v;

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

function TimeSeries({ result, area }: { result: WidgetQueryResult; area: boolean }) {
  const { seriesKeys, data } = useMemo(() => pivotRows(result.columns, result.rows), [result]);
  const Chart = area ? AreaChart : LineChart;
  const granularity = result.meta.granularity;

  const tickFormatter =
    granularity === "day"
      ? (v: unknown) => String(v).slice(5, 10)
      : granularity === "hour"
        ? (v: unknown) => String(v).slice(5, 16).replace("T", " ")
        : (v: unknown) => String(v).slice(5, 16);

  return (
    <ResponsiveContainer width="100%" height="100%">
      <Chart data={data} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
        <CartesianGrid strokeOpacity={0.15} vertical={false} />
        <XAxis dataKey="bucket" tick={{ fontSize: 10 }} tickFormatter={tickFormatter} />
        <YAxis tick={{ fontSize: 10 }} width={42} />
        <Tooltip />
        {seriesKeys.map((k, i) =>
          area ? (
            <Area
              key={k}
              dataKey={k}
              stackId="1"
              stroke={SERIES_COLORS[i % SERIES_COLORS.length]}
              fill={SERIES_COLORS[i % SERIES_COLORS.length]}
              fillOpacity={0.35}
            />
          ) : (
            <Line
              key={k}
              dataKey={k}
              stroke={SERIES_COLORS[i % SERIES_COLORS.length]}
              dot={false}
              strokeWidth={1.5}
            />
          ),
        )}
      </Chart>
    </ResponsiveContainer>
  );
}

function Bars({ result }: { result: WidgetQueryResult }) {
  const { data } = useMemo(() => pivotRows(result.columns, result.rows), [result]);
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
        <CartesianGrid strokeOpacity={0.15} vertical={false} />
        <XAxis dataKey="name" tick={{ fontSize: 10 }} />
        <YAxis tick={{ fontSize: 10 }} width={42} />
        <Tooltip />
        <Bar dataKey="value">
          {data.map((_, i) => (
            <Cell
              key={i}
              fill={SERIES_COLORS[i % SERIES_COLORS.length]}
              fillOpacity={0.7}
              stroke={SERIES_COLORS[i % SERIES_COLORS.length]}
            />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

function PieView({ result }: { result: WidgetQueryResult }) {
  const { data } = useMemo(() => pivotRows(result.columns, result.rows), [result]);
  return (
    <ResponsiveContainer width="100%" height="100%">
      <PieChart>
        <Tooltip />
        <Pie data={data} dataKey="value" nameKey="name" innerRadius="45%" outerRadius="80%">
          {data.map((_, i) => (
            <Cell key={i} fill={SERIES_COLORS[i % SERIES_COLORS.length]} />
          ))}
        </Pie>
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
                  {fmtNumber(v)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function HistogramView({ result }: { result: WidgetQueryResult }) {
  // rows: [lo, hi, height]
  const data = result.rows.map((r) => ({
    name: `${fmtNumber(r[0])}–${fmtNumber(r[1])}`,
    value: r[2],
  }));
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
        <XAxis dataKey="name" tick={{ fontSize: 9 }} interval="preserveStartEnd" />
        <YAxis tick={{ fontSize: 10 }} width={42} />
        <Tooltip />
        <Bar dataKey="value" fill="#93c5fd" fillOpacity={0.7} stroke="#60a5fa" />
      </BarChart>
    </ResponsiveContainer>
  );
}

export function QueryWidgetRenderer({
  display,
  result,
  unit,
}: {
  display: DisplayType;
  result: WidgetQueryResult;
  unit?: FieldUnit;
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
      return <TimeSeries result={result} area={false} />;
    case "area":
      return <TimeSeries result={result} area />;
    case "bar":
      return <Bars result={result} />;
    case "pie":
      return <PieView result={result} />;
    case "number":
      return <NumberView result={result} unit={unit} />;
    case "table":
      return <TableView result={result} />;
    case "histogram":
      return <HistogramView result={result} />;
  }
}
