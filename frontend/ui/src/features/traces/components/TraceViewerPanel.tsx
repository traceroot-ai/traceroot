"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  X,
  ArrowUp,
  ArrowDown,
  ListTree,
  SquareGanttChart,
  Expand,
  Shrink,
  SquareArrowOutUpRight,
  GitCompare,
} from "lucide-react";
import type { ReactNode } from "react";
import { cn, buildUrlWithFilters, parseAsUTC } from "@/lib/utils";
import { DOMAIN_ICONS } from "@/components/icons/domain-icons";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/ui/copy-button";
import { LoadingState } from "@/components/ui/loading-state";
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from "@/components/ui/resizable";
import { getTrace } from "@/lib/api";
import type { Span, TraceDetail } from "@/types/api";
import { ApiError } from "@/lib/api/errors";
import type { TraceSelection } from "../types";
import { SpanTreeView, type SpanTreeViewHandle } from "./SpanTreeView";
import { SpanInfoPanel } from "./SpanInfoPanel";
import { useLayout } from "@/components/layout/app-layout";
import { AiAssistantPanel } from "@/features/ai-assistant/components/ai-assistant-panel";
import { useTraceStream } from "../hooks/use-trace-stream";
import { traceQueryKey } from "../hooks";
import { SpanTimelineView } from "./SpanTimelineView";
import { TREE_LAYOUT } from "../utils";
import { useTraceFindings, useRca } from "@/features/detectors/hooks/use-findings";
import { TraceDetectorsTab } from "./TraceDetectorsTab";
import { isRetentionError, getRetentionDetail } from "@/lib/api/retention";
import { RetentionGateBanner } from "@/components/RetentionGateBanner";

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
   * When provided, this trace is used directly instead of fetching it, and the
   * live SSE stream + detector-findings lookups are disabled. Lets the
   * offline-eval surface render the genuine viewer from provided data.
   * Unset in production.
   */
  traceOverride?: TraceDetail;
  /**
   * Optional action bar for the span detail panel, computed per selection —
   * e.g. offline-eval's "Save as test case" / "Review". Return null to hide it
   * (e.g. at trace level). Unset in production.
   */
  spanActions?: (selection: TraceSelection) => ReactNode;
  /**
   * Optional action for the span panel's header title row, computed per
   * selection — e.g. offline-eval's "Save as test case". Unset in production.
   */
  spanHeaderAction?: (selection: TraceSelection) => ReactNode;
  /**
   * Optional extra chips for the span panel's badge row, computed per selection
   * — e.g. offline-eval's "Dataset:" chip. Unset in production.
   */
  spanExtraTags?: (selection: TraceSelection) => ReactNode;
  /**
   * Notified whenever the selected span (or the trace root) changes, so an open
   * side panel can follow the tree — e.g. offline-eval's "Save as test case"
   * drawer tracking the clicked span. Unset in production.
   */
  onSelectionChange?: (selection: TraceSelection) => void;
  /**
   * Diff mode (offline-eval only): the baseline run's trace plus a matcher that
   * resolves the baseline counterpart of a span selection (matched structurally,
   * since span ids differ across runs). When provided, a "Diff" toggle appears in
   * the sub-header; turning it on renders latency/token/cost tags with ± deltas and
   * Input/Output/Metadata as git-style line diffs vs the baseline — for the whole
   * trace (root row) as well as each span. Unset in production.
   */
  diffBaseline?: {
    trace: TraceDetail;
    matchSpan: (selection: TraceSelection) => Span | null;
  };
  /**
   * Replaces the main header's "Trace" label + trace id (offline-eval), so an
   * evaluation trace leads with its test case (e.g. label "Test case", value the
   * test-case id). Unset in production, where the header shows "Trace" + traceId.
   */
  headerIdentity?: { label: string; value: string };
  /**
   * A badge rendered in the main header, immediately left of the navigation
   * buttons — the same spot the findings "Alert" tag uses. offline-eval puts the
   * test case's outcome (Passed / Did not pass / Errored) here. Unset in production.
   */
  headerStatus?: ReactNode;
  /**
   * Open the panel with diff mode already on (offline-eval compare-with). Only has an
   * effect once `diffBaseline` is supplied — the toggle stays user-controllable after.
   */
  defaultDiffOn?: boolean;
  /** Reverse the diff direction (Output → Baseline in the run-detail Diff dropdown). */
  diffFlip?: boolean;
  /**
   * Scope the trace fetch: "detector" opens a detector self-trace (excluded
   * from normal reads), "user" excludes self-traces. Omit for no scoping.
   */
  source?: "detector" | "user";
  /**
   * ISO timestamp of the detector run being viewed. Bounds how long a missing
   * self-trace still reads as "being recorded" — see
   * SELF_TRACE_PENDING_WINDOW_MS. Omit when unknown.
   */
  runTimestamp?: string;
}

