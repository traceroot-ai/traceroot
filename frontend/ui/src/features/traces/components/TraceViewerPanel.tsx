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
  Eye,
  Expand,
  Shrink,
  SquareArrowOutUpRight,
} from "lucide-react";
import { cn, buildUrlWithFilters } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from "@/components/ui/resizable";
import { getTrace } from "@/lib/api";
import type { TraceSelection } from "../types";
import { SpanTreeView, type SpanTreeViewHandle } from "./SpanTreeView";
import { SpanInfoPanel } from "./SpanInfoPanel";
import { useLayout } from "@/components/layout/app-layout";
import { AiAssistantPanel } from "@/features/ai-assistant/components/ai-assistant-panel";
import { useTraceStream } from "../hooks/use-trace-stream";
import { SpanTimelineView } from "./SpanTimelineView";
import { TREE_LAYOUT } from "../utils";
import { useTraceFindings, useRca } from "@/features/detectors/hooks/use-findings";
import { TraceDetectorsTab } from "./TraceDetectorsTab";

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
  /** When true, auto-opens chat with RCA loaded on mount (detector findings page only) */
  autoOpenRca?: boolean;
  /** When true, the panel mounts already expanded to full width (e.g. opened in a new tab). */
  initialFullscreen?: boolean;
  /**
   * Base path the "open in new tab" button targets, so the trace pops out back
   * into the page it was opened from. Defaults to the project traces page; the
   * detector page passes its own path so the popped-out trace stays in the
   * detector tab.
   */
  newTabPath?: string;
  /**
   * Scope the trace fetch: "detector" opens a detector self-trace (excluded
   * from normal reads), "user" excludes self-traces. Omit for no scoping.
   */
  source?: "detector" | "user";
}

