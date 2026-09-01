"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { COLS, ROW_HEIGHT } from "@/features/dashboards/grid-constants";
import { useWidgetData } from "@/features/dashboards/hooks/use-widget-data";
import { DEFAULT_RANGE_ID, makeRange } from "@/features/dashboards/range-presets";
import type { TimeRange, WidgetQueryResult } from "@/features/dashboards/types";
import { DEFAULT_SIZE } from "@/features/dashboards/widget-placement";
import { FIELD_UNIT, type FieldUnit } from "@/features/filters/filter-controls";
import type { MiniatureGlyph, MiniatureTile, WidgetChart } from "../lib/resource-card";

/**
 * The dashboard a transcript built, shrunk into its card: the real grid's
 * twelve columns, tiles at the proportions the placement function assigned,
 * each named — and each tile drawing its widget's real data once the
 * miniature has actually been on screen. The static glyphs remain as the
 * loading and failure faces (a grey shape that looks like a skeleton IS the
 * skeleton), and a trace feed keeps its list-rows glyph outright: there is no
 * cheap single query for a feed.
 *
 * Cost discipline, inherited from the widget card's chart preview: nothing
 * queries until one IntersectionObserver on the whole miniature reports it
 * visible, every tile then shares one window frozen at that moment, and
 * react-query dedupes by widget id — the dashboard's own tile for the same
 * widget reuses the cached result.
 *
 * The tiles draw their data with the inline SVG minis below rather than the
 * dashboard's QueryWidgetRenderer: at tile size (~100–220px wide, ~45–90px of
 * chart area) the renderer's fixed chrome — a 42–58px y-axis gutter, an
 * x-axis tick row, tooltips, legends — swallows most of the tile, and
 * importing it would drag recharts into the shared layout chunk this file
 * lives in (the assistant panel mounts on every page). The geometry comes
 * from the dashboard grid's own constants so the miniature and the real grid
 * cannot disagree; only the scale differs.
 */

/**
 * The one number the real grid does not fix: its column width, which the app
 * measures from the container at render time. The miniature scales a
 * representative rendering instead — an 88px column (a 1056px grid), which
 * against the real 56px row height keeps a 6x4 chart tile at ~2.35:1, the
 * shape the dashboard itself draws. Everything else derives from the grid's
 * constants.
 */
export const REFERENCE_COL_WIDTH = 88;

/**
 * The shape of one freshly placed chart tile at the reference proportions —
 * the frame the widget card's chart preview draws in, so the preview reads as
 * a dashboard tile that happens to live in the chat. Derived from the same
 * constants as the miniature, never hardcoded, so a grid change moves both.
 * Shared from here (not the preview module) because the preview loads through
 * next/dynamic and importing it statically would drag recharts along.
 */
export const CHART_TILE_ASPECT = `${DEFAULT_SIZE.query.w * REFERENCE_COL_WIDTH} / ${DEFAULT_SIZE.query.h * ROW_HEIGHT}`;

/**
 * A card's query is a snapshot, not a live dashboard: its window is frozen at
 * first visibility, so the fetched result never goes stale — and it must not
 * refetch on its own. Every ever-visible card in a transcript keeps a mounted
 * query, so a single tab focus (or reconnect) would otherwise refire the
 * whole accumulated transcript against ClickHouse at once. Shared by every
 * card data query — the miniature's tiles and the widget card's preview.
 */
export const SNAPSHOT_QUERY_OPTIONS = {
  staleTime: Infinity,
  refetchOnWindowFocus: false,
  refetchOnReconnect: false,
} as const;

/**
 * The frame: a css grid with the dashboard's column count, one track per grid
 * row, and an aspect ratio fixing every cell to the reference proportions —
 * so the whole miniature scales with the card while its tiles keep their
 * true shapes.
 */
