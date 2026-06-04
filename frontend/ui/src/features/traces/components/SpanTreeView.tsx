"use client";

import { useCallback, useMemo, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ChevronRight, ChevronDown, CircleStop, CircleDollarSign } from "lucide-react";
import { cn, formatDuration, formatTokens } from "@/lib/utils";
import { SpanKind, SpanStatus } from "@traceroot/core";
import type { TraceDetail, Span } from "@/types/api";
import type { TraceSelection, SpanTreeRow } from "../types";
import {
  buildSpanTree,
  buildChildrenMap,
  enrichSpansWithPending,
  getSpanDuration,
  getTraceDuration,
  getTraceTotalCost,
  getTraceTokenUsage,
  TREE_LAYOUT,
} from "../utils";
import { SpanKindIcon } from "./SpanKindIcon";
import { SpanTreeConnector } from "./SpanTreeConnector";

const ROW_HEIGHT = TREE_LAYOUT.ROW_HEIGHT;

// Overscan is measured in rows; ~500px of buffer above/below the viewport keeps
// scrolling smooth on large traces (500 / 28px ≈ 18 rows).
const OVERSCAN_ROWS = Math.ceil(500 / ROW_HEIGHT);

// Virtualized row model: the trace root occupies index 0, visible spans follow.
// This ordering must stay in sync with the parent's scroll-to-row math
// (TraceViewerPanel.scrollTreeToRow uses rowIdx + 1 to skip the trace row).
type TreeRow = { type: "trace" } | { type: "span"; row: SpanTreeRow };

/**
 * Returns the flattened span rows that are currently visible, i.e. none of
 * their ancestors are collapsed. Kept pure (no React) so the row model can be
 * unit-tested and so the virtualizer count matches exactly what is rendered.
 */
export function getVisibleSpanRows(
  spanRows: SpanTreeRow[],
  spanById: Map<string, Span>,
  collapsedIds: Set<string>,
): SpanTreeRow[] {
  if (collapsedIds.size === 0) return spanRows;
  return spanRows.filter(({ span }) => {
    let currentId = span.parent_span_id;
    while (currentId) {
      if (collapsedIds.has(currentId)) return false;
      currentId = spanById.get(currentId)?.parent_span_id || null;
    }
    return true;
  });
}

interface SpanTreeViewProps {
  trace: TraceDetail;
  selection: TraceSelection;
  onSelect: (selection: TraceSelection) => void;
  collapsedIds: Set<string>;
  onToggleCollapse: (id: string) => void;
  compact?: boolean;
  hoveredSpanId: string | null;
  onHoverChange: (id: string | null) => void;
}

/**
 * Tree view component for displaying trace and span hierarchy.
 * Collapse state is managed externally (lifted to TraceViewerPanel) so it can
 * be shared with the timeline bars view for scroll-sync and row alignment.
 *
 * Rows are virtualized: only the rows in (or near) the viewport are mounted, so
 * traces with many hundreds of spans stay responsive. The scroll container is
 * the overflow-y-auto wrapper owned by TraceViewerPanel, resolved here as this
 * component's parent element.
 */