/**
 * Full-screen slide-in panel for viewing trace details.
 *
 * Resize hierarchy:
 *   top-level: [ Main content | AI Assistant (optional) ]
 *   main:      [ Trace Tree | Span Details ]
 *
 * The AI assistant is a top-level sibling of the main content so it stays
 * visible on every view. The trace tree stays mounted on the left across all
 * views; the toggle swaps the right detail panel between span details, the
 * timeline, and the detectors table. AI state lives in AiChatProvider above
 * this component, so chat survives trace switching.
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
  autoOpenRca,
  initialFullscreen,
  newTabPath,
  source,
}: TraceViewerPanelProps) {
  const [selection, setSelection] = useState<TraceSelection>({ type: "trace" });
  const [viewMode, setViewMode] = useState<"tree" | "timeline" | "detectors">("tree");
  // Fullscreen widens the slide-in overlay from ~70% to the full viewport.
  // Seeded from initialFullscreen so a trace opened in a new tab lands expanded.
  // Local + resets when the panel unmounts (i.e. on close/reopen); it
  // intentionally persists while navigating between traces, since the panel
  // instance stays mounted across ↑/↓ navigation.
  const [isFullscreen, setIsFullscreen] = useState(initialFullscreen ?? false);
  const {
    aiPanelOpen,
    setAiPanelOpen,
    setAiContext,
    setAiInitialSessionId,
    registerAiHost,
    sidebarCollapsed,
  } = useLayout();

  // Claim the AI slot for this viewer so AppLayout's project rail steps aside.
  // `registerAiHost()` returns its own cleanup, which we return from the effect
  // so React runs it on unmount and the rail comes back.
  useEffect(() => {
    return registerAiHost();
  }, [registerAiHost]);

  // Shared collapse state (SpanTreeView + SpanTimelineView stay in sync)
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(new Set());

  // Scroll sync refs
  const treeScrollRef = useRef<HTMLDivElement>(null);
  const timelineScrollRef = useRef<HTMLDivElement>(null);
  const isSyncing = useRef(false);
  // Imperative handle so a timeline click can scroll the tree to the span;
  // the tree owns the virtualizer and resolves the row index itself.
  const treeViewRef = useRef<SpanTreeViewHandle>(null);

  const [hoveredSpanId, setHoveredSpanId] = useState<string | null>(null);

  // Detector findings → Alert button + auto-open RCA chat when entered from
  // the findings page. The trace-level finding (at most one per trace) carries
  // the RCA session the worker already populated. The Alert button opens that
  // analysis, so it only renders when an RCA record exists — a finding from an
  // RCA-disabled detector has no analysis to open (gate on the record, not the
  // sessionId, so the button doesn't flicker while the RCA is still pending).
  const { data: traceFindingsData } = useTraceFindings(projectId, traceId);
  const traceFinding = traceFindingsData?.findings?.[0];
  const { data: rcaData } = useRca(projectId, traceFinding?.finding_id ?? "");
  const hasRca = !!traceFinding && !!rcaData?.rca;
  const rcaSessionId = rcaData?.rca?.sessionId ?? undefined;

  // Auto-open chat with RCA session loaded when arriving from /detectors.
  // Waits for rcaSessionId so the chat opens already pointing at the session,
  // avoiding a fresh-chat flash before the id resolves.
  useEffect(() => {
    if (!autoOpenRca || !rcaSessionId) return;
    setAiContext({ traceId });
    setAiInitialSessionId(rcaSessionId);
    setAiPanelOpen(true);
  }, [autoOpenRca, rcaSessionId, traceId, setAiContext, setAiInitialSessionId, setAiPanelOpen]);

  const {
    data: trace,
    isLoading,
    error,
  } = useQuery({
    queryKey: ["trace", projectId, traceId, source ?? null],
    queryFn: () => getTrace(projectId, traceId, "", undefined, source),
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
  // Close the panel on Escape. A nested Radix overlay (dialog/select/popover/menu) that
  // consumes the Escape calls preventDefault() in the capture phase, before this
  // bubble-phase listener runs — so defaultPrevented means "already handled, leave the panel open".
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (e.defaultPrevented) return;
      onClose();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);
  const handleToggleCollapse = useCallback((id: string) => {
    setCollapsedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  /**
   * Called when the user clicks a bar in the timeline.
   * Switches to tree mode so the user lands on the full span details view, then
   * scrolls the tree to the selected span. The tree owns the virtualized row
   * model, so it resolves the span's index and scroll position itself — this
   * panel no longer duplicates the collapse-visibility walk or row-height math.
   */
  const handleTimelineSelect = useCallback((sel: TraceSelection) => {
    setSelection(sel);
    setViewMode("tree");
    if (sel.type === "span") {
      // Defer a frame so the tree has its up-to-date (non-compact) row model
      // before the virtualizer scrolls.
      requestAnimationFrame(() => treeViewRef.current?.scrollToSpan(sel.span.span_id));
    }
  }, []);

  // Sync tree scroll → timeline
  const handleTreeScroll = useCallback(() => {
    if (isSyncing.current || !treeScrollRef.current || !timelineScrollRef.current) return;
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
    <div
      className={cn(
        "animate-slide-in-right fixed bottom-0 right-0 z-50 border-l border-border bg-background shadow-xl transition-[width,top] duration-200",
        // Fullscreen stays clear of the chrome it would otherwise cover: it
        // starts below the top breadcrumb/header bar (h-14) and to the right of
        // the left navbar. Width = 100% minus the sidebar's width, which differs
        // when the sidebar is collapsed.
        isFullscreen
          ? sidebarCollapsed
            ? "top-14 w-[calc(100%-3.5rem)]"
            : "top-14 w-[calc(100%-12rem)]"
          : "top-0 w-[70%]",
      )}
    >
      <div className="flex h-full flex-col bg-background">
        {/* ── MAIN HEADER ── */}
        <div className="flex h-12 items-center justify-between border-b border-border bg-muted/30 px-4">
          <div className="flex min-w-0 items-center gap-2">
            <Workflow className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm font-medium">Trace</span>
            <span className="truncate font-mono text-xs text-muted-foreground">{traceId}</span>
          </div>
          <div className="flex items-center gap-1">
            {hasRca && (
              <button
                type="button"
                onClick={() => {
                  setAiContext({ traceId });
                  setAiInitialSessionId(rcaSessionId);
                  setAiPanelOpen(true);
                }}
                className="rounded-md border border-red-300 bg-red-50 px-2 py-1 text-[11px] font-medium text-red-700 transition-colors hover:bg-red-100 dark:border-red-800 dark:bg-red-950/40 dark:text-red-400 dark:hover:bg-red-950/60"
                title="Findings detected — open root cause analysis"
              >
                Alert
              </button>
            )}
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
            <Button
              variant="outline"
              size="sm"
              onClick={() => setIsFullscreen((v) => !v)}
              className="h-7 w-7 p-0"
              title={isFullscreen ? "Restore default size" : "Expand to full screen"}
            >
              {isFullscreen ? <Shrink className="h-4 w-4" /> : <Expand className="h-4 w-4" />}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                window.open(
                  buildUrlWithFilters(newTabPath ?? `/projects/${projectId}/traces`, {
                    dateFilter,
                    customStartDate,
                    customEndDate,
                    extraParams: { traceId, fullscreen: "1" },
                  }),
                  "_blank",
                )
              }
              className="h-7 w-7 p-0"
              title="Open in new tab"
            >
              <SquareArrowOutUpRight className="h-4 w-4" />
            </Button>
            <div className="w-2" />
            {/* AI Assistant sits immediately left of Close, separated by a gap
                from the navigation/view controls, so the agent button stays the
                rightmost action regardless of the other header controls. */}
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setAiContext({ traceId });
                // Bot button always opens a fresh chat; an active RCA session
                // would otherwise hijack the next message into the worker's
                // session instead of starting a new one.
                setAiInitialSessionId(undefined);
                setAiPanelOpen(!aiPanelOpen);
              }}
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
              <ListTree className="h-3.5 w-3.5" /> Trace
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
              <SquareGanttChart className="h-3.5 w-3.5" /> Timeline
            </button>
            <button
              onClick={() => setViewMode("detectors")}
              className={cn(
                "flex items-center gap-2 rounded-md px-3 py-1 text-xs font-medium transition-all",
                viewMode === "detectors"
                  ? "bg-muted text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <Eye className="h-3.5 w-3.5" /> Detectors
            </button>
          </div>
        </div>

        {/* ── CONTENT AREA ── */}
        <div className="relative flex flex-1 overflow-hidden">
          {/* Top-level split: [ main content | AI assistant (optional) ]. The AI
            panel is hoisted up here so it sits beside the main content on every
            view, so it stays usable on the Detectors view too. */}
          <ResizablePanelGroup orientation="horizontal" className="h-full min-w-0">
            <ResizablePanel id="trace-main" minSize="420px" className="min-w-0 overflow-hidden">
              <ResizablePanelGroup orientation="horizontal" className="h-full min-w-0">
                {/* LEFT: tree panel */}
                <ResizablePanel
                  id="trace-tree"
                  defaultSize="32%"
                  minSize="260px"
                  maxSize="50%"
                  className="flex min-w-0 flex-col bg-muted/30"
                >
                  <div
                    className="flex flex-shrink-0 items-center border-b border-border bg-muted/10 px-3"
                    style={{ height: TREE_LAYOUT.ROW_HEIGHT }}
                  >
                    <span className="text-[11px] font-medium text-muted-foreground">
                      Trace Tree
                    </span>
                  </div>
                  <div
                    ref={treeScrollRef}
                    className="flex-1 overflow-y-auto overflow-x-hidden"
                    onScroll={handleTreeScroll}
                  >
                    {trace && (
                      <SpanTreeView
                        ref={treeViewRef}
                        trace={trace}
                        scrollRef={treeScrollRef}
                        selection={selection}
                        onSelect={viewMode === "tree" ? setSelection : handleTimelineSelect}
                        collapsedIds={collapsedIds}
                        onToggleCollapse={handleToggleCollapse}
                        compact={viewMode === "timeline"}
                        hoveredSpanId={hoveredSpanId}
                        onHoverChange={setHoveredSpanId}
                      />
                    )}
                  </div>
                </ResizablePanel>

                <ResizableHandle />

                {/* RIGHT: span details / timeline */}
                <ResizablePanel
                  id="trace-detail"
                  minSize="320px"
                  className="min-w-0 overflow-hidden border-l border-border bg-background"
                >
                  {/* Detectors fetches its own data by traceId, so it renders
                    ahead of the trace-load guards — a slow or failed *trace*
                    fetch must not hide independently-loaded detector data. */}
                  {viewMode === "detectors" ? (
                    <TraceDetectorsTab projectId={projectId} traceId={traceId} />
                  ) : isLoading ? (
                    <div className="flex h-full items-center justify-center">
                      <p className="text-sm text-muted-foreground">Loading trace...</p>
                    </div>
                  ) : error || !trace ? (
                    <div className="flex h-full items-center justify-center">
                      <p className="text-sm text-destructive">Error loading trace</p>
                    </div>
                  ) : viewMode === "tree" ? (
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
            </ResizablePanel>

            {aiPanelOpen && (
              <>
                <ResizableHandle />
                <ResizablePanel
                  id="trace-ai-chat"
                  defaultSize="31%"
                  minSize="320px"
                  maxSize="45%"
                  className="min-w-0 border-l border-border bg-background"
                >
                  <AiAssistantPanel
                    projectId={projectId}
                    compact
                    onClose={() => {
                      setAiPanelOpen(false);
                      setAiContext(null);
                      setAiInitialSessionId(undefined);
                    }}
                  />
                </ResizablePanel>
              </>
            )}
          </ResizablePanelGroup>
        </div>
      </div>
    </div>
  );
}
