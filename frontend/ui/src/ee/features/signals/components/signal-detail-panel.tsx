"use client";

import { useEffect, type ReactNode } from "react";
import Link from "next/link";
import { ArrowDown, ArrowUp, ArrowUpRight, Expand, Shrink, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/ui/copy-button";
import { DOMAIN_ICONS } from "@/components/icons/domain-icons";
import { LoadingState } from "@/components/ui/loading-state";
import { MarkdownView } from "@/components/ui/markdown-view";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { TR } from "@/components/ui/table";
import { useLayout } from "@/components/layout/app-layout";
import { AiAssistantPanel } from "@/features/ai-assistant/components/ai-assistant-panel";
import { QueryWidgetRenderer } from "@/features/dashboards/components/renderers";
import { cn, formatCost, formatDate, formatDuration, formatRelativeTime } from "@/lib/utils";
import {
  rcaInProgress,
  useSignal,
  useSignalTraces,
  type SignalDetail,
  type SignalTimeRange,
} from "../hooks";
import { RunRca } from "./run-rca";
import { SignalStatusControl } from "./signal-status-control";

/**
 * One block of the panel: a titled box like ExpandableSection's, but always
 * open. `headerAction` sits at the right of the header; a block whose header
 * holds controls drops the shaded bar so they fit.
 */
function Block({
  title,
  headerAction,
  plain = false,
  children,
}: {
  title: string;
  headerAction?: ReactNode;
  plain?: boolean;
  children: ReactNode;
}) {
  return (
    <section aria-label={title} className="overflow-hidden rounded-md border border-border">
      <div
        className={cn(
          "flex items-center justify-between gap-2",
          plain ? "px-3 pt-2.5" : "border-b border-border bg-muted/50 px-2.5 py-1.5",
        )}
      >
        <h3 className="text-xs font-medium text-foreground">{title}</h3>
        {headerAction}
      </div>
      {children}
    </section>
  );
}

interface SignalDetailPanelProps {
  projectId: string;
  signalId: string;
  onClose: () => void;
  onNavigate: (direction: "up" | "down") => void;
  canNavigateUp: boolean;
  canNavigateDown: boolean;
  /** Navigate to the signal's Tracing list with this trace's detail open. */
  onOpenTrace: (traceId: string) => void;
  /** The list's time window; it sets the chart and the traces shown, not the signal. */
  range: SignalTimeRange;
  /** The list's time picker, shown again over the chart. */
  rangePicker: ReactNode;
  /** The Tracing list narrowed to this signal's traces in the window. */
  tracesHref: string;
  fullscreen: boolean;
  onToggleFullscreen: () => void;
}

/**
 * The signal opened from the Signals list: what it covers, its root cause
 * analysis, how often it happened per day, and its latest traces.
 */
/** What happened to the analysis of a reopening, in the sentence after "before the signal reopened". */
function reopeningState(state: string | null, available: boolean): string {
  // Without the key no analysis runs at all; the run control says so.
  if (!available) return "";
  if (state === null) {
    return "No new analysis ran, because the last one was less than 24 hours earlier or this detector's root cause analysis is Manual.";
  }
  if (state === "failed") return "The new analysis failed.";
  if (rcaInProgress(state)) return "A new analysis is running.";
  return "";
}

export function SignalDetailPanel({
  projectId,
  signalId,
  onClose,
  onNavigate,
  canNavigateUp,
  canNavigateDown,
  onOpenTrace,
  range,
  rangePicker,
  tracesHref,
  fullscreen,
  onToggleFullscreen,
}: SignalDetailPanelProps) {
  const { aiPanelOpen, setAiPanelOpen, setAiContext, setAiInitialSessionId, registerAiHost } =
    useLayout();
  const { data, isPending, isPlaceholderData, error } = useSignal(projectId, signalId, range);

  // Claim the AI slot for this panel, as the session panel does. On unmount,
  // also clear the AI state: otherwise aiPanelOpen stays true after this host
  // releases the slot, and the assistant reappears as the global rail panel.
  useEffect(() => {
    const release = registerAiHost();
    return () => {
      release();
      setAiPanelOpen(false);
      setAiContext(null);
      setAiInitialSessionId(undefined);
    };
  }, [registerAiHost, setAiPanelOpen, setAiContext, setAiInitialSessionId]);

  // Escape closes the panel unless a nested overlay takes the key.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) onClose();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const detail = data && !data.merged ? data : null;
  const rca = detail?.signal.canonicalRca ?? null;

  const openAgent = (sessionId?: string) => {
    setAiContext(rca?.traceId ? { traceId: rca.traceId } : null);
    setAiInitialSessionId(sessionId);
    setAiPanelOpen(true);
  };

  return (
    <div className="flex h-full flex-col bg-background">
      <div className="flex h-12 items-center justify-between gap-3 border-b border-border bg-muted/30 px-4">
        <div className="flex min-w-0 items-center gap-1.5">
          <DOMAIN_ICONS.signal className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="shrink-0 text-sm font-medium">Signal</span>
          {detail && (
            <h2 className="truncate text-sm text-muted-foreground">{detail.signal.title}</h2>
          )}
          <span className="shrink-0 font-mono text-xs text-muted-foreground">{signalId}</span>
          <CopyButton
            value={signalId}
            className="h-6 w-6 shrink-0 text-muted-foreground hover:text-foreground"
            title="Copy signal ID"
          />
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            variant="outline"
            size="sm"
            onClick={() => onNavigate("up")}
            disabled={!canNavigateUp}
            className="h-7 w-7 p-0"
            title="Previous signal"
          >
            <ArrowUp className="h-4 w-4" />
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => onNavigate("down")}
            disabled={!canNavigateDown}
            className="h-7 w-7 p-0"
            title="Next signal"
          >
            <ArrowDown className="h-4 w-4" />
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={onToggleFullscreen}
            className="h-7 w-7 p-0"
            title={fullscreen ? "Restore default size" : "Expand to full screen"}
          >
            {fullscreen ? <Shrink className="h-4 w-4" /> : <Expand className="h-4 w-4" />}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => (aiPanelOpen ? setAiPanelOpen(false) : openAgent())}
            className="ml-2 h-7 w-7 p-0"
            title="AI Assistant"
          >
            <DOMAIN_ICONS.assistant className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={onClose}
            className="h-7 w-7 p-0"
            title="Close signal"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 overflow-hidden">
        <ResizablePanelGroup orientation="horizontal" className="h-full min-w-0">
          <ResizablePanel id="signal-detail-main" minSize="320px" className="min-w-0">
            <div className="h-full space-y-3 overflow-auto p-4">
              {isPending ? (
                <div className="flex h-64 items-center justify-center">
                  <LoadingState label="Loading signal..." />
                </div>
              ) : error || !data ? (
                <p className="p-4 text-[13px] text-destructive">Error loading signal</p>
              ) : data.merged ? (
                <p className="p-4 text-[13px] text-muted-foreground">
                  This signal was merged into{" "}
                  <span className="font-mono text-[12px]">{data.mergedIntoId}</span>.
                </p>
              ) : (
                <SignalBlocks
                  refreshing={isPlaceholderData}
                  projectId={projectId}
                  detail={data}
                  rangePicker={rangePicker}
                  tracesHref={tracesHref}
                  onOpenAgent={openAgent}
                  onOpenTrace={onOpenTrace}
                />
              )}
            </div>
          </ResizablePanel>

          {aiPanelOpen && (
            <>
              <ResizableHandle />
              <ResizablePanel
                id="signal-ai-chat"
                defaultSize="33%"
                minSize="280px"
                maxSize="50%"
                className="min-w-0 bg-background"
              >
                <AiAssistantPanel
                  projectId={projectId}
                  compact
                  onClose={() => {
                    setAiPanelOpen(false);
                    setAiContext(null);
                    // The assistant clears its transcript on close. Drop the preload
                    // too so reopening the same RCA session loads its messages again.
                    setAiInitialSessionId(undefined);
                  }}
                />
              </ResizablePanel>
            </>
          )}
        </ResizablePanelGroup>
      </div>
    </div>
  );
}

