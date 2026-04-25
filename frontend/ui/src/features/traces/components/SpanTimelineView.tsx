"use client";

import { useState, useMemo, useRef, useEffect, type RefObject } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { cn, formatDuration, formatTokens } from "@/lib/utils";
import { SpanStatus, SpanKind } from "@traceroot/core";
import { flattenTreeWithMetrics } from "../utils/timeline";
import { TREE_LAYOUT, enrichSpansWithPending } from "../utils";
import type { TraceDetail } from "@/types/api";
import type { TraceSelection } from "../types";

const ROW_HEIGHT = TREE_LAYOUT.ROW_HEIGHT;

// Adaptive ruler: target ≥ 80 px between ticks, snapped to a "nice" interval
const NICE_STEPS_SEC = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600];

function formatTickLabel(sec: number): string {
  if (sec === 0) return "0";
  if (sec >= 3600) return `${Math.round(sec / 3600)}h`;
  if (sec >= 60) return `${Math.round(sec / 60)}m`;
  if (sec >= 1) return `${sec}s`;
  return `${Math.round(sec * 1000)}ms`;
}

type TimelineRow =
  | { type: "trace-root" }
  | { type: "span"; data: ReturnType<typeof flattenTreeWithMetrics>[number] };

interface SpanTimelineViewProps {
  trace: TraceDetail;
  selection: TraceSelection;
  onSelect: (s: TraceSelection) => void;
  collapsedIds: Set<string>;
  scrollRef: RefObject<HTMLDivElement | null>;
  onScroll?: () => void;
  hoveredSpanId: string | null;
  onHoverChange: (id: string | null) => void;
}

/**
 * Gantt-style timeline that shows only the bar chart.
 * The tree hierarchy is rendered separately in SpanTreeView (left panel).
 *
 * Row layout (mirrors SpanTreeView exactly for scroll-sync):
 * Row 0  — trace-root bar (0 → 100 %)
 * Rows 1+ — one bar per visible span, DFS order
 *
 * Clicking any row calls onSelect; TraceViewerPanel switches to tree mode.
 */
