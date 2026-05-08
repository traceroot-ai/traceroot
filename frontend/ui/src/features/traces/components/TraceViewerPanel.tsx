"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Workflow,
  X,
  ArrowUp,
  ArrowDown,
  BotMessageSquare,
  ListTree,
  SquareGanttChart,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from "@/components/ui/resizable";
import { getTrace } from "@/lib/api";
import type { Span } from "@/types/api";
import type { TraceSelection } from "../types";
import { SpanTreeView } from "./SpanTreeView";
import { SpanInfoPanel } from "./SpanInfoPanel";
import { AiChatOverlay } from "@/features/ai-assistant/components/ai-chat-overlay";
import { useTraceStream } from "../hooks/use-trace-stream";
import { SpanTimelineView } from "./SpanTimelineView";
import { buildSpanTree, enrichSpansWithPending, TREE_LAYOUT } from "../utils";

interface TraceViewerPanelProps {
  projectId: string;
  traceId: string;
  onClose: () => void;
  onNavigate: (direction: "up" | "down") => void;
  canNavigateUp: boolean;
  canNavigateDown: boolean;
  dateFilter?: { id: string; isCustom?: boolean };
  customStartDate?: Date | null;
  customEndDate?: Date | null;
}

/**
 * Full-screen slide-in panel for viewing trace details.
 *
 * Layout — SpanTreeView is always on the left in both modes:
 *
 *   Tree mode:
 *     [SpanTreeView ~30%] | [SpanInfoPanel ~70%]
 *
 *   Timeline mode:
 *     [SpanTreeView compact ~30%] | [SpanTimelineView ~70%]
 *     Clicking a timeline bar → switches back to tree mode with the span selected.
 *
 * Collapse state and scroll position are shared so the tree and bars stay aligned.
 * The divider is draggable in both modes (tree and timeline).
 */