function SignalBlocks({
  refreshing = false,
  projectId,
  detail,
  rangePicker,
  tracesHref,
  onOpenAgent,
  onOpenTrace,
}: {
  /** The window changed and the previous answer shows until the new one arrives. */
  refreshing?: boolean;
  projectId: string;
  detail: SignalDetail;
  rangePicker: ReactNode;
  tracesHref: string;
  onOpenAgent: (sessionId?: string) => void;
  onOpenTrace: (traceId: string) => void;
}) {
  const { signal, hits, hitSeries, window } = detail;
  const rca = signal.canonicalRca;
  // The analysis shown is of an earlier opening: the signal reopened since it ran.
  // One carried over from a merged signal (a negative sequence) is not.
  const earlier =
    rca?.result && rca.reopenSeq >= 0 && rca.reopenSeq < signal.reopenSeq ? rca : null;
  const earlierAt = earlier
    ? signal.rcaHistory.find((h) => h.reopenSeq === earlier.reopenSeq)?.createTime
    : undefined;
  // The analysis shown came with a merged signal, and hides that this signal's
  // own analysis failed or is running.
  const ownState = signal.rca.currentState;
  const mergedIn =
    !!rca?.result && rca.reopenSeq < 0 && (ownState === "failed" || rcaInProgress(ownState));
  const affected = hitSeries.reduce((sum, b) => sum + b.hits, 0);
  // The traces the signal's detector checked in the window; null when that count is unavailable.
  const total = hitSeries.some((b) => b.unaffected === null)
    ? null
    : hitSeries.reduce((sum, b) => sum + b.hits + (b.unaffected ?? 0), 0);

  return (
    <>
      <Block title="Status">
        <div className="px-3 py-2.5">
          <SignalStatusControl
            projectId={projectId}
            signalId={signal.id}
            title={signal.title}
            status={signal.status}
          />
        </div>
      </Block>

      <Block title="Summary">
        <p className="px-3 py-2.5 text-[13px] text-foreground">{signal.criteriaCovers}</p>
        {signal.criteriaValidated === false && (
          // A diagnostic only: the signal was created anyway.
          <p className="px-3 pb-2.5 text-[12px] text-muted-foreground">
            These criteria did not pass the check when the signal was created: they may not match
            its first hit, or may also match another signal&apos;s hits.
          </p>
        )}
      </Block>

      <Block
        title="Root Cause Analysis"
        headerAction={
          rca?.sessionId ? (
            <button
              type="button"
              onClick={() => onOpenAgent(rca.sessionId ?? undefined)}
              className="flex items-center gap-0.5 text-[12px] font-medium text-foreground hover:underline"
            >
              Open in agent <ArrowUpRight className="h-3 w-3" />
            </button>
          ) : undefined
        }
      >
        <div className="px-3 py-2.5">
          {rca?.result ? (
            <div className="space-y-3">
              {(earlier || mergedIn) && (
                <div className="space-y-2">
                  <p className="text-[12px] text-muted-foreground">
                    {earlier ? (
                      <>
                        This analysis is from{" "}
                        {earlierAt ? (
                          <span title={formatDate(earlierAt)}>{formatRelativeTime(earlierAt)}</span>
                        ) : (
                          "earlier"
                        )}
                        , before the signal reopened. {reopeningState(ownState, detail.grouping)}
                      </>
                    ) : (
                      <>
                        This analysis is from a signal merged into this one. This signal&apos;s own
                        analysis {ownState === "failed" ? "failed" : "is running"}.
                      </>
                    )}
                  </p>
                  <RunRca
                    projectId={projectId}
                    signalId={signal.id}
                    state={ownState}
                    available={detail.grouping}
                    showState={false}
                  />
                </div>
              )}
              <div className="rounded-md border border-border px-3 py-2">
                <MarkdownView content={rca.result} />
              </div>
            </div>
          ) : (
            <RunRca
              projectId={projectId}
              signalId={signal.id}
              state={signal.rca.currentState}
              available={detail.grouping}
            />
          )}
        </div>
      </Block>

      <Block title="Count over time" plain headerAction={rangePicker}>
        <div
          className={cn("px-3 pb-2.5 pt-1 transition-opacity", refreshing && "opacity-50")}
          aria-busy={refreshing}
        >
          <p className="pb-2 text-[13px] text-muted-foreground">
            {total !== null ? (
              <>
                <span className="font-medium text-foreground">
                  {total > 0 ? Math.round((affected / total) * 100) : 0}%
                </span>{" "}
                {affected} of {total} traces affected
              </>
            ) : (
              <>
                <span className="font-medium text-foreground">{affected}</span>{" "}
                {affected === 1 ? "trace" : "traces"} affected
              </>
            )}
          </p>
          <div className="h-72">
            <QueryWidgetRenderer
              display="area"
              agg="count"
              seriesLabel="Traces"
              result={{
                columns: ["bucket", "series", "value"],
                // b.bucket is also the x-axis key: for an hour bucket it now ends in
                // the local hour's UTC offset (e.g. "...T01:00-04:00"), so the two real
                // hours of a DST fall-back night plot as separate points instead of
                // one merged bar. QueryWidgetRenderer's hour tick format slices the
                // string to "MM-DDTHH:00" (unaffected, the offset comes after) and its
                // tooltip prints the offset verbatim, which still reads fine.
                // Affected first, so it draws at the bottom of the stack.
                rows: hitSeries.flatMap((b) =>
                  total === null
                    ? [[b.bucket, "Affected", b.hits]]
                    : [
                        [b.bucket, "Affected", b.hits],
                        [b.bucket, "Unaffected", b.unaffected ?? 0],
                      ],
                ),
                meta: { granularity: window.granularity },
              }}
            />
          </div>
        </div>
      </Block>

      <AffectedTraces
        projectId={projectId}
        hits={hits}
        refreshing={refreshing}
        viewAllHref={tracesHref}
        onOpenTrace={onOpenTrace}
      />
    </>
  );
}

