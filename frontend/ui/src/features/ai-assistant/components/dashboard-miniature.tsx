"use client";

import { COLS, ROW_HEIGHT } from "@/features/dashboards/grid-constants";
import type { MiniatureGlyph, MiniatureTile } from "../lib/resource-card";

/**
 * The dashboard a transcript built, shrunk into its card: the real grid's
 * twelve columns, tiles at the proportions the placement function assigned,
 * each named — and every tile a static glyph, never a query. The geometry
 * comes from the dashboard grid's own constants so the miniature and the real
 * grid cannot disagree; only the scale differs.
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

/** Chart-shaped glyphs share one wide viewBox and stretch to fill the tile. */
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

export function DashboardMiniature({ tiles }: { tiles: readonly MiniatureTile[] }) {
  // The caller keeps the header-only card for an empty dashboard; this guard
  // just keeps a frame with no tiles from ever rendering.
  if (tiles.length === 0) return null;
  return (
    <div
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
          <TileGlyph glyph={tile.glyph} />
        </div>
      ))}
    </div>
  );
}
