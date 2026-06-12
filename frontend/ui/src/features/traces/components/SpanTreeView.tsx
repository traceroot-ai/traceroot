"use client";

import { forwardRef, useImperativeHandle, useMemo, useCallback, useRef, useEffect } from "react";
import type { RefObject } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useQueryClient } from "@tanstack/react-query";
import { useSession as useAuthSession } from "@/lib/auth-client";
import { getSpanIO } from "@/lib/api";
import { ChevronRight, ChevronDown, CircleStop, CircleDollarSign } from "lucide-react";
import { cn, formatDuration, formatTokenFlow } from "@/lib/utils";
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
  TREE_OVERSCAN_ROWS,
} from "../utils";
import { spanIOQueryKey, SPAN_IO_STALE_TIME_MS } from "../hooks";
import { SpanKindIcon } from "./SpanKindIcon";
import { SpanTreeConnector } from "./SpanTreeConnector";

const ROW_HEIGHT = TREE_LAYOUT.ROW_HEIGHT;

// Debounce hover-prefetch so an incidental cursor sweep across rows doesn't fire a
// request per row — only an intentional hover (cursor resting past this delay)
// prefetches. (Reference: peer tools debounce prefetch ~100-250ms.)
const SPAN_IO_PREFETCH_DEBOUNCE_MS = 150;

// Virtualized row model: the trace root occupies index 0, visible spans follow.
// This list is the single source of truth for both the virtualizer count and
// the span→index mapping behind scroll-to-selected (see `scrollToSpan`), so no
// row-height math lives in the parent anymore.
export type TreeRow = { type: "trace" } | { type: "span"; row: SpanTreeRow };

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

/**
 * Builds the full virtualized row model: the trace root at index 0 followed by
 * the collapse-filtered span rows in DFS order. When the trace root itself is
 * collapsed, only the root row remains. Pure so the row model — and the
 * span→index mapping that drives scroll-to-selected — can be unit-tested.
 *
 * The visible-span ORDER here must stay identical to SpanTimelineView's
 * `flattenTreeWithMetrics`: the two panels are scroll-synced row-for-row, so any
 * divergence silently misaligns them. A parity test guards this (SpanTreeView.test.ts).
 */
export function buildTreeRows(
  spanRows: SpanTreeRow[],
  spanById: Map<string, Span>,
  collapsedIds: Set<string>,
): TreeRow[] {
  if (collapsedIds.has("trace")) return [{ type: "trace" }];
  return [
    { type: "trace" },
    ...getVisibleSpanRows(spanRows, spanById, collapsedIds).map((row) => ({
      type: "span" as const,
      row,
    })),
  ];
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
  /** The overflow-y-auto scroll container owned by TraceViewerPanel. */
  scrollRef: RefObject<HTMLDivElement | null>;
}

export interface SpanTreeViewHandle {
  /**
   * Scroll the row for `spanId` into view, centered. No-op when the span is not
   * currently visible (an ancestor is collapsed) or not present in the trace.
   */
  scrollToSpan: (spanId: string) => void;
}

/**
 * Tree view component for displaying trace and span hierarchy.
 * Collapse state is managed externally (lifted to TraceViewerPanel) so it can
 * be shared with the timeline bars view for scroll-sync and row alignment.
 *
 * Rows are virtualized: only the rows in (or near) the viewport are mounted, so
 * traces with many hundreds of spans stay responsive. The scroll container is
 * the overflow-y-auto wrapper owned by TraceViewerPanel, passed in via the
 * `scrollRef` prop (mirroring SpanTimelineView).
 */
