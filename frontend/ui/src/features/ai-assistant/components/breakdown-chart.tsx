"use client";

import { useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { CopyButton } from "@/components/ui/copy-button";
import { formatDuration } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Breakdown detection + chart rendering for AI assistant messages (issue #1383)
//
// The trace-analysis agent often answers performance questions with a markdown
// table shaped like: stage/name | duration | percentage | issue. In the narrow
// assistant sidebar those tables collapse into stacked cards that are tiring to
// scan. When we can recognize that shape, we render a compact chart (a donut for
// the proportional split + horizontal bars for duration comparison) and keep the
// exact table one click away.
// ---------------------------------------------------------------------------

// Palette works on both light and dark themes; index-cycled per row.
const PALETTE = [
  "#6366f1", // indigo
  "#0ea5e9", // sky
  "#f59e0b", // amber
  "#10b981", // emerald
  "#ef4444", // red
  "#a855f7", // purple
  "#ec4899", // pink
  "#14b8a6", // teal
];

const LABEL_KEYWORDS =
  /stage|step|name|category|phase|operation|span|service|model|section|component|阶段|步骤|名称|类别|环节|阶段名/i;
const DURATION_HEADER_KEYWORDS =
  /duration|time|latency|elapsed|took|spent|耗时|用时|时间|时长/i;

interface BreakdownItem {
  label: string;
  durationMs: number | null;
  durationText: string | null;
  percent: number | null;
  percentText: string | null;
  /** Remaining non-empty columns (e.g. issue / root cause) preserved for context. */
  extras: { header: string; value: string }[];
}

export interface BreakdownData {
  items: BreakdownItem[];
  hasDuration: boolean;
  hasPercent: boolean;
}

// --- numeric parsing -------------------------------------------------------

const DURATION_TOKEN_RE =
  /(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|sec|secs|seconds?|m|min|mins|minutes?|h|hr|hrs|hours?)/g;

function unitToMs(value: number, unit: string): number {
  const u = unit.toLowerCase();
  if (u === "ms" || u.startsWith("milli")) return value;
  if (u === "s" || u.startsWith("sec")) return value * 1000;
  if (u === "m" || u.startsWith("min")) return value * 60_000;
  return value * 3_600_000; // h / hr / hour
}

/** Parse unit-bearing durations: "33s", "650ms", "1.2s", "2m 5s", "1h 3m". */
function parseDurationMs(raw: string): number | null {
  const s = raw.trim().toLowerCase();
  if (!s) return null;
  DURATION_TOKEN_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  let total = 0;
  let found = false;
  while ((match = DURATION_TOKEN_RE.exec(s)) !== null) {
    found = true;
    total += unitToMs(parseFloat(match[1]), match[2]);
  }
  if (!found) return null;
  // Reject strings that are more than just duration tokens (e.g. "gpt-4s", "v2s").
  const leftover = s.replace(DURATION_TOKEN_RE, "").replace(/[\s,.:]/g, "");
  if (/[a-z0-9]/.test(leftover)) return null;
  return total;
}

/** Parse durations, falling back to a bare number when the header names a unit. */
function parseDurationForColumn(cell: string, header: string): number | null {
  const direct = parseDurationMs(cell);
  if (direct !== null) return direct;
  const num = cell.trim().replace(/,/g, "");
  if (!/^-?\d+(?:\.\d+)?$/.test(num)) return null;
  const h = header.toLowerCase();
  const v = parseFloat(num);
  if (/\(ms\)|millis|毫秒/.test(h)) return v;
  if (/\(s\)|\bsec|second|秒/.test(h)) return v * 1000;
  if (/\(m\)|\bmin|minute|分/.test(h)) return v * 60_000;
  if (/\(h\)|\bhour|\bhr|小时/.test(h)) return v * 3_600_000;
  return null;
}

function parsePercent(raw: string): number | null {
  const m = raw.match(/(-?\d+(?:\.\d+)?)\s*%/);
  return m ? parseFloat(m[1]) : null;
}

function isNumericish(cell: string): boolean {
  const s = cell.trim();
  if (!s) return true; // blanks don't count as labels
  return parsePercent(s) !== null || parseDurationMs(s) !== null || /^-?[\d.,]+$/.test(s);
}

// --- detection -------------------------------------------------------------

/**
 * Recognize a "performance breakdown" table and extract structured data.
 * Returns null for tables that don't look like a stage/duration/percentage
 * breakdown, so ordinary tables keep their existing rendering.
 */
export function analyzeBreakdown(headers: string[], rows: string[][]): BreakdownData | null {
  const n = rows.length;
  const cols = headers.length;
  if (n < 2 || cols < 2) return null;

  const colStats = Array.from({ length: cols }, (_, c) => {
    let pct = 0;
    let dur = 0;
    let text = 0;
    for (const row of rows) {
      const cell = row[c] ?? "";
      if (parsePercent(cell) !== null) pct++;
      if (parseDurationForColumn(cell, headers[c] ?? "") !== null) dur++;
      if (cell.trim() && !isNumericish(cell)) text++;
    }
    return { pct, dur, text };
  });

  const threshold = Math.ceil(n * 0.6);

  // Percentage column: most cells contain a % value.
  let percentCol: number | null = null;
  for (let c = 0; c < cols; c++) {
    if (colStats[c].pct >= threshold) {
      if (percentCol === null || colStats[c].pct > colStats[percentCol].pct) percentCol = c;
    }
  }

  // Duration column: most cells parse as a duration (prefer a keyword header on ties).
  let durationCol: number | null = null;
  for (let c = 0; c < cols; c++) {
    if (c === percentCol || colStats[c].dur < threshold) continue;
    if (durationCol === null) {
      durationCol = c;
      continue;
    }
    const better = colStats[c].dur > colStats[durationCol].dur;
    const keyword =
      DURATION_HEADER_KEYWORDS.test(headers[c] ?? "") &&
      !DURATION_HEADER_KEYWORDS.test(headers[durationCol] ?? "");
    if (better || keyword) durationCol = c;
  }

  if (percentCol === null && durationCol === null) return null;

  // Label column: a text column, preferring a stage/name-style header.
  let labelCol: number | null = null;
  for (let c = 0; c < cols; c++) {
    if (c === percentCol || c === durationCol) continue;
    if (LABEL_KEYWORDS.test(headers[c] ?? "")) {
      labelCol = c;
      break;
    }
  }
  if (labelCol === null) {
    for (let c = 0; c < cols; c++) {
      if (c === percentCol || c === durationCol) continue;
      if (colStats[c].text >= threshold) {
        labelCol = c;
        break;
      }
    }
  }
  if (labelCol === null) return null;

  const extraCols: number[] = [];
  for (let c = 0; c < cols; c++) {
    if (c !== percentCol && c !== durationCol && c !== labelCol) extraCols.push(c);
  }

  const items: BreakdownItem[] = rows.map((row) => {
    const durationMs =
      durationCol !== null ? parseDurationForColumn(row[durationCol] ?? "", headers[durationCol]) : null;
    const durationText = durationCol !== null ? (row[durationCol] ?? "").trim() || null : null;
    const percent = percentCol !== null ? parsePercent(row[percentCol] ?? "") : null;
    const percentText = percentCol !== null ? (row[percentCol] ?? "").trim() || null : null;
    return {
      label: (row[labelCol!] ?? "").trim() || "—",
      durationMs,
      durationText,
      percent,
      percentText,
      extras: extraCols
        .map((c) => ({ header: headers[c] ?? "", value: (row[c] ?? "").trim() }))
        .filter((e) => e.value.length > 0),
    };
  });

  const hasDuration = items.some((i) => i.durationMs !== null && i.durationMs > 0);
  const hasPercent = items.some((i) => i.percent !== null);
  if (!hasDuration && !hasPercent) return null;

  return { items, hasDuration, hasPercent };
}

// --- rendering -------------------------------------------------------------

interface DerivedItem extends BreakdownItem {
  color: string;
  /** 0–1 proportion of the total, for the donut. */
  share: number;
  /** 0–1 relative to the largest bar magnitude. */
  barFraction: number;
  valueLabel: string;
}

function DonutChart({ items, centerLabel }: { items: DerivedItem[]; centerLabel: string }) {
  // r chosen so circumference ≈ 100, letting dash lengths map directly to %.
  const r = 15.915;
  let offset = 25; // start at 12 o'clock
  return (
    <svg viewBox="0 0 36 36" className="h-24 w-24 shrink-0" role="img" aria-label="Composition">
      <circle cx="18" cy="18" r={r} fill="none" className="stroke-muted" strokeWidth="3.5" />
      {items.map((item, i) => {
        const pct = item.share * 100;
        const dashoffset = offset;
        offset -= pct;
        if (pct <= 0) return null;
        return (
          <circle
            key={i}
            cx="18"
            cy="18"
            r={r}
            fill="none"
            stroke={item.color}
            strokeWidth="3.5"
            strokeDasharray={`${pct} ${100 - pct}`}
            strokeDashoffset={dashoffset}
          />
        );
      })}
      <text
        x="18"
        y="18"
        textAnchor="middle"
        dominantBaseline="central"
        className="fill-foreground text-[4px] font-semibold"
      >
        {centerLabel}
      </text>
    </svg>
  );
}

export function BreakdownChart({
  data,
  rawTable,
  copyValue,
}: {
  data: BreakdownData;
  rawTable: ReactNode;
  copyValue: string;
}) {
  const [showTable, setShowTable] = useState(false);

  const sumDuration = data.items.reduce((acc, i) => acc + (i.durationMs ?? 0), 0);
  const sumPercent = data.items.reduce((acc, i) => acc + (i.percent ?? 0), 0);
  const maxMagnitude = Math.max(
    ...data.items.map((i) => (data.hasDuration ? (i.durationMs ?? 0) : (i.percent ?? 0))),
    0,
  );

  const derived: DerivedItem[] = data.items.map((item, i) => {
    const share = data.hasPercent
      ? sumPercent > 0
        ? (item.percent ?? 0) / sumPercent
        : 0
      : sumDuration > 0
        ? (item.durationMs ?? 0) / sumDuration
        : 0;
    const magnitude = data.hasDuration ? (item.durationMs ?? 0) : (item.percent ?? 0);
    const barFraction = maxMagnitude > 0 ? magnitude / maxMagnitude : 0;

    const parts: string[] = [];
    if (data.hasDuration && item.durationMs !== null) {
      parts.push(item.durationText || formatDuration(item.durationMs));
    }
    if (item.percentText) parts.push(item.percentText);
    else if (!data.hasPercent && share > 0) parts.push(`${Math.round(share * 100)}%`);

    return {
      ...item,
      color: PALETTE[i % PALETTE.length],
      share,
      barFraction,
      valueLabel: parts.join(" · "),
    };
  });

  const showDonut = derived.length >= 2 && derived.length <= 8 && derived.some((d) => d.share > 0);
  const centerLabel = data.hasDuration ? formatDuration(sumDuration) : "100%";

  return (
    <div className="my-2 rounded-md border border-border/60 bg-muted/10 p-2.5">
      <div className="flex items-start gap-3">
        {showDonut && <DonutChart items={derived} centerLabel={centerLabel} />}
        <div className="min-w-0 flex-1 space-y-2">
          {derived.map((item, i) => (
            <div key={i} className="min-w-0">
              <div className="flex items-baseline justify-between gap-2">
                <span className="flex min-w-0 items-center gap-1.5">
                  <span
                    className="h-2 w-2 shrink-0 rounded-[2px]"
                    style={{ backgroundColor: item.color }}
                  />
                  <span className="truncate font-medium" title={item.label}>
                    {item.label}
                  </span>
                </span>
                <span className="shrink-0 tabular-nums text-muted-foreground">
                  {item.valueLabel}
                </span>
              </div>
              <div className="mt-0.5 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full"
                  style={{
                    width: `${Math.max(item.barFraction * 100, item.barFraction > 0 ? 2 : 0)}%`,
                    backgroundColor: item.color,
                  }}
                />
              </div>
              {item.extras.length > 0 && (
                <div className="mt-0.5 text-[10px] leading-snug text-muted-foreground/80">
                  {item.extras.map((e, j) => (
                    <span key={j}>
                      {j > 0 && " · "}
                      <span className="text-muted-foreground/60">{e.header}:</span> {e.value}
                    </span>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      <div className="mt-2 flex items-center justify-between border-t border-border/40 pt-1.5">
        <button
          type="button"
          onClick={() => setShowTable((v) => !v)}
          className="flex items-center gap-1 text-[10px] text-muted-foreground/70 hover:text-muted-foreground"
        >
          <ChevronRight
            className={`h-3 w-3 transition-transform ${showTable ? "rotate-90" : ""}`}
          />
          {showTable ? "Hide table" : "Show table"}
        </button>
        <CopyButton value={copyValue} className="h-6 w-6" iconClassName="h-3 w-3" />
      </div>

      {showTable && <div className="mt-1">{rawTable}</div>}
    </div>
  );
}
