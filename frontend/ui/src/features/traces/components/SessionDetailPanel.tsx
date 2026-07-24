"use client";

import { useMemo, useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { X, ArrowUp, ArrowDown, ExternalLink, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DOMAIN_ICONS } from "@/components/icons/domain-icons";
import { LoadingState } from "@/components/ui/loading-state";
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from "@/components/ui/resizable";
import { ExpandableSection } from "@/components/ui/expandable-section";
import { useSession } from "@/features/traces/hooks";
import { useSession as useAuthSession } from "@/lib/auth-client";
import { ContentRenderer } from "./ContentRenderer";
import { formatDuration, formatCost, buildUrlWithFilters } from "@/lib/utils";
import { toTimestampBounds } from "@/lib/date-filter";
import { useLayout } from "@/components/layout/app-layout";
import { AiAssistantPanel } from "@/features/ai-assistant/components/ai-assistant-panel";
import type { SessionTraceItem } from "@/types/api";

interface SessionDetailPanelProps {
  projectId: string;
  sessionId: string;
  onClose: () => void;
  onNavigate: (direction: "up" | "down") => void;
  canNavigateUp: boolean;
  canNavigateDown: boolean;
  dateFilter?: { id: string; isCustom?: boolean };
  customStartDate?: Date | null;
  customEndDate?: Date | null;
}

function TraceCard({
  trace,
  index,
  traceUrl,
}: {
  trace: SessionTraceItem;
  index: number;
  traceUrl: string;
}) {
  return (
    <div className="rounded-md border border-border">
      {/* Header: trace link */}
      <div className="flex items-center justify-between border-b border-border/50 bg-muted/30 px-4 py-2">
        <div className="flex items-center gap-2 text-[12px]">
          <span className="text-muted-foreground">#{index + 1}</span>
          <Link href={traceUrl} className="font-medium text-foreground hover:underline">
            {trace.name}
            <span className="ml-1 font-mono text-[11px] text-muted-foreground">
              {trace.trace_id}
            </span>
            <ExternalLink className="ml-1 inline h-3 w-3 text-muted-foreground" />
          </Link>
        </div>
      </div>

      {/* Content: Input/Output */}
      <div className="space-y-3 p-4">
        <ExpandableSection
          title="Input"
          defaultOpen={true}
          onCopy={trace.input ? () => navigator.clipboard.writeText(trace.input!) : undefined}
        >
          <ContentRenderer key={trace.trace_id} content={trace.input} />
        </ExpandableSection>
        <ExpandableSection
          title="Output"
          defaultOpen={true}
          onCopy={trace.output ? () => navigator.clipboard.writeText(trace.output!) : undefined}
        >
          <ContentRenderer key={trace.trace_id} content={trace.output} />
        </ExpandableSection>
      </div>
    </div>
  );
}

export function SessionDetailPanel({
  projectId,
  sessionId,
  onClose,
  onNavigate,
  canNavigateUp,
  canNavigateDown,
  dateFilter,
  customStartDate,
  customEndDate,
}: SessionDetailPanelProps) {
  const router = useRouter();
  const { aiPanelOpen, setAiPanelOpen, setAiContext, registerAiHost } = useLayout();
  const { isPending: authPending } = useAuthSession();

  // Claim the AI slot for this viewer so AppLayout's project rail steps aside.
  // `registerAiHost()` returns its own cleanup, which we return from the effect
  // so React runs it on unmount and the rail comes back.
  useEffect(() => {
    return registerAiHost();
  }, [registerAiHost]);

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

  // Compute timestamps from date filter props
  const sessionQueryOptions = useMemo(() => {
    if (!dateFilter) return {};
    const timestamps = toTimestampBounds(
      dateFilter.id,
      customStartDate ?? undefined,
      customEndDate ?? undefined,
    );
    return {
      start_after: timestamps.startAfter,
      end_before: timestamps.endBefore,
    };
  }, [dateFilter, customStartDate, customEndDate]);

  const {
    data,
    isPending: dataPending,
    error,
  } = useSession(projectId, sessionId, sessionQueryOptions);
  // Auth-gated React Query reports isLoading: false while disabled (TanStack v5).
  // Use isPending OR'd with auth pending so the loading branch shows during the
  // auth-resolution window instead of falling through to "Session not found".
  const checking = authPending || dataPending;

  const buildUrl = (basePath: string, extraParams?: Record<string, string>) =>
    buildUrlWithFilters(basePath, { dateFilter, customStartDate, customEndDate, extraParams });

  const _rawTokens = data ? (data.total_input_tokens ?? 0) + (data.total_output_tokens ?? 0) : 0;
  const totalTokenCount = _rawTokens > 0 ? _rawTokens : null;

  const totalCost = data ? (data.total_cost ?? null) : null;

  return (
    <div className="flex h-full flex-col bg-background">
      {/* Header bar */}
      <div className="flex h-10 items-center justify-between border-b border-border bg-muted/30 px-4">
        <div className="flex min-w-0 items-center gap-2">
          <DOMAIN_ICONS.session className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-medium">Session</span>
          <span className="truncate font-mono text-xs text-muted-foreground">{sessionId}</span>
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="sm"
            onClick={() => onNavigate("up")}
            disabled={!canNavigateUp}
            className="h-7 w-7 p-0"
            title="Previous session"
          >
            <ArrowUp className="h-4 w-4" />
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => onNavigate("down")}
            disabled={!canNavigateDown}
            className="h-7 w-7 p-0"
            title="Next session"
          >
            <ArrowDown className="h-4 w-4" />
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setAiContext({
                traceId: data?.traces[0]?.trace_id,
                traceSessionId: sessionId,
              });
              setAiPanelOpen(!aiPanelOpen);
            }}
            className="ml-2 h-7 w-7 p-0"
            title="AI Assistant"
          >
            <DOMAIN_ICONS.assistant className="h-4 w-4" />
          </Button>
          <Button variant="ghost" size="sm" onClick={onClose} className="h-7 w-7 p-0">
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Content: session detail + optional AI ResizablePanel split (#881) */}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <ResizablePanelGroup orientation="horizontal" className="h-full min-w-0">
          <ResizablePanel
            id="session-detail-main"
            minSize="320px"
            className="min-w-0 overflow-hidden"
          >
            <div className="flex h-full flex-col overflow-hidden">
              {/* Session metadata badges */}
              {data && (
                <div className="border-b border-border bg-background px-4 py-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <div className="inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs">
                      <DOMAIN_ICONS.session className="h-3 w-3 text-muted-foreground" />
                      <span className="text-muted-foreground">Traces:</span>
                      <span className="font-medium">{data.trace_count}</span>
                    </div>
                    {data.duration_ms !== null && data.duration_ms > 0 && (
                      <div className="inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs">
                        <DOMAIN_ICONS.latency className="h-3 w-3 text-muted-foreground" />
                        <span className="text-muted-foreground">Total Latency:</span>
                        <span className="font-medium">{formatDuration(data.duration_ms)}</span>
                      </div>
                    )}
                    <div className="inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs">
                      <span className="text-muted-foreground">Total Tokens:</span>
                      <span className="font-medium">
                        {totalTokenCount?.toLocaleString() ?? "-"}
                      </span>
                    </div>
                    <div className="inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs">
                      <span className="text-muted-foreground">Cost:</span>
                      <span className="font-medium">{formatCost(totalCost)}</span>
                    </div>
                  </div>
                  {data.user_ids.length > 0 && (
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      {data.user_ids.map((userId) => (
                        <button
                          key={userId}
                          type="button"
                          onClick={() => {
                            onClose();
                            router.push(
                              buildUrl(`/projects/${projectId}/traces`, {
                                user_id: userId,
                              }),
                            );
                          }}
                          className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border bg-muted/40 py-1 pl-2.5 pr-1.5 text-xs transition-colors hover:bg-muted"
                        >
                          <DOMAIN_ICONS.user className="h-3 w-3 text-muted-foreground" />
                          <span className="text-muted-foreground">User:</span>
                          <span className="font-medium">{userId}</span>
                          <ChevronRight className="h-3 w-3 text-muted-foreground" />
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* Trace list */}
              <div className="flex-1 overflow-auto p-4">
                {checking ? (
                  <div className="flex h-64 items-center justify-center">
                    <LoadingState label="Loading session..." />
                  </div>
                ) : error ? (
                  <div className="flex h-64 flex-col items-center justify-center gap-3">
                    <p className="text-[13px] text-destructive">Error loading session</p>
                  </div>
                ) : !data ? (
                  <div className="flex h-64 flex-col items-center justify-center gap-3">
                    <DOMAIN_ICONS.session className="h-8 w-8 text-muted-foreground" />
                    <p className="text-[13px] text-muted-foreground">Session not found</p>
                  </div>
                ) : data.traces.length === 0 ? (
                  <div className="flex h-64 flex-col items-center justify-center gap-3">
                    <DOMAIN_ICONS.session className="h-8 w-8 text-muted-foreground" />
                    <p className="text-[13px] text-muted-foreground">No traces in this session</p>
                  </div>
                ) : (
                  <div className="space-y-3">
                    {data.traces.map((trace: SessionTraceItem, index: number) => (
                      <TraceCard
                        key={trace.trace_id}
                        trace={trace}
                        index={index}
                        traceUrl={buildUrl(`/projects/${projectId}/traces`, {
                          traceId: trace.trace_id,
                        })}
                      />
                    ))}
                  </div>
                )}
              </div>
            </div>
          </ResizablePanel>

          {aiPanelOpen && (
            <>
              <ResizableHandle />
              <ResizablePanel
                id="session-ai-chat"
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
