"use client";

import { useMemo } from "react";
import { ChevronRight, ChevronDown, CircleStop, CircleDollarSign } from "lucide-react";
import { cn, formatDuration, formatTokens } from "@/lib/utils";
import { SpanKind, SpanStatus } from "@traceroot/core";
import type { TraceDetail, Span } from "@/types/api";
import type { TraceSelection } from "../types";
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

  const isVisible = (span: Span): boolean => {
    let currentId = span.parent_span_id;
    while (currentId) {
      if (collapsedIds.has(currentId)) return false;
      currentId = spanById.get(currentId)?.parent_span_id || null;
    }
    return true;
  };

  const isTraceSelected = selection.type === "trace";
  const traceDuration = getTraceDuration(trace);
  const traceTotalCost = getTraceTotalCost(trace);
  const traceTokenUsage = getTraceTokenUsage(trace);
  const traceHasChildren = hasChildren(null);
  const traceIsCollapsed = collapsedIds.has("trace");

  return (
    <div className="relative min-w-0">
      {/* Trace row */}
      <div
        className={cn(
          "flex cursor-pointer items-center border-b border-border/5 transition-colors hover:bg-muted/50",
          hoveredSpanId === "trace" && "bg-muted/60",
          isTraceSelected && "bg-muted/60",
        )}
        style={{ height: TREE_LAYOUT.ROW_HEIGHT, paddingLeft: TREE_LAYOUT.LEFT_PADDING }}
        onClick={() => onSelect({ type: "trace" })}
        onMouseEnter={() => onHoverChange("trace")}
        onMouseLeave={() => onHoverChange(null)}
      >
        <div className="flex min-w-0 flex-1 items-center gap-1.5 pr-2">
          <SpanKindIcon kind="trace" inTree />
          <span className="min-w-0 shrink truncate text-xs font-medium">{trace.name}</span>

          {/* ALWAYS render the flex-1 container to lock the gap math, but conditionally render contents */}
          <div className="@container flex min-w-0 flex-1 items-center justify-start gap-1.5">
            {!compact && (
              <>
                <span className="@[45px]:inline-flex hidden shrink-0 whitespace-nowrap font-mono text-[10px] text-muted-foreground">
                  {formatDuration(traceDuration)}
                </span>

                {traceTokenUsage && (
                  <span className="@[80px]:inline-flex hidden shrink-0 items-center gap-0.5 whitespace-nowrap font-mono text-[10px] text-muted-foreground">
                    <CircleStop className="h-2.5 w-2.5" />
                    {formatTokens(traceTokenUsage.totalTokens)}
                  </span>
                )}

                {traceTotalCost != null && (
                  <span className="@[130px]:inline-flex hidden shrink-0 items-center gap-0.5 whitespace-nowrap font-mono text-[10px] text-muted-foreground">
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

      {/* Span rows */}
      {!traceIsCollapsed &&
        spanRows.map(({ span, level, isTerminal, parentLevels }) => {
          if (!isVisible(span)) return null;

          const isSelected = selection.type === "span" && selection.span.span_id === span.span_id;
          const adjustedLevel = level + 1;
          const adjustedParentLevels = parentLevels.map((l) => l + 1);
          const spanHasChildren = hasChildren(span.span_id);
          const isCollapsed = collapsedIds.has(span.span_id);

          return (
            <div
              key={span.span_id}
              className={cn(
                "group relative flex w-full cursor-pointer items-center border-b border-border/5 transition-colors",
                hoveredSpanId === span.span_id ? "bg-muted/60" : "bg-transparent",
                isSelected && "bg-muted/80",
              )}
              style={{ height: TREE_LAYOUT.ROW_HEIGHT }}
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

                {/* ALWAYS render the flex-1 container to lock the gap math */}
                <div className="@container flex min-w-0 flex-1 items-center justify-start gap-1.5">
                  {!compact && (
                    <>
                      {!span.pending && (
                        <span className="@[45px]:inline-flex hidden shrink-0 whitespace-nowrap font-mono text-[10px] text-muted-foreground">
                          {formatDuration(getSpanDuration(span))}
                        </span>
                      )}

                      {span.span_kind === SpanKind.LLM && span.total_tokens != null && (
                        <span className="@[80px]:inline-flex hidden shrink-0 items-center gap-0.5 whitespace-nowrap font-mono text-[10px] text-muted-foreground">
                          <CircleStop className="h-2.5 w-2.5" />
                          {formatTokens(span.total_tokens)}
                        </span>
                      )}

                      {span.span_kind === SpanKind.LLM &&
                        span.cost != null &&
                        Number.isFinite(span.cost) && (
                          <span className="@[130px]:inline-flex hidden shrink-0 items-center gap-0.5 whitespace-nowrap font-mono text-[10px] text-muted-foreground">
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
  );
}
