// Auto-placement for newly created widgets. A widget with no entry in the
// dashboard's stored layout falls back to the grid's client-side placement,
// which stacks every such widget four columns wide down the left edge and is
// never persisted — so a dashboard built through the write API renders as a
// narrow column forever. Creating a widget therefore also writes it a real
// placement.

import { COLS } from "./grid-constants";
import type { WidgetType } from "./types";

export type WidgetPlacement = { i: string; x: number; y: number; w: number; h: number };

// On the grid's twelve columns, tiles are half-width: two per row.
const SLOT_W = COLS / 2;
const SLOT_X = [0, SLOT_W];

// Starting tile sizes in grid units, following the seeded dashboard's
// proportions — a feed needs more rows than a chart to show a useful list.
// Keyed by WidgetType: a new widget kind doesn't compile until it has a size
// here, rather than crashing on the first create.
const DEFAULT_SIZE: Record<WidgetType, { w: number; h: number }> = {
  query: { w: SLOT_W, h: 4 },
  trace_feed: { w: SLOT_W, h: 6 },
};

// Entries are stored as JSON and only the placement keys are meaningful; the
// same shape the dashboard PATCH route accepts.
function asPlacement(value: unknown): WidgetPlacement | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const entry = value as Record<string, unknown>;
  if (typeof entry.i !== "string") return null;
  const coords = (["x", "y", "w", "h"] as const).map((k) => entry[k]);
  if (!coords.every((n) => typeof n === "number" && Number.isFinite(n) && n >= 0)) return null;
  const [x, y, w, h] = coords as number[];
  return { i: entry.i, x, y, w, h };
}

const overlaps = (a: WidgetPlacement, b: WidgetPlacement) =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/**
 * Append a placement for a newly created widget to a dashboard layout.
 *
 * Bottom-append with left/right slotting: the widget takes a free half of the
 * lowest row that has one, otherwise it starts a new row under everything.
 * Deliberately no hole-filling — the result has to be predictable to the
 * person who then drags the tiles where they want them.
 *
 * Args:
 *   layout: The dashboard's stored layout, as read from the JSON column.
 *   widget: Id and type of the widget being placed.
 *
 * Returns:
 *   The layout to store, or null if the widget already has a placement.
 *   Entries that aren't renderable placements are dropped: the layout is
 *   being rewritten anyway, and one malformed entry breaks the whole grid.
 */
export function appendWidgetPlacement(
  layout: unknown,
  widget: { id: string; type: WidgetType },
): WidgetPlacement[] | null {
  const entries = (Array.isArray(layout) ? layout : [])
    .map(asPlacement)
    .filter((entry): entry is WidgetPlacement => entry !== null);
  if (entries.some((entry) => entry.i === widget.id)) return null;

  const { w, h } = DEFAULT_SIZE[widget.type];
  // Entries for widgets that no longer exist still count here — harmless, and
  // it keeps the placement a pure function of the stored layout.
  const lowestRowY = Math.max(0, ...entries.map((entry) => entry.y));
  const bottom = Math.max(0, ...entries.map((entry) => entry.y + entry.h));
  const slot = SLOT_X.map((x) => ({ i: widget.id, x, y: lowestRowY, w, h })).find(
    (candidate) => !entries.some((entry) => overlaps(candidate, entry)),
  );
  return [...entries, slot ?? { i: widget.id, x: 0, y: bottom, w, h }];
}