export function SpanTreeView({
  trace,
  selection,
  onSelect,
  collapsedIds,
  onToggleCollapse,
  compact = false,
  hoveredSpanId,
  onHoverChange,
}: SpanTreeViewProps) {
  // Enrich with placeholder spans for any missing ancestors — handles both
  // live-streaming gaps (parent not yet arrived) and permanently dropped spans.
  const spans = useMemo(() => enrichSpansWithPending(trace.spans), [trace.spans]);
  const childrenByParent = useMemo(() => buildChildrenMap(spans), [spans]);
  const spanById = useMemo(() => new Map(spans.map((s) => [s.span_id, s])), [spans]);
  const spanRows = useMemo(() => buildSpanTree(spans), [spans]);

  const hasChildren = (spanId: string | null) => {
    const children = childrenByParent.get(spanId) || [];
    return children.length > 0;
  };

  const toggleCollapse = (spanId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    onToggleCollapse(spanId);
  };

  const isTraceSelected = selection.type === "trace";
  const traceDuration = getTraceDuration(trace);
  const traceTotalCost = getTraceTotalCost(trace);
  const traceTokenUsage = getTraceTokenUsage(trace);
  const traceHasChildren = hasChildren(null);
  const traceIsCollapsed = collapsedIds.has("trace");

  // Flattened, collapse-filtered row list. Index 0 is always the trace root;
  // when the trace is collapsed its descendants are omitted entirely.
  const visibleSpanRows = useMemo(
    () => getVisibleSpanRows(spanRows, spanById, collapsedIds),
    [spanRows, spanById, collapsedIds],
  );
  const allRows = useMemo<TreeRow[]>(
    () => [
      { type: "trace" },
      ...(traceIsCollapsed ? [] : visibleSpanRows.map((row) => ({ type: "span" as const, row }))),
    ],
    [traceIsCollapsed, visibleSpanRows],
  );

  // The scroll element is the overflow-y-auto wrapper owned by the parent
  // (TraceViewerPanel). Resolve it from our own parent node via a ref callback
  // so the virtualizer re-measures once the node is attached.
  const [scrollEl, setScrollEl] = useState<HTMLElement | null>(null);
  const rootRefCallback = useCallback((node: HTMLDivElement | null) => {
    setScrollEl(node?.parentElement ?? null);
  }, []);

  const rowVirtualizer = useVirtualizer({
    count: allRows.length,
    getScrollElement: () => scrollEl,
    estimateSize: () => ROW_HEIGHT,
    overscan: OVERSCAN_ROWS,
  });

  return (
    <div ref={rootRefCallback} className="relative min-w-0">
      <div
        style={{
          height: `${rowVirtualizer.getTotalSize()}px`,
          width: "100%",
          position: "relative",
        }}
      >
        {rowVirtualizer.getVirtualItems().map((virtualRow) => {
          const rowData = allRows[virtualRow.index];
          const rowStyle: React.CSSProperties = {
            position: "absolute",
            top: 0,
            left: 0,
            width: "100%",
            height: virtualRow.size,
            transform: `translateY(${virtualRow.start}px)`,
          };

          if (rowData.type === "trace") {
            return (
              <div
                key="trace"
                className={cn(
                  "flex cursor-pointer items-center border-b border-border/5 transition-colors hover:bg-muted/50",
                  hoveredSpanId === "trace" && "bg-muted/60",
                  isTraceSelected && "bg-muted/60",
                )}
                style={{ ...rowStyle, paddingLeft: TREE_LAYOUT.LEFT_PADDING }}
                onClick={() => onSelect({ type: "trace" })}
                onMouseEnter={() => onHoverChange("trace")}
                onMouseLeave={() => onHoverChange(null)}
              >
                <div className="flex min-w-0 flex-1 items-center gap-1.5 pr-2">
                  <SpanKindIcon kind="trace" inTree />
                  <span className="min-w-0 shrink truncate text-xs font-medium">{trace.name}</span>

                  {/* Always render the flex-1 container to lock the gap math, but conditionally render contents */}
                  <div className="flex min-w-0 flex-1 items-center justify-start gap-1.5 @container">
                    {!compact && (
                      <>
                        <span className="hidden shrink-0 whitespace-nowrap font-mono text-[10px] text-muted-foreground @[45px]:inline-flex">
                          {formatDuration(traceDuration)}
                        </span>

                        {traceTokenUsage && (
                          <span className="hidden shrink-0 items-center gap-0.5 whitespace-nowrap font-mono text-[10px] text-muted-foreground @[80px]:inline-flex">
                            <CircleStop className="h-2.5 w-2.5" />
                            {formatTokens(traceTokenUsage.totalTokens)}
                          </span>
                        )}

                        {traceTotalCost != null && (
                          <span className="hidden shrink-0 items-center gap-0.5 whitespace-nowrap font-mono text-[10px] text-muted-foreground @[130px]:inline-flex">
                            <CircleDollarSign className="h-2.5 w-2.5" />
                            {traceTotalCost.toFixed(4)}
                          </span>
                        )}
                      </>
                    )}
                  </div>

                  {traceHasChildren && (
                    <button
                      onClick={(e) => toggleCollapse("trace", e)}
                      className="shrink-0 rounded p-0.5 transition-colors hover:bg-muted"
                    >
                      {traceIsCollapsed ? (
                        <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                      ) : (
                        <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                      )}
                    </button>
                  )}
                </div>
              </div>
            );
          }

          const { span, level, isTerminal, parentLevels } = rowData.row;
          const isSelected = selection.type === "span" && selection.span.span_id === span.span_id;
          const adjustedLevel = level + 1;
          const adjustedParentLevels = parentLevels.map((l) => l + 1);
          const spanHasChildren = hasChildren(span.span_id);
          const isCollapsed = collapsedIds.has(span.span_id);

          return (
            <div
              key={span.span_id}
              className={cn(
                "group flex cursor-pointer items-center border-b border-border/5 transition-colors",
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
              <SpanTreeConnector
                level={adjustedLevel}
                isTerminal={isTerminal}
                parentLevels={adjustedParentLevels}
              />

              <div className="flex min-w-0 flex-1 items-center gap-1.5 pr-2">
                <SpanKindIcon kind={span.span_kind} inTree />
                <span
                  className={cn(
                    "min-w-0 shrink truncate text-xs",
                    span.pending && "text-muted-foreground/60",
                  )}
                >
                  {span.name}
                </span>
                {/* Error badge stays outside the @container to guarantee it is always visible */}
                {span.status === SpanStatus.ERROR && (
                  <span className="shrink-0 whitespace-nowrap rounded bg-red-100 px-1 py-0.5 text-[10px] font-medium text-red-700 dark:bg-red-950 dark:text-red-400">
                    ERROR
                  </span>
                )}

                {/* Always render the flex-1 container to lock the gap math */}
                <div className="flex min-w-0 flex-1 items-center justify-start gap-1.5 @container">
                  {!compact && (
                    <>
                      {!span.pending && (
                        <span className="hidden shrink-0 whitespace-nowrap font-mono text-[10px] text-muted-foreground @[45px]:inline-flex">
                          {formatDuration(getSpanDuration(span))}
                        </span>
                      )}

                      {span.span_kind === SpanKind.LLM && span.total_tokens != null && (
                        <span className="hidden shrink-0 items-center gap-0.5 whitespace-nowrap font-mono text-[10px] text-muted-foreground @[80px]:inline-flex">
                          <CircleStop className="h-2.5 w-2.5" />
                          {formatTokens(span.total_tokens)}
                        </span>
                      )}

                      {span.span_kind === SpanKind.LLM &&
                        span.cost != null &&
                        Number.isFinite(span.cost) && (
                          <span className="hidden shrink-0 items-center gap-0.5 whitespace-nowrap font-mono text-[10px] text-muted-foreground @[130px]:inline-flex">
                            <CircleDollarSign className="h-2.5 w-2.5" />
                            {span.cost.toFixed(4)}
                          </span>
                        )}
                    </>
                  )}
                </div>

                {spanHasChildren && (
                  <button
                    onClick={(e) => toggleCollapse(span.span_id, e)}
                    className="shrink-0 rounded p-0.5 transition-colors hover:bg-muted"
                  >
                    {isCollapsed ? (
                      <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                    ) : (
                      <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                    )}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
