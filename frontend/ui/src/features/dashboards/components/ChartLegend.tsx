"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

export interface LegendEntry {
  /** Series key, as the chart knows it (dataKey / category name). */
  key: string;
  label: string;
  /** The chart's color for this series — bound to its pivot index, not the
   * legend's sorted position. */
  color: string;
  value: number | null;
}

// The tile shows this many rows; the rest live behind "N more".
const VISIBLE_ROWS = 3;

/**
 * Per-series legend under a chart: swatch · label · right-aligned value,
 * sorted by value, with a Total row for additive measures. The tile shows the
 * top rows; "N more" opens the full list in a popover anchored to that button
 * (portaled out of the widget card, so it neither covers the chart nor shrinks
 * the tile, and flips above near the viewport edge). Hovering a row highlights
 * its series via onHoverKey.
 */
export function ChartLegend({
  entries,
  total,
  format,
  hoveredKey,
  onHoverKey,
}: {
  entries: LegendEntry[];
  /** Window total across series; null for non-additive measures (no honest total). */
  total: number | null;
  format: (v: number | null) => string;
  hoveredKey: string | null;
  onHoverKey: (key: string | null) => void;
}) {
  const [open, setOpen] = useState(false);

  // Closing can unmount a hovered row without its mouseleave firing — clear
  // the hover with it, or the chart stays dimmed.
  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) onHoverKey(null);
  };

  const sorted = [...entries].sort((a, b) => (b.value ?? -Infinity) - (a.value ?? -Infinity));
  const shown = sorted.slice(0, VISIBLE_ROWS);
  const hiddenCount = sorted.length - shown.length;

  const totalRow =
    total === null ? null : (
      <div role="listitem" className="flex w-full items-center gap-2 rounded px-1 py-0.5">
        <div className="h-2.5 w-2.5 shrink-0" />
        <div className="flex min-w-0 flex-1 items-center justify-between gap-x-3 leading-tight">
          <span className="truncate text-muted-foreground">Total</span>
          <span className="shrink-0 whitespace-nowrap font-mono font-medium tabular-nums text-foreground">
            {format(total)}
          </span>
        </div>
      </div>
    );

  const row = (e: LegendEntry) => (
    <div
      key={e.key}
      role="listitem"
      onMouseEnter={() => onHoverKey(e.key)}
      onMouseLeave={() => onHoverKey(null)}
      className={cn(
        "flex w-full items-center gap-2 rounded px-1 py-0.5",
        hoveredKey === e.key && "bg-muted/50",
      )}
    >
      <div className="h-2.5 w-2.5 shrink-0 rounded-[2px]" style={{ backgroundColor: e.color }} />
      <div className="flex min-w-0 flex-1 items-center justify-between gap-x-3 leading-tight">
        <span className="truncate text-muted-foreground" title={e.label}>
          {e.label}
        </span>
        <span className="shrink-0 whitespace-nowrap font-mono tabular-nums text-foreground">
          {format(e.value)}
        </span>
      </div>
    </div>
  );

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <div className="shrink-0 pt-1 text-[11px]">
        {/* Tile rows hide from assistive tech while the popover mirrors them. */}
        <div role="list" aria-label="Chart legend" aria-hidden={open || undefined}>
          {totalRow}
          {shown.map(row)}
        </div>
        {/* Keep the trigger mounted while open: a background refresh can
            shrink the list below the cap, and unmounting the trigger would
            strand the portaled popover with no anchor or toggle. */}
        {(hiddenCount > 0 || open) && (
          <PopoverTrigger asChild>
            <button
              type="button"
              className="rounded px-1 py-0.5 text-[10.5px] text-muted-foreground hover:text-foreground"
            >
              {open ? "show less" : `${hiddenCount} more`}
            </button>
          </PopoverTrigger>
        )}
      </div>
      <PopoverContent
        align="start"
        className="max-h-64 w-56 overflow-auto p-1 text-[11px] shadow-xl"
      >
        <div role="list" aria-label="Chart legend (all series)">
          {totalRow}
          {sorted.map(row)}
        </div>
      </PopoverContent>
    </Popover>
  );
}