export function TraceViewerPanel({
  projectId,
  traceId,
  onClose,
  onNavigate,
  canNavigateUp,
  canNavigateDown,
  dateFilter,
  customStartDate,
  customEndDate,
}: TraceViewerPanelProps) {
  const [selection, setSelection] = useState<TraceSelection>({ type: "trace" });
  const [aiChatOpen, setAiChatOpen] = useState(false);
  const [viewMode, setViewMode] = useState<"tree" | "timeline">("tree");

  // Shared collapse state (SpanTreeView + SpanTimelineView stay in sync)
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(new Set());

  // Scroll sync refs
  const treeScrollRef = useRef<HTMLDivElement>(null);
  const timelineScrollRef = useRef<HTMLDivElement>(null);
  const isSyncing = useRef(false);

  const [hoveredSpanId, setHoveredSpanId] = useState<string | null>(null);

  const {
    data: trace,
    isLoading,
    error,
  } = useQuery({
    queryKey: ["trace", projectId, traceId],
    queryFn: () => getTrace(projectId, traceId, ""),
  });

  useTraceStream(projectId, traceId, true);

  // Reset when navigating to a different trace
  useEffect(() => {
    setSelection({ type: "trace" });
    setCollapsedIds(new Set());
  }, [traceId]);

  useEffect(() => {
    if (viewMode !== "timeline") return;

    requestAnimationFrame(() => {
      if (!treeScrollRef.current || !timelineScrollRef.current) return;

      timelineScrollRef.current.scrollTop = treeScrollRef.current.scrollTop;
    });
  }, [viewMode]);

  const handleToggleCollapse = useCallback((id: string) => {
    setCollapsedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  // Scroll the tree panel to bring a row index into view (centered).
  const scrollTreeToRow = useCallback((rowIndex: number) => {
    const el = treeScrollRef.current;
    if (!el) return;
    const target = rowIndex * TREE_LAYOUT.ROW_HEIGHT;
    const center = target - el.clientHeight / 2 + TREE_LAYOUT.ROW_HEIGHT / 2;
    el.scrollTop = Math.max(0, center);
  }, []);

  const isSpanVisible = useCallback(
    (span: Span, spanById: Map<string, Span>) => {
      let currentId = span.parent_span_id;
      while (currentId) {
        if (collapsedIds.has(currentId)) return false;
        currentId = spanById.get(currentId)?.parent_span_id ?? null;
      }
      return true;
    },
    [collapsedIds],
  );

  /**
   * Called when the user clicks a bar in the timeline.
   * Switches to tree mode so the user lands on the full span details view.
   * Also scrolls the tree to show the selected span.
   */
  const handleTimelineSelect = useCallback(
    (sel: TraceSelection) => {
      setSelection(sel);
      setViewMode("tree");

      if (sel.type === "span" && trace) {
        const spans = enrichSpansWithPending(trace.spans);
        const spanById = new Map(spans.map((s) => [s.span_id, s]));
        const rows = buildSpanTree(spans).filter((row) => isSpanVisible(row.span, spanById));
        const rowIdx = rows.findIndex((r) => r.span.span_id === sel.span.span_id);
        if (rowIdx !== -1) {
          // +1 because row 0 in the tree is the trace root
          requestAnimationFrame(() => scrollTreeToRow(rowIdx + 1));
        }
      }
    },
    [trace, scrollTreeToRow, isSpanVisible],
  );

  // Sync tree scroll → timeline
  const handleTreeScroll = useCallback(() => {
    if (isSyncing.current || !treeScrollRef.current) return;
    if (!timelineScrollRef.current) return;
    isSyncing.current = true;
    timelineScrollRef.current.scrollTop = treeScrollRef.current.scrollTop;
    requestAnimationFrame(() => {
      isSyncing.current = false;
    });
  }, []);

  // Sync timeline scroll → tree
  const handleTimelineScroll = useCallback(() => {
    if (isSyncing.current || !treeScrollRef.current || !timelineScrollRef.current) return;
    isSyncing.current = true;
    treeScrollRef.current.scrollTop = timelineScrollRef.current.scrollTop;
    requestAnimationFrame(() => {
      isSyncing.current = false;
    });
  }, []);

  return (
    <div className="flex h-full flex-col bg-background">
      {/* ── MAIN HEADER ── */}
      <div className="flex h-12 items-center justify-between border-b border-border bg-muted/30 px-4">
        <div className="flex min-w-0 items-center gap-2">
          <Workflow className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-medium">Trace</span>
          <span className="truncate font-mono text-xs text-muted-foreground">{traceId}</span>
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="sm"
            onClick={() => onNavigate("up")}
            disabled={!canNavigateUp}
            className="h-7 w-7 p-0"
            title="Previous trace"
          >
            <ArrowUp className="h-4 w-4" />
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => onNavigate("down")}
            disabled={!canNavigateDown}
            className="h-7 w-7 p-0"
            title="Next trace"
          >
            <ArrowDown className="h-4 w-4" />
          </Button>
          <div className="w-2" />
          <Button
            variant="outline"
            size="sm"
            onClick={() => setAiChatOpen(!aiChatOpen)}
            className="h-7 w-7 p-0"
            title="AI Assistant"
          >
            <BotMessageSquare className="h-4 w-4" />
          </Button>
          <Button variant="ghost" size="sm" onClick={onClose} className="h-7 w-7 p-0">
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* ── VIEW TOGGLE SUB-HEADER ── */}
      <div className="flex h-10 items-center border-b border-border">
        <div className="flex items-center rounded-lg px-2 py-1">
          <button
            onClick={() => setViewMode("tree")}
            className={cn(
              "flex items-center gap-2 rounded-md px-3 py-1 text-xs font-medium transition-all",
              viewMode === "tree"
                ? "bg-muted text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <ListTree className="h-3.5 w-3.5" />
            Trace
          </button>
          <button
            onClick={() => setViewMode("timeline")}
            className={cn(
              "flex items-center gap-2 rounded-md px-3 py-1 text-xs font-medium transition-all",
              viewMode === "timeline"
                ? "bg-muted text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <SquareGanttChart className="h-3.5 w-3.5" />
            Timeline
          </button>
        </div>
      </div>

      {/* ── CONTENT AREA ── */}
      {isLoading ? (
        <div className="flex flex-1 items-center justify-center">
          <p className="text-sm text-muted-foreground">Loading trace...</p>
        </div>
      ) : error || !trace ? (
        <div className="flex flex-1 items-center justify-center">
          <p className="text-sm text-destructive">Error loading trace</p>
        </div>
      ) : (
        <div className="relative flex flex-1 overflow-hidden">
          <ResizablePanelGroup orientation="horizontal" disableCursor>
            {/* LEFT: tree panel */}
            <ResizablePanel
              defaultSize="30%"
              minSize="20%"
              maxSize="50%"
              className="flex flex-col bg-muted/30"
            >
              <div
                className="flex flex-shrink-0 items-center border-b border-border bg-muted/10 px-3"
                style={{ height: TREE_LAYOUT.ROW_HEIGHT }}
              >
                <span className="text-[11px] font-medium text-muted-foreground">Trace Tree</span>
              </div>
              <div
                ref={treeScrollRef}
                className="flex-1 overflow-y-auto"
                onScroll={handleTreeScroll}
              >
                <SpanTreeView
                  trace={trace}
                  selection={selection}
                  onSelect={viewMode === "tree" ? setSelection : handleTimelineSelect}
                  collapsedIds={collapsedIds}
                  onToggleCollapse={handleToggleCollapse}
                  compact={viewMode === "timeline"}
                  hoveredSpanId={hoveredSpanId}
                  onHoverChange={setHoveredSpanId}
                />
              </div>
            </ResizablePanel>

            {/* RIGHT BORDER / RESIZER HANDLE */}
            <ResizableHandle
              className={cn(
                "group/handle relative z-50 flex w-px items-center justify-center bg-border transition-colors duration-150 ease-in-out",
                "cursor-col-resize [&_*]:cursor-col-resize",
              )}
            >
              <div className="absolute inset-y-0 -left-2 -right-2 z-10 bg-transparent" />
              <div className="absolute inset-y-0 z-20 w-[3px] bg-transparent transition-colors duration-150 group-hover/handle:bg-primary/30 group-active/handle:bg-primary/40 group-data-[resize-handle-state=drag]/handle:bg-primary/40" />
              <div className="absolute z-30 h-4 w-[3px] rounded-full bg-muted-foreground/40 ring-2 ring-transparent transition-all duration-150 group-hover/handle:h-6 group-hover/handle:bg-primary group-hover/handle:ring-background group-active/handle:bg-primary group-active/handle:ring-background group-data-[resize-handle-state=drag]/handle:h-6 group-data-[resize-handle-state=drag]/handle:bg-primary group-data-[resize-handle-state=drag]/handle:ring-background" />
            </ResizableHandle>

            {/* RIGHT: details panel (tree mode) or Gantt bars (timeline mode) */}
            <ResizablePanel className="overflow-hidden bg-background">
              {viewMode === "tree" ? (
                <SpanInfoPanel
                  projectId={projectId}
                  trace={trace}
                  selection={selection}
                  onClose={onClose}
                  dateFilter={dateFilter}
                  customStartDate={customStartDate}
                  customEndDate={customEndDate}
                />
              ) : (
                <SpanTimelineView
                  trace={trace}
                  selection={selection}
                  onSelect={handleTimelineSelect}
                  collapsedIds={collapsedIds}
                  scrollRef={timelineScrollRef}
                  onScroll={handleTimelineScroll}
                  hoveredSpanId={hoveredSpanId}
                  onHoverChange={setHoveredSpanId}
                />
              )}
            </ResizablePanel>
          </ResizablePanelGroup>

          {/* AI Chat overlay */}
          {aiChatOpen && (
            <AiChatOverlay
              projectId={projectId}
              traceId={traceId}
              onClose={() => setAiChatOpen(false)}
            />
          )}
        </div>
      )}
    </div>
  );
}