/** Rows shown before "View all". */
const TRACES_SHOWN = 10;

const TH = "px-3 py-1.5 text-left text-[12px] font-medium text-muted-foreground";
const TD = "px-3 py-1.5 text-[12px]";

/**
 * The signal's latest traces in the window, as the traces list shows them; a row
 * opens the Tracing list narrowed to the signal with that trace's detail open;
 * "View all" opens the same list. While
 * a new window loads, the previous window's rows stay up, faded like the chart.
 */
function AffectedTraces({
  projectId,
  hits,
  refreshing = false,
  viewAllHref,
  onOpenTrace,
}: {
  projectId: string;
  hits: SignalDetail["hits"];
  refreshing?: boolean;
  viewAllHref: string;
  onOpenTrace: (traceId: string) => void;
}) {
  const traceIds = [...new Set(hits.map((h) => h.traceId))].slice(0, TRACES_SHOWN);
  const { data: traces, isPending } = useSignalTraces(projectId, traceIds);
  const traceStartTimes = new Map(hits.map((h) => [h.traceId, h.traceStartTime]));

  return (
    <Block
      title="Affected traces"
      plain
      headerAction={
        <Link
          href={viewAllHref}
          className="text-[12px] font-medium text-foreground hover:underline"
        >
          View all
        </Link>
      }
    >
      <div className={cn("transition-opacity", refreshing && "opacity-50")} aria-busy={refreshing}>
        {traceIds.length === 0 ? (
          <p className="px-3 py-2.5 text-[12px] text-muted-foreground">
            No traces in this time range.
          </p>
        ) : (
          <table className="w-full">
            <thead>
              <tr className="border-b border-border/50">
                <th className={TH}>Timestamp</th>
                <th className={TH}>Name</th>
                <th className={TH}>Errors</th>
                <th className={TH}>Cost</th>
                <th className={TH}>Latency</th>
              </tr>
            </thead>
            <tbody>
              {traceIds.map((traceId) => {
                const t = traces?.get(traceId);
                const pending = isPending ? "…" : "-";
                return (
                  <TR key={traceId} interactive onClick={() => onOpenTrace(traceId)}>
                    <td className={cn(TD, "whitespace-nowrap text-muted-foreground")}>
                      {formatDate(t?.trace_start_time ?? traceStartTimes.get(traceId))}
                    </td>
                    <td className={cn(TD, "text-foreground")}>
                      {t?.name || (
                        <span className="font-mono text-[11px] text-muted-foreground">
                          {traceId}
                        </span>
                      )}
                    </td>
                    <td className={TD}>
                      {!t ? (
                        <span className="text-muted-foreground">{pending}</span>
                      ) : t.error_count > 0 ? (
                        <span className="inline-flex min-w-5 justify-center rounded bg-red-100 px-1.5 py-0.5 text-[10px] font-medium text-red-700 dark:bg-red-950 dark:text-red-400">
                          {t.error_count}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">0</span>
                      )}
                    </td>
                    <td className={cn(TD, "text-muted-foreground")}>
                      {t?.total_cost != null ? formatCost(t.total_cost) : pending}
                    </td>
                    <td className={cn(TD, "text-muted-foreground")}>
                      {t ? formatDuration(t.duration_ms) : pending}
                    </td>
                  </TR>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </Block>
  );
}