/**
 * How long a detector self-trace may legitimately be missing. The SDK batches
 * exports on a 5s delay with a 30s export timeout, so ~35s plus ingest lag is
 * the worst case for a trace that is genuinely still on its way. Past this
 * window a miss means the export failed for good, not that it is pending.
 */
const SELF_TRACE_PENDING_WINDOW_MS = 60_000;

/**
 * Whether a missing self-trace is still plausibly in flight. An unknown run
 * time (absent or unparseable) stays "pending": not knowing when the run
 * started is no evidence that its export failed.
 */
function isSelfTracePending(runTimestamp: string | undefined): boolean {
  if (!runTimestamp) return true;
  // parseAsUTC, not new Date(): the runs endpoint serializes a ClickHouse DateTime64
  // with no timezone marker, and bare Date() would read that as local time — shifting
  // the window by the viewer's offset and accusing a healthy in-flight export of
  // having failed everywhere east of UTC.
  const startedAt = parseAsUTC(runTimestamp).getTime();
  return Number.isNaN(startedAt) || Date.now() - startedAt < SELF_TRACE_PENDING_WINDOW_MS;
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
  traceOverride,
  spanActions,
  spanHeaderAction,
  spanExtraTags,
  onSelectionChange,
  diffBaseline,
  headerIdentity,
  headerStatus,
  defaultDiffOn,
  diffFlip = false,
  source,
  runTimestamp,
}: TraceViewerPanelProps) {
  const [selection, setSelection] = useState<TraceSelection>({ type: "trace" });
  // Diff mode is opt-in per panel (offline-eval only); the toggle only appears
  // when a baseline matcher is supplied. Persists across ↑/↓ navigation like
  // fullscreen, since the panel instance stays mounted.
  const [diffMode, setDiffMode] = useState(defaultDiffOn ?? false);
  // `defaultDiffOn` is the caller's diff switch (offline-eval's header Diff toggle). Follow
  // it both ways so flipping the toggle live-updates an already-open panel; the in-panel
  // toggle still overrides until the caller's switch next changes.
  useEffect(() => {
    setDiffMode(defaultDiffOn ?? false);
  }, [defaultDiffOn]);
  // Emit selection changes to the parent (kept in a ref so an inline callback
  // doesn't retrigger the effect — it fires only when `selection` actually changes).
  const onSelectionChangeRef = useRef(onSelectionChange);
  onSelectionChangeRef.current = onSelectionChange;
  useEffect(() => {
    onSelectionChangeRef.current?.(selection);
  }, [selection]);
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
  // With an override we render hardcoded data and touch no network: disable the
  // findings lookup (empty id), the trace fetch, and the live SSE stream.
  const { data: traceFindingsData } = useTraceFindings(projectId, traceOverride ? "" : traceId);
  const traceFinding = traceFindingsData?.findings?.[0];
  const { data: rcaData } = useRca(projectId, traceFinding?.finding_id ?? "");
  const hasRca = !!traceFinding && !!rcaData?.rca;
  const rcaSessionId = rcaData?.rca?.sessionId ?? undefined;

  // Auto-open chat with RCA session loaded when arriving from /detectors.
  // Waits for rcaSessionId so the chat opens already pointing at the session,
  // avoiding a fresh-chat flash before the id resolves.
  useEffect(() => {
    if (!autoOpenRca || !rcaSessionId) return;
    setAiContext(traceOverride ? null : { traceId });
    setAiInitialSessionId(rcaSessionId);
    setAiPanelOpen(true);
  }, [
    autoOpenRca,
    rcaSessionId,
    traceId,
    traceOverride,
    setAiContext,
    setAiInitialSessionId,
    setAiPanelOpen,
  ]);

  const {
    data: fetchedTrace,
    isLoading: isFetching,
    error,
  } = useQuery({
    queryKey: traceQueryKey(projectId, traceId, source),
    queryFn: () => getTrace(projectId, traceId, "", undefined, source),
    enabled: !traceOverride,
  });
  const trace = traceOverride ?? fetchedTrace;
  const isLoading = traceOverride ? false : isFetching;

  // source must match the query key above, or SSE span merging silently no-ops.
  useTraceStream(projectId, traceId, !traceOverride, source);

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
          <div className="flex min-w-0 items-center gap-1.5">
            <DOMAIN_ICONS.trace className="h-4 w-4 shrink-0 text-muted-foreground" />
            <span className="shrink-0 text-sm font-medium">{headerIdentity?.label ?? "Trace"}</span>
            <span className="truncate font-mono text-xs text-muted-foreground">
              {headerIdentity?.value ?? traceId}
            </span>
            {/* Copy affordance for the header id. Only offered when an identity is
                supplied (offline-eval's test case); the standard trace header is
                unchanged. */}
            {headerIdentity && (
              <CopyButton
                value={headerIdentity.value}
                className="h-6 w-6 shrink-0 text-muted-foreground hover:text-foreground"
                title={`Copy ${headerIdentity.label.toLowerCase()} id`}
              />
            )}
          </div>
          <div className="flex items-center gap-1">
            {headerStatus}
            {hasRca && (
              <button
                type="button"
                onClick={() => {
                  setAiContext(traceOverride ? null : { traceId });
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
            {/* Hidden under an override: traceId is the synthetic eval-<resultId>,
                which nothing downstream can resolve from a URL. */}
            {!traceOverride && (
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  window.open(
                    buildUrlWithFilters(newTabPath ?? `/projects/${projectId}/traces`, {
                      dateFilter,
                      customStartDate,
                      customEndDate,
                      // A self-trace's id matches no list row's trace_id, so the
                      // receiving page needs the source to reopen it as a
                      // self-trace instead of looking it up as an original.
                      extraParams:
                        source === "detector"
                          ? { traceId, fullscreen: "1", source }
                          : { traceId, fullscreen: "1" },
                    }),
                    "_blank",
                  )
                }
                className="h-7 w-7 p-0"
                title="Open in new tab"
              >
                <SquareArrowOutUpRight className="h-4 w-4" />
              </Button>
            )}
            <div className="w-2" />
            {/* AI Assistant sits immediately left of Close, separated by a gap
                from the navigation/view controls, so the agent button stays the
                rightmost action regardless of the other header controls. */}
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setAiContext(traceOverride ? null : { traceId });
                // Bot button always opens a fresh chat; an active RCA session
                // would otherwise hijack the next message into the worker's
                // session instead of starting a new one.
                setAiInitialSessionId(undefined);
                setAiPanelOpen(!aiPanelOpen);
              }}
              className="h-7 w-7 p-0"
              title="AI Assistant"
            >
              <DOMAIN_ICONS.assistant className="h-4 w-4" />
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
            {/* Detectors fetch by traceId, which under an override is the synthetic
                eval-<resultId> — no ClickHouse row can ever back it, so the tab is
                hidden rather than firing a doomed request. */}
            {!traceOverride && (
              <button
                onClick={() => setViewMode("detectors")}
                className={cn(
                  "flex items-center gap-2 rounded-md px-3 py-1 text-xs font-medium transition-all",
                  viewMode === "detectors"
                    ? "bg-muted text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                <DOMAIN_ICONS.detector className="h-3.5 w-3.5" /> Detectors
              </button>
            )}
          </div>
          {/* Diff toggle — only when a baseline is available (offline-eval). */}
          {diffBaseline && viewMode === "tree" && (
            <div className="ml-auto pr-3">
              <button
                onClick={() => setDiffMode((v) => !v)}
                className={cn(
                  "flex items-center gap-2 rounded-md px-3 py-1 text-xs font-medium transition-all",
                  diffMode
                    ? "bg-muted text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
                title="Diff each span's input, output, metadata and metrics against the baseline run"
              >
                <GitCompare className="h-3.5 w-3.5" /> Diff
              </button>
            </div>
          )}
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
                        disableIOPrefetch={!!traceOverride}
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
                  {viewMode === "detectors" && !traceOverride ? (
                    <TraceDetectorsTab projectId={projectId} traceId={traceId} />
                  ) : isLoading ? (
                    <div className="flex h-full items-center justify-center">
                      <LoadingState label="Loading trace..." />
                    </div>
                  ) : error && isRetentionError(error) ? (
                    <RetentionGateBanner
                      projectId={projectId}
                      detail={getRetentionDetail(error)!}
                    />
                  ) : error || !trace ? (
                    <div className="flex h-full items-center justify-center">
                      {source === "detector" &&
                      (!error || (error instanceof ApiError && error.status === 404)) ? (
                        // self_traced is set optimistically at emit time, but the
                        // SDK export is batched — the trace may not be ingested
                        // yet, so a 404 miss here is expected, not an error. A
                        // non-404 failure still surfaces as a real error below.
                        // Once the export window has passed, the stamp is stale:
                        // the export failed and nothing will arrive, so say so
                        // instead of telling the user to keep waiting.
                        isSelfTracePending(runTimestamp) ? (
                          <p className="text-sm text-muted-foreground">
                            This detector run&rsquo;s trace is still being recorded. Check back in a
                            moment.
                          </p>
                        ) : (
                          <p className="text-sm text-muted-foreground">
                            No trace was recorded for this run — the self-trace export didn&rsquo;t
                            reach the backend.
                          </p>
                        )
                      ) : (
                        <p className="text-sm text-destructive">Error loading trace</p>
                      )}
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
                      spanActions={spanActions?.(selection)}
                      headerAction={spanHeaderAction?.(selection)}
                      extraTags={spanExtraTags?.(selection)}
                      diffMode={!!diffBaseline && diffMode}
                      diffFlip={diffFlip}
                      baselineSpan={diffBaseline?.matchSpan(selection) ?? null}
                      baselineTrace={diffBaseline?.trace ?? null}
                      isEvalShaped={!!traceOverride}
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