export function frameStyle(tiles: readonly MiniatureTile[]): React.CSSProperties {
  const rows = Math.max(1, ...tiles.map((tile) => tile.y + tile.h));
  return {
    gridTemplateColumns: `repeat(${COLS}, minmax(0, 1fr))`,
    gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))`,
    aspectRatio: `${COLS * REFERENCE_COL_WIDTH} / ${rows * ROW_HEIGHT}`,
  };
}

/** A tile's placement, translated from grid units to css grid lines. */
export function tileStyle(tile: MiniatureTile): React.CSSProperties {
  return {
    gridColumn: `${tile.x + 1} / span ${tile.w}`,
    gridRow: `${tile.y + 1} / span ${tile.h}`,
  };
}

/** Chart-shaped drawings share one wide viewBox and stretch to fill the tile. */
function StretchGlyph({ children }: { children: React.ReactNode }) {
  return (
    <svg
      viewBox="0 0 96 40"
      preserveAspectRatio="none"
      aria-hidden="true"
      className="min-h-0 w-full flex-1"
    >
      {children}
    </svg>
  );
}

const LINE_POINTS = "0,32 12,26 24,29 36,16 48,21 60,10 72,15 84,6 96,9";
const BAR_HEIGHTS = [14, 22, 10, 28, 18, 24];
const HISTOGRAM_HEIGHTS = [6, 14, 26, 34, 28, 16, 8];

function ChartGlyph({ glyph }: { glyph: Exclude<MiniatureGlyph, "trace_feed" | "unknown"> }) {
  switch (glyph) {
    case "line":
      return (
        <StretchGlyph>
          <polyline
            points={LINE_POINTS}
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            opacity="0.6"
          />
        </StretchGlyph>
      );
    case "area":
      return (
        <StretchGlyph>
          <polygon points={`0,40 ${LINE_POINTS} 96,40`} fill="currentColor" opacity="0.15" />
          <polyline
            points={LINE_POINTS}
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            opacity="0.6"
          />
        </StretchGlyph>
      );
    case "bar":
      return (
        <StretchGlyph>
          {BAR_HEIGHTS.map((height, index) => (
            <rect
              key={index}
              x={index * 16 + 3}
              y={40 - height}
              width="10"
              height={height}
              fill="currentColor"
              opacity="0.45"
            />
          ))}
        </StretchGlyph>
      );
    case "histogram":
      return (
        <StretchGlyph>
          {HISTOGRAM_HEIGHTS.map((height, index) => (
            <rect
              key={index}
              x={index * 13.7}
              y={40 - height}
              width="12.7"
              height={height}
              fill="currentColor"
              opacity="0.45"
            />
          ))}
        </StretchGlyph>
      );
    case "table":
      return (
        <StretchGlyph>
          <rect x="0" y="2" width="96" height="7" fill="currentColor" opacity="0.25" />
          {[14, 23, 32].map((y) => (
            <rect key={y} x="0" y={y} width="96" height="4" fill="currentColor" opacity="0.12" />
          ))}
        </StretchGlyph>
      );
    case "number":
      // A stat tile shows one large value; a centered block stands in for it.
      return (
        <StretchGlyph>
          <rect x="28" y="13" width="40" height="14" rx="3" fill="currentColor" opacity="0.35" />
        </StretchGlyph>
      );
    case "pie":
      // The one glyph that must not stretch: an ellipse reads as a mistake.
      return (
        <svg
          viewBox="0 0 40 40"
          preserveAspectRatio="xMidYMid meet"
          aria-hidden="true"
          className="min-h-0 w-full flex-1"
        >
          <circle cx="20" cy="20" r="14" fill="currentColor" opacity="0.15" />
          <path d="M20,20 L20,6 A14,14 0 0 1 33.5,23.5 Z" fill="currentColor" opacity="0.45" />
        </svg>
      );
  }
}

/** A trace feed is a list, so its glyph is rows of diminishing width. */
function FeedGlyph() {
  return (
    <div aria-hidden="true" className="flex min-h-0 flex-1 flex-col justify-evenly">
      {[100, 82, 64, 90, 72].map((width, index) => (
        <i
          key={index}
          data-feed-row
          className="block h-0.5 rounded-full bg-current opacity-30"
          style={{ width: `${width}%` }}
        />
      ))}
    </div>
  );
}

function TileGlyph({ glyph }: { glyph: MiniatureGlyph }) {
  // Unknown display: a neutral tile — the title alone, no shape to fake.
  if (glyph === "unknown") return <div className="min-h-0 flex-1" />;
  if (glyph === "trace_feed") return <FeedGlyph />;
  return <ChartGlyph glyph={glyph} />;
}

// ---------------------------------------------------------------------------
// Live minis: the widget's fetched result drawn at tile scale. Deliberately
// monochrome and chrome-free — real proportions in the glyphs' own visual
// language, so a data-rich tile reads as data without pretending a 150px tile
// can carry axes and legends.

/** SVG coordinates rounded to a tenth: precise enough, stable to assert on. */
const round1 = (v: number) => Math.round(v * 10) / 10;

/** ClickHouse returns Decimal columns as strings; read either as a number. */
function num(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return null;
}

/**
 * Compact value formatting for the number and table minis. Mirrors the stat
 * tile's compaction rules (large magnitudes shorten, tiny non-zero costs keep
 * significant digits) — a local copy because the renderer module that owns
 * them imports recharts, which must stay out of this file's shared chunk.
 */
function fmtMiniValue(value: unknown): string | null {
  const n = num(value);
  if (n === null) return null;
  const abs = Math.abs(n);
  if (abs >= 100_000) {
    return Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(n);
  }
  if (abs > 0 && abs < 0.001) {
    return Intl.NumberFormat("en", { maximumSignificantDigits: 2 }).format(n);
  }
  return Intl.NumberFormat("en", { maximumFractionDigits: 4 }).format(n);
}

// Drawing bounds inside the shared 96x40 viewBox: full values reach y=2,
// zero sits on the y=40 baseline.
const MINI_TOP = 2;
const MINI_BASE = 40;
const MINI_SPAN = MINI_BASE - MINI_TOP;
// Caps keeping a mini's element count bounded whatever the query returns.
const MAX_MINI_SERIES = 6;
const MAX_MINI_BARS = 16;
const MAX_MINI_SLICES = 12;
const MAX_MINI_ROWS = 4;

/**
 * Time-series results pivoted to per-series value arrays aligned on bucket
 * order — the same shapes the dashboard renderer pivots ([bucket, value] and
 * [bucket, dim, value]), reduced to what a sparkline needs. WITH FILL gap
 * rows register their bucket but form no series; a non-additive agg's empty
 * buckets stay null and render as gaps bridged by the line.
 */
function miniSeries(result: WidgetQueryResult): (number | null)[][] {
  const { columns, rows } = result;
  if (columns[0] !== "bucket") return [];
  const valueIdx = columns.length - 1;
  if (columns.length === 2) return [rows.map((r) => num(r[valueIdx]))];
  if (columns.length !== 3) return [];

  const bucketIdx = new Map<string, number>();
  for (const r of rows) {
    const bucket = String(r[0]);
    if (!bucketIdx.has(bucket)) bucketIdx.set(bucket, bucketIdx.size);
  }
  const series = new Map<string, (number | null)[]>();
  for (const r of rows) {
    const rawDim = r[1];
    // A WITH FILL gap row (empty dimension, empty value) extends the x-axis
    // domain but is not a series.
    if ((rawDim === "" || rawDim == null) && !Number(r[valueIdx])) continue;
    const dim = String(rawDim ?? "null");
    let values = series.get(dim);
    if (values === undefined) {
      if (series.size >= MAX_MINI_SERIES) continue;
      values = Array.from(bucketIdx, () => null);
      series.set(dim, values);
    }
    values[bucketIdx.get(String(r[0]))!] = num(r[valueIdx]);
  }
  return [...series.values()];
}

/** y for a value scaled against the window's max; all-zero windows sit flat. */
const miniY = (value: number, max: number) =>
  max <= 0
    ? MINI_BASE
    : round1(Math.min(MINI_BASE, Math.max(MINI_TOP, MINI_BASE - (value / max) * MINI_SPAN)));

function SeriesMini({ result, area }: { result: WidgetQueryResult; area: boolean }) {
  const series = miniSeries(result);
  const max = Math.max(0, ...series.flat().filter((v): v is number => v !== null));
  const lines = series
    .map((values) => {
      const points = values.flatMap((v, i) =>
        v === null
          ? []
          : [[round1(values.length === 1 ? 48 : (i / (values.length - 1)) * 96), miniY(v, max)]],
      );
      // One lone bucket: a point is invisible, so draw its value flat across.
      if (points.length === 1)
        return [
          [0, points[0][1]],
          [96, points[0][1]],
        ] as number[][];
      return points;
    })
    .filter((points) => points.length > 1);
  // Every row a gap row, or nothing numeric: an empty window, said quietly.
  if (lines.length === 0) return <EmptyMini />;
  return (
    <StretchGlyph>
      {lines.map((points, index) => {
        const path = points.map(([x, y]) => `${x},${y}`).join(" ");
        const opacity = Math.max(0.25, 0.75 - index * 0.1);
        return (
          <g key={index}>
            {area && (
              <polygon
                points={`${points[0][0]},${MINI_BASE} ${path} ${points[points.length - 1][0]},${MINI_BASE}`}
                fill="currentColor"
                opacity={round1(opacity * 0.25)}
              />
            )}
            <polyline
              points={path}
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              opacity={opacity}
            />
          </g>
        );
      })}
    </StretchGlyph>
  );
}

/** Bar and histogram minis: one rect per category/bin from the value column. */
function BarsMini({ result }: { result: WidgetQueryResult }) {
  const valueIdx = result.columns.length - 1;
  const values = result.rows.slice(0, MAX_MINI_BARS).map((r) => num(r[valueIdx]) ?? 0);
  const max = Math.max(0, ...values);
  const step = 96 / values.length;
  return (
    <StretchGlyph>
      {values.map((value, index) => {
        // A nonzero value stays visible however small; zero draws nothing.
        const height = value > 0 && max > 0 ? Math.max(1, round1((value / max) * MINI_SPAN)) : 0;
        return (
          <rect
            key={index}
            x={round1(index * step + step * 0.15)}
            y={MINI_BASE - height}
            width={round1(step * 0.7)}
            height={height}
            fill="currentColor"
            opacity="0.55"
          />
        );
      })}
    </StretchGlyph>
  );
}

function PieMini({ result }: { result: WidgetQueryResult }) {
  const valueIdx = result.columns.length - 1;
  const values = result.rows
    .slice(0, MAX_MINI_SLICES)
    .map((r) => num(r[valueIdx]) ?? 0)
    .filter((v) => v > 0);
  const total = values.reduce((a, b) => a + b, 0);
  if (total <= 0) return <EmptyMini />;

  const point = (angle: number) =>
    `${round1(20 + 14 * Math.cos(angle))},${round1(20 + 14 * Math.sin(angle))}`;
  let angle = -Math.PI / 2; // start at twelve o'clock, like the real pie
  return (
    <svg
      viewBox="0 0 40 40"
      preserveAspectRatio="xMidYMid meet"
      aria-hidden="true"
      className="min-h-0 w-full flex-1"
    >
      {values.length === 1 ? (
        // A single slice is the whole circle; a 360° arc path degenerates.
        <circle cx="20" cy="20" r="14" fill="currentColor" opacity="0.55" />
      ) : (
        values.map((value, index) => {
          const from = angle;
          angle += (value / total) * 2 * Math.PI;
          const large = angle - from > Math.PI ? 1 : 0;
          return (
            <path
              key={index}
              d={`M20,20 L${point(from)} A14,14 0 ${large} 1 ${point(angle)} Z`}
              fill="currentColor"
              opacity={Math.max(0.15, round1(0.7 - index * 0.08))}
            />
          );
        })
      )}
    </svg>
  );
}

function TableMini({ result, unit }: { result: WidgetQueryResult; unit?: FieldUnit }) {
  const valueIdx = result.columns.length - 1;
  return (
    <div className="flex min-h-0 flex-1 flex-col justify-start gap-px overflow-hidden text-[8px] leading-tight">
      {result.rows.slice(0, MAX_MINI_ROWS).map((row, index) => (
        <div key={index} className="flex items-baseline justify-between gap-1">
          <span className="min-w-0 truncate opacity-70">
            {valueIdx === 0 ? "" : String(row[0] ?? "—")}
          </span>
          <span className="shrink-0 tabular-nums">
            {unit?.prefix}
            {fmtMiniValue(row[valueIdx]) ?? "—"}
          </span>
        </div>
      ))}
    </div>
  );
}

function NumberMini({ result, unit }: { result: WidgetQueryResult; unit?: FieldUnit }) {
  const text = fmtMiniValue(result.rows[0]?.[result.columns.length - 1]);
  if (text === null) return <EmptyMini />;
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden">
      <span className="truncate text-[13px] font-semibold tabular-nums text-foreground">
        {unit?.prefix}
        {text}
        {unit?.suffix && (
          <span className="text-[9px] font-normal text-muted-foreground"> {unit.suffix}</span>
        )}
      </span>
    </div>
  );
}

/** An empty window: a quiet dash, never a message a 100px tile can't afford. */
function EmptyMini() {
  return (
    <div
      data-mini-empty
      title="No data in range"
      className="flex min-h-0 flex-1 items-center justify-center text-[10px] text-muted-foreground/70"
    >
      —
    </div>
  );
}

function MiniData({ chart, result }: { chart: WidgetChart; result: WidgetQueryResult }) {
  const unit = FIELD_UNIT[chart.spec.metric.measure];
  switch (chart.spec.display.type) {
    case "line":
      return <SeriesMini result={result} area={false} />;
    case "area":
      return <SeriesMini result={result} area />;
    case "bar":
    case "histogram":
      return <BarsMini result={result} />;
    case "pie":
      return <PieMini result={result} />;
    case "number":
      return <NumberMini result={result} unit={unit} />;
    case "table":
      return <TableMini result={result} unit={unit} />;
  }
}

/**
 * One live tile: the widget's own query hook (keyed by widget id, so the
 * dashboard page's tile for this widget shares the cached result), and the
 * per-state faces — loading keeps the glyph (it finally gets to be what it
 * looks like), an error keeps the glyph too (a 100px tile has no room to
 * explain), an empty window says "—", and data draws the mini.
 */
function LiveTileBody({
  tile,
  chart,
  range,
}: {
  tile: MiniatureTile;
  chart: WidgetChart;
  range: TimeRange;
}) {
  const { data, isPending, error } = useWidgetData(
    chart.projectId,
    tile.id,
    chart.spec,
    range,
    true,
    SNAPSHOT_QUERY_OPTIONS,
  );
  if (isPending || error !== null || data === undefined) return <TileGlyph glyph={tile.glyph} />;
  if (data.rows.length === 0) return <EmptyMini />;
  return (
    <div data-live-mini className="flex min-h-0 min-w-0 flex-1 flex-col">
      <MiniData chart={chart} result={data} />
    </div>
  );
}

export function DashboardMiniature({ tiles }: { tiles: readonly MiniatureTile[] }) {
  const frameRef = useRef<HTMLDivElement>(null);
  const [seen, setSeen] = useState(false);

  // Every tile's query is a real scan, and cards pile up in a transcript the
  // user scrolls past — so nothing queries until the miniature has actually
  // been on screen. One observer for the whole grid: the tiles live or die
  // together, so per-tile observers would be twelve ways to learn one fact.
  // Without an IntersectionObserver nothing is ever known to be visible, and
  // the glyphs stand rather than querying for every card blind.
  useEffect(() => {
    const frame = frameRef.current;
    if (seen || frame === null || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) setSeen(true);
    });
    observer.observe(frame);
    return () => observer.disconnect();
  }, [seen]);

  // The shared window, frozen at first visibility: a receipt for a past
  // action should not quietly slide its own axis while the transcript stays
  // open — and one range means react-query can serve every tile's remount
  // from cache. (`seen` only ever flips once, so this computes once.)
  const range = useMemo(() => (seen ? makeRange(DEFAULT_RANGE_ID) : null), [seen]);

  // The caller keeps the header-only card for an empty dashboard; this guard
  // just keeps a frame with no tiles from ever rendering.
  if (tiles.length === 0) return null;
  return (
    <div
      ref={frameRef}
      className="grid max-w-full gap-1 overflow-hidden rounded-md border border-border/60 bg-background p-1"
      style={frameStyle(tiles)}
    >
      {tiles.map((tile) => (
        <div
          key={tile.id}
          data-glyph={tile.glyph}
          className="flex min-w-0 flex-col gap-0.5 overflow-hidden rounded-sm border border-border/80 bg-card px-1.5 py-1 text-muted-foreground"
          style={tileStyle(tile)}
        >
          <span className="truncate text-[10px] font-medium leading-tight text-foreground">
            {tile.title}
          </span>
          {range !== null && tile.chart !== null ? (
            <LiveTileBody tile={tile} chart={tile.chart} range={range} />
          ) : (
            <TileGlyph glyph={tile.glyph} />
          )}
        </div>
      ))}
    </div>
  );
}
