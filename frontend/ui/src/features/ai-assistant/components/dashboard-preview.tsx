"use client";

import dynamic from "next/dynamic";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { COLS, ROW_HEIGHT } from "@/features/dashboards/grid-constants";
import { makeRange, resolveSiteRange } from "@/features/dashboards/range-presets";
import type { Widget } from "@/features/dashboards/types";
import type { PreviewTile } from "../lib/resource-card";
import { REFERENCE_COL_WIDTH, SNAPSHOT_QUERY_OPTIONS } from "./preview-constants";

/**
 * The dashboard a transcript built, as it is: the real grid's geometry laid
 * out at a reference width, each tile drawn by the dashboard's own tile body
 * — the same query hook, renderer and feed a dashboard tile uses, so the
 * card shows what the dashboard actually looks like rather than a second
 * rendering that drifts from it — and the whole thing scaled down to the
 * card's width. Only the frame, the scale and the visibility gate belong to
 * the panel.
 *
 * Cost discipline, shared with the widget card's chart preview: nothing
 * queries until one IntersectionObserver on the whole preview reports it
 * visible, every tile then shares one window frozen at that moment, and
 * react-query dedupes by widget id — the dashboard's own tile for the same
 * widget reuses the cached result.
 */

// Loaded dynamically because the tile body pulls in the dashboards renderers
// — and with them recharts — while this preview's frame renders in the
// assistant panel, which every page's layout mounts. The frame and its
// geometry stay in the shared chunk, so the card reserves its exact height
// at once; the heavy body arrives in its own chunk, fetched only once a
// dashboard card has actually been seen.
const WidgetBody = dynamic(
  () => import("@/features/dashboards/components/WidgetCard").then((mod) => mod.WidgetBody),
  { ssr: false },
);

// react-grid-layout's defaults, which the dashboard grid leaves in place: ten
// pixels between tiles, and the same ten around the grid (its container
// padding falls back to the margin). Each formula below is the library's own
// item and container arithmetic; at the reference width every value is a
// whole pixel, so its rounding never bites.
const MARGIN = 10;

/** The container width at which the grid's columns come out at the reference width. */
export const REFERENCE_WIDTH = COLS * REFERENCE_COL_WIDTH + (COLS - 1) * MARGIN + 2 * MARGIN;

/** A tile's box in the reference grid, in pixels. */
export function tileFrame({ x, y, w, h }: Pick<PreviewTile, "x" | "y" | "w" | "h">) {
  return {
    left: x * (REFERENCE_COL_WIDTH + MARGIN) + MARGIN,
    top: y * (ROW_HEIGHT + MARGIN) + MARGIN,
    width: w * REFERENCE_COL_WIDTH + (w - 1) * MARGIN,
    height: h * ROW_HEIGHT + (h - 1) * MARGIN,
  };
}

/** The reference grid's height: its lowest tile's bottom edge plus padding. */
export function gridHeight(tiles: readonly Pick<PreviewTile, "y" | "h">[]): number {
  const rows = Math.max(0, ...tiles.map((tile) => tile.y + tile.h));
  return rows * ROW_HEIGHT + (rows - 1) * MARGIN + 2 * MARGIN;
}

/** The tile as the dashboard's body takes it; the body needs no dashboard id. */
function tileWidget(tile: PreviewTile): Widget {
  return {
    id: tile.id,
    dashboardId: "",
    title: tile.title,
    type: tile.widget.type,
    spec: tile.widget.spec,
    displayConfig: {},
  };
}

export function DashboardPreview({ tiles }: { tiles: readonly PreviewTile[] }) {
  const frameRef = useRef<HTMLDivElement>(null);
  const [seen, setSeen] = useState(false);
  const [width, setWidth] = useState(0);

  // Every tile's query is a real scan, and cards pile up in a transcript the
  // user scrolls past — so nothing queries until the preview has actually
  // been on screen. One observer for the whole grid: the tiles live or die
  // together, so per-tile observers would be twelve ways to learn one fact.
  // Without an IntersectionObserver nothing is ever known to be visible, and
  // the empty tiles stand rather than querying for every card blind.
  useEffect(() => {
    const frame = frameRef.current;
    if (seen || frame === null || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) setSeen(true);
    });
    observer.observe(frame);
    return () => observer.disconnect();
  }, [seen]);

  // The scale is the frame's width over the reference grid's, measured before
  // paint so the grid never shows unscaled, and re-measured as the panel
  // resizes. Without a ResizeObserver the mount measurement stands.
  useLayoutEffect(() => {
    const frame = frameRef.current;
    if (frame === null) return;
    const measure = () => setWidth(frame.clientWidth);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(frame);
    return () => observer.disconnect();
  }, []);

  // The shared window, frozen at first visibility: a receipt for a past
  // action should not quietly slide its own axis while the transcript stays
  // open — and one range means react-query can serve every tile's remount
  // from cache. (`seen` only ever flips once, so this computes once.) Which
  // window gets frozen is the site's own stored selection for the tiles'
  // project (they all landed in one dashboard, so the first names it),
  // falling back to the default when nothing usable is stored. `tiles` is
  // deliberately not a dependency: it is read only on the one seen=false→true
  // computation, and a later tiles identity change must not thaw the range.
  const range = useMemo(() => {
    if (!seen) return null;
    return makeRange(resolveSiteRange(tiles[0]?.projectId).id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seen]);

  // The caller renders no preview for a tile-less dashboard (none created,
  // or reused with unknowable placements); this guard just keeps a frame with
  // no tiles from ever rendering.
  if (tiles.length === 0) return null;
  const height = gridHeight(tiles);
  return (
    // The frame's height is a ratio of its width — exactly the scaled grid's
    // height, and known before any measurement, so the transcript never
    // jumps as previews mount. The grid sits out of flow so its unscaled box
    // cannot stretch the frame.
    <div
      ref={frameRef}
      className="relative min-w-0 overflow-hidden"
      style={{ aspectRatio: `${REFERENCE_WIDTH} / ${height}` }}
    >
      <div
        aria-hidden="true"
        className="pointer-events-none absolute left-0 top-0"
        style={{
          width: REFERENCE_WIDTH,
          height,
          transform: `scale(${width / REFERENCE_WIDTH})`,
          transformOrigin: "top left",
        }}
      >
        {tiles.map((tile) => (
          // The dashboard tile's own chrome, minus its drag handle and menu:
          // a picture of the dashboard, not a second set of controls.
          <div
            key={tile.id}
            data-preview-tile
            className="absolute flex flex-col rounded-md border bg-background p-3"
            style={tileFrame(tile)}
          >
            <div className="mb-2 flex items-center gap-1.5">
              <span className="flex-1 truncate text-[12px] font-medium" title={tile.title}>
                {tile.title}
              </span>
            </div>
            <div className="min-h-0 flex-1">
              {range !== null && (
                <WidgetBody
                  projectId={tile.projectId}
                  widget={tileWidget(tile)}
                  range={range}
                  queryOptions={SNAPSHOT_QUERY_OPTIONS}
                />
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