export function SpanTimelineView({
  trace,
  selection,
  onSelect,
  collapsedIds,
  scrollRef,
  onScroll,
  hoveredSpanId,
  onHoverChange,
}: SpanTimelineViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [timelineWidth, setTimelineWidth] = useState(800);

  useEffect(() => {
    if (!containerRef.current) return;
    const observer = new ResizeObserver((entries) => {
      setTimelineWidth(Math.max(400, entries[0].contentRect.width));
    });
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);

  const { traceDurationMs } = useMemo(() => {
    const traceStartMs = trace.spans.reduce(
      (min, s) => Math.min(min, new Date(s.span_start_time).getTime()),
      Infinity,
    );
    const durationMs =
      trace.duration_ms ??
      Math.max(
        1,
        trace.spans.reduce((max, s) => {
          const start = new Date(s.span_start_time).getTime();
          return Math.max(max, start - traceStartMs + (s.duration_ms ?? 0));
        }, 0),
      );
    return { traceDurationMs: durationMs };
  }, [trace.spans, trace.duration_ms]);

  const ticks = useMemo(() => {
    const durationSec = traceDurationMs / 1000;
    const maxTicks = Math.max(2, Math.floor(timelineWidth / 80));
    const stepSec = NICE_STEPS_SEC.find((s) => s >= durationSec / maxTicks) ?? 3600;
    const count = Math.ceil(durationSec / stepSec) + 1;
    return Array.from({ length: count }, (_, i) => {
      const sec = i * stepSec;
      if (sec > durationSec * 1.1) return null;
      return { sec, leftPct: (sec / durationSec) * 100, label: formatTickLabel(sec) };
    }).filter((t): t is { sec: number; leftPct: number; label: string } => t !== null);
  }, [traceDurationMs, timelineWidth]);

  const traceAggregates = useMemo(() => {
    const totalTokens = trace.spans.reduce((sum, s) => sum + (s.total_tokens || 0), 0);
    const totalCost = trace.spans.reduce((sum, s) => sum + (s.cost || 0), 0);
    const tokensText = totalTokens > 0 ? `${formatTokens(totalTokens)} tok` : "";
    const costText = totalCost > 0 ? `$${totalCost.toFixed(3)}` : "";
    return { rightLabel: [tokensText, costText].filter(Boolean).join(" · ") };
  }, [trace.spans]);

  const traceIsCollapsed = collapsedIds.has("trace");
  const flattenedItems = useMemo(() => {
    if (traceIsCollapsed) return [];
    // Must enrich here too so row count matches SpanTreeView (pending placeholders add rows)
    const enrichedSpans = enrichSpansWithPending(trace.spans);
    return flattenTreeWithMetrics(enrichedSpans, collapsedIds, traceDurationMs, timelineWidth);
  }, [trace.spans, collapsedIds, traceIsCollapsed, traceDurationMs, timelineWidth]);

  const allRows: TimelineRow[] = useMemo(
    () => [
      { type: "trace-root" },
      ...flattenedItems.map((data) => ({ type: "span" as const, data })),
    ],
    [flattenedItems],
  );

  const rowVirtualizer = useVirtualizer({
    count: allRows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });

  return (
    <div
      ref={containerRef}
      className="flex h-full flex-col overflow-hidden bg-background font-mono text-[11px]"
    >
      {/* TIME RULER — same height as SpanTreeView trace row for scroll alignment */}
      <div
        className="z-20 flex flex-shrink-0 border-b border-border bg-muted/10"
        style={{ height: ROW_HEIGHT }}
      >
        <div className="relative flex-1 overflow-hidden">
          {ticks.map((tick) => {
            // Flip the text to the left side of the line if it's near the right edge
            const isNearEnd = tick.leftPct > 90;

            return (
              <div
                key={tick.sec}
                className="absolute bottom-0 top-0 border-l border-border/40 text-muted-foreground"
                style={{ left: `${tick.leftPct}%` }}
              >
                <span
                  className={cn(
                    "absolute top-1 whitespace-nowrap",
                    isNearEnd ? "right-1" : "left-1",
                  )}
                >
                  {tick.label}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      <div
        ref={scrollRef}
        className="relative flex-1 overflow-auto [&::-webkit-scrollbar]:hidden"
        style={{ scrollbarWidth: "none" }}
        onScroll={onScroll}
      >
        {/* Virtualized rows */}
        <div
          style={{
            height: `${rowVirtualizer.getTotalSize()}px`,
            width: "100%",
            position: "relative",
          }}
        >
          {/* Background grid lines */}
          <div className="pointer-events-none absolute inset-0 z-0">
            {ticks.map((tick) => (
              <div
                key={tick.sec}
                className="absolute bottom-0 top-0 border-l border-border/20"
                style={{ left: `${tick.leftPct}%` }}
              />
            ))}
          </div>

          {rowVirtualizer.getVirtualItems().map((virtualRow) => {
            const row = allRows[virtualRow.index];
            const rowStyle = {
              height: virtualRow.size,
              transform: `translateY(${virtualRow.start}px)`,
            };

            if (row.type === "trace-root") {
              const isSelected = selection.type === "trace";
              return (
                <div
                  key="trace-root"
                  className={cn(
                    "group absolute left-0 top-0 z-10 flex w-full cursor-pointer items-center border-b border-border/5 transition-colors hover:bg-muted/50",
                    isSelected && "bg-muted/60",
                  )}
                  style={rowStyle}
                  onClick={() => onSelect({ type: "trace" })}
                >
                  <span className="absolute left-2 z-20 whitespace-nowrap text-[10px] font-medium text-muted-foreground">
                    {formatDuration(traceDurationMs)}
                  </span>
                  {traceAggregates.rightLabel && (
                    <span className="absolute right-2 z-20 whitespace-nowrap text-[10px] font-medium text-muted-foreground">
                      {traceAggregates.rightLabel}
                    </span>
                  )}
                  <div
                    className={cn(
                      "absolute z-10 overflow-hidden rounded-[2px] border border-solid border-border/60 bg-muted transition-colors group-hover:bg-muted/80",
                      isSelected && "ring-1 ring-border",
                    )}
                    style={{ left: "0px", width: "100%", height: "20px" }}
                  />
                </div>
              );
            }

            const item = row.data;
            const span = item.span;
            const isSelected = selection.type === "span" && selection.span.span_id === span.span_id;
            const isError = span.status === SpanStatus.ERROR;
            const isInProgress = item.metrics.isInProgress;
            const durationText = isInProgress
              ? `${formatDuration(item.metrics.durationMs)}…`
              : formatDuration(item.metrics.durationMs);

            const isRootSpan = span.parent_span_id === null;
            const showDuration =
              span.span_kind === SpanKind.LLM || span.span_kind === SpanKind.TOOL || isRootSpan;

            const showRightMetrics = span.span_kind === SpanKind.LLM || isRootSpan;
            const tokensText =
              showRightMetrics && span.total_tokens ? `${formatTokens(span.total_tokens)} tok` : "";
            const costText =
              showRightMetrics && span.cost && Number.isFinite(span.cost)
                ? `$${span.cost.toFixed(3)}`
                : "";
            const rightLabel = [tokensText, costText].filter(Boolean).join(" · ");

            return (
              <div
                key={span.span_id}
                className={cn(
                  "group absolute left-0 top-0 z-10 flex w-full cursor-pointer items-center border-b border-border/5 transition-colors",
                  hoveredSpanId === span.span_id ? "bg-muted/60" : "bg-transparent",
                  isSelected && "bg-muted/80",
                )}
                style={rowStyle}
                onMouseEnter={(e) => {
                  e.stopPropagation();
                  onHoverChange(span.span_id);
                }}
                onMouseLeave={(e) => {
                  e.stopPropagation();
                  onHoverChange(null);
                }}
                onClick={() => onSelect({ type: "span", span })}
              >
                {showDuration && (
                  <span
                    className={cn(
                      "absolute left-2 z-20 whitespace-nowrap text-[10px] text-muted-foreground",
                      isInProgress && "italic",
                    )}
                  >
                    {durationText}
                  </span>
                )}
                {rightLabel && (
                  <span className="absolute right-2 z-20 whitespace-nowrap text-[10px] text-muted-foreground">
                    {rightLabel}
                  </span>
                )}
                {item.metrics.isInstant && !item.metrics.isInProgress ? (
                  <div
                    className="absolute z-10 h-3 w-[2px] bg-muted-foreground/50 transition-colors"
                    style={{ left: `${item.metrics.startOffsetPx}px` }}
                  />
                ) : (
                  <div
                    className={cn(
                      "absolute z-10 overflow-hidden rounded-[2px] border border-solid transition-colors",
                      isError
                        ? "border-red-300 bg-red-100 dark:bg-red-950/60"
                        : "border-border/60 bg-muted/60",
                      item.metrics.isInProgress && "animate-pulse border-dashed opacity-70",
                      isSelected && "ring-1 ring-border",
                    )}
                    style={{
                      left: `${item.metrics.startOffsetPx}px`,
                      width: `${Math.max(4, item.metrics.widthPx)}px`,
                      height: "20px",
                    }}
                  />
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
