"use client";

import { useMemo } from "react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { seriesColor } from "@/features/dashboards/series-colors";
import type { TaskGroupRow } from "../types";

/** Groups drawn in their own colour; the rest are summed into one series. */
const MAX_SERIES = 8;
const OTHER = "Other";

function shortDay(day: string): string {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

export function buildTrendSeries(rows: readonly TaskGroupRow[], days: readonly string[]) {
  const ranked = [...rows].sort((a, b) => b.count - a.count);
  const shown = ranked.slice(0, MAX_SERIES);
  const rest = ranked.slice(MAX_SERIES);
  const keys = shown.map((r) => r.name);
  if (rest.length > 0) keys.push(OTHER);
  const data = days.map((day) => {
    const point: Record<string, string | number> = { day };
    for (const r of shown) point[r.name] = r.trend.find((p) => p.day === day)?.count ?? 0;
    if (rest.length > 0) {
      point[OTHER] = rest.reduce(
        (sum, r) => sum + (r.trend.find((p) => p.day === day)?.count ?? 0),
        0,
      );
    }
    return point;
  });
  return { keys, data };
}

/** Sampled traces per day, stacked by group: how the mix of tasks moves over time. */
export function TopicsTrendChart({
  rows,
  days,
}: {
  rows: readonly TaskGroupRow[];
  days: readonly string[];
}) {
  const { keys, data } = useMemo(() => buildTrendSeries(rows, days), [rows, days]);
  if (rows.length === 0 || days.length === 0) return null;
  return (
    <div className="border-b border-border px-4 py-3">
      <div className="mb-2 flex items-baseline justify-between">
        <h2 className="text-[12px] font-medium text-foreground">Over time</h2>
        <span className="text-[11px] text-muted-foreground">
          Sampled traces per day, by topic (UTC days)
        </span>
      </div>
      <div
        className="h-[170px] w-full"
        data-testid="topics-trend-chart"
        role="img"
        aria-label={`Sampled traces per day for ${keys.join(", ")}`}
      >
        <ResponsiveContainer
          width="100%"
          height="100%"
          initialDimension={{ width: 640, height: 170 }}
        >
          <BarChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: -12 }}>
            <CartesianGrid vertical={false} stroke="hsl(var(--border))" />
            <XAxis
              dataKey="day"
              tickFormatter={shortDay}
              tickLine={false}
              axisLine={false}
              tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
              interval="preserveStartEnd"
            />
            <YAxis
              allowDecimals={false}
              tickLine={false}
              axisLine={false}
              tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
            />
            <Tooltip
              cursor={{ fill: "hsl(var(--muted))", opacity: 0.4 }}
              labelFormatter={(label) => shortDay(String(label))}
              contentStyle={{
                background: "hsl(var(--background))",
                border: "1px solid var(--border)",
                borderRadius: 6,
                fontSize: 12,
              }}
            />
            {keys.map((key, i) => (
              <Bar
                key={key}
                dataKey={key}
                stackId="topics"
                fill={seriesColor(i)}
                isAnimationActive={false}
              />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
      <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
        {keys.map((key, i) => (
          <li key={key} className="flex items-center gap-1.5">
            <span
              className="inline-block h-2 w-2 rounded-sm"
              style={{ background: seriesColor(i) }}
              aria-hidden
            />
            {key}
          </li>
        ))}
      </ul>
    </div>
  );
}