export const SpanTreeView = forwardRef<SpanTreeViewHandle, SpanTreeViewProps>(function SpanTreeView(
  {
    trace,
    selection,
    onSelect,
    collapsedIds,
    onToggleCollapse,
    compact = false,
    hoveredSpanId,
    onHoverChange,
    scrollRef,
  },
  ref,
) {
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

  // Prefetch a span's I/O on hover so the click → SpanInfoPanel render is
  // instant. Skips placeholder (pending) spans, which have no row in ClickHouse.
  const queryClient = useQueryClient();
  const { data: authSession } = useAuthSession();
  const prefetchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const runSpanIOPrefetch = useCallback(
    (span: Span) => {
      if (span.pending) return;
      // Skip prefetch until the auth session is ready: prefetching with no user
      // would trigger a fallback session fetch per hover and could cache an
      // unauthenticated result under the shared span-io query key.
      if (!authSession?.user) return;
      const user = { id: authSession.user.id, email: authSession.user.email };
      queryClient.prefetchQuery({
        queryKey: spanIOQueryKey(trace.project_id, trace.trace_id, span.span_id),
        queryFn: () => getSpanIO(trace.project_id, trace.trace_id, span.span_id, user),
        staleTime: SPAN_IO_STALE_TIME_MS,
      });
    },
    [queryClient, authSession, trace.project_id, trace.trace_id],
  );

  // Schedule the prefetch after a short hover delay; cancel on leave / unmount so a
  // quick cursor pass-over doesn't fire a request.
  const scheduleSpanIOPrefetch = useCallback(
    (span: Span) => {
      if (span.pending) return;
      if (prefetchTimerRef.current) clearTimeout(prefetchTimerRef.current);
      prefetchTimerRef.current = setTimeout(
        () => runSpanIOPrefetch(span),
        SPAN_IO_PREFETCH_DEBOUNCE_MS,
      );
    },
    [runSpanIOPrefetch],
  );

  const cancelSpanIOPrefetch = useCallback(() => {
    if (prefetchTimerRef.current) {
      clearTimeout(prefetchTimerRef.current);
      prefetchTimerRef.current = null;
    }
  }, []);

  useEffect(() => () => cancelSpanIOPrefetch(), [cancelSpanIOPrefetch]);

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

  // Full virtualized row model: trace root at index 0, then collapse-filtered
  // span rows in DFS order. Single source of truth for both the virtualizer
  // count and the span→index mapping used by scrollToSpan.
  const allRows = useMemo(
    () => buildTreeRows(spanRows, spanById, collapsedIds),
    [spanRows, spanById, collapsedIds],
  );

  const rowVirtualizer = useVirtualizer({
    count: allRows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: TREE_OVERSCAN_ROWS,
  });

  // Imperative scroll-to-selected, invoked when a timeline click switches back
  // to the tree. Delegates to the virtualizer (height-agnostic) instead of the
  // old manual scrollTop math, and centers the row to match prior behaviour.
  useImperativeHandle(
    ref,
    () => ({
      scrollToSpan: (spanId: string) => {
        const index = allRows.findIndex((r) => r.type === "span" && r.row.span.span_id === spanId);
        if (index !== -1) rowVirtualizer.scrollToIndex(index, { align: "center" });
      },
    }),
    [allRows, rowVirtualizer],
  );

  return (
    <div className="relative min-w-0">
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
                          <span className="hidden shrink-0 items-center gap-0.5 whitespace-nowrap text-[10px] font-medium text-muted-foreground @[130px]:inline-flex">
                            <CircleStop className="h-2.5 w-2.5" />
                            {formatTokenFlow(
                              traceTokenUsage.inputTokens,
                              traceTokenUsage.outputTokens,
                              traceTokenUsage.totalTokens,
                            )}
                          </span>
                        )}

                        {traceTotalCost != null && (
                          <span className="hidden shrink-0 items-center gap-0.5 whitespace-nowrap font-mono text-[10px] text-muted-foreground @[190px]:inline-flex">
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
                scheduleSpanIOPrefetch(span);
              }}
              onMouseLeave={(e) => {
                e.stopPropagation();
                onHoverChange(null);
                cancelSpanIOPrefetch();
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
                        <span className="hidden shrink-0 items-center gap-0.5 whitespace-nowrap text-[10px] font-medium text-muted-foreground @[130px]:inline-flex">
                          <CircleStop className="h-2.5 w-2.5" />
                          {formatTokenFlow(
                            span.input_tokens,
                            span.output_tokens,
                            span.total_tokens,
                          )}
                        </span>
                      )}

                      {span.span_kind === SpanKind.LLM &&
                        span.cost != null &&
                        Number.isFinite(span.cost) && (
                          <span className="hidden shrink-0 items-center gap-0.5 whitespace-nowrap font-mono text-[10px] text-muted-foreground @[190px]:inline-flex">
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
});
