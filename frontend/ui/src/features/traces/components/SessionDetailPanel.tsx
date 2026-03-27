"use client";

import { useMemo } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Layers,
  X,
  ArrowUp,
  ArrowDown,
  ExternalLink,
  Users,
  Clock,
  ChevronRight,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ExpandableSection } from "@/components/ui/expandable-section";
import { useSession } from "@/features/traces/hooks";
import { ContentRenderer } from "./ContentRenderer";
import { formatDuration, cn, buildUrlWithFilters } from "@/lib/utils";
import { toTimestampBounds } from "@/lib/date-filter";
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
          <ContentRenderer content={trace.input} />
        </ExpandableSection>
        <ExpandableSection
          title="Output"
          defaultOpen={true}
          onCopy={trace.output ? () => navigator.clipboard.writeText(trace.output!) : undefined}
        >
          <ContentRenderer content={trace.output} />
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

  const { data, isLoading, error } = useSession(projectId, sessionId, sessionQueryOptions);

  const buildUrl = (basePath: string, extraParams?: Record<string, string>) =>
    buildUrlWithFilters(basePath, { dateFilter, customStartDate, customEndDate, extraParams });

  return (
    <div className="flex h-full flex-col bg-background">
      {/* Header bar */}
      <div className="flex h-10 items-center justify-between border-b border-border bg-muted/30 px-4">
        <div className="flex items-center gap-2">
          <Layers className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="text-[13px] font-medium">{sessionId}</span>
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            className="h-6 w-6 p-0"
            onClick={() => onNavigate("up")}
            disabled={!canNavigateUp}
          >
            <ArrowUp className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 w-6 p-0"
            onClick={() => onNavigate("down")}
            disabled={!canNavigateDown}
          >
            <ArrowDown className="h-3.5 w-3.5" />
          </Button>
          <Button variant="ghost" size="sm" className="h-6 w-6 p-0" onClick={onClose}>
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {/* Session metadata - badge style matching SpanInfoPanel */}
      {data && (
        <div className="border-b border-border bg-background px-4 py-3">
          <div className="flex flex-wrap items-center gap-2">
            <div className="inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs">
              <Layers className="h-3 w-3 text-muted-foreground" />
              <span className="text-muted-foreground">Traces:</span>
              <span className="font-medium">{data.trace_count}</span>
            </div>
            {data.duration_ms !== null && data.duration_ms > 0 && (
              <div className="inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs">
                <Clock className="h-3 w-3 text-muted-foreground" />
                <span className="text-muted-foreground">Total Latency:</span>
                <span className="font-medium">{formatDuration(data.duration_ms)}</span>
              </div>
            )}
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
                  <Users className="h-3 w-3 text-muted-foreground" />
                  <span className="text-muted-foreground">User:</span>
                  <span className="font-medium">{userId}</span>
                  <ChevronRight className="h-3 w-3 text-muted-foreground" />
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Content */}
      <div className="flex-1 overflow-auto p-4">
        {isLoading ? (
          <div className="flex h-64 items-center justify-center">
            <p className="text-[13px] text-muted-foreground">Loading session...</p>
          </div>
        ) : error ? (
          <div className="flex h-64 flex-col items-center justify-center gap-3">
            <p className="text-[13px] text-destructive">Error loading session</p>
          </div>
        ) : !data ? (
          <div className="flex h-64 flex-col items-center justify-center gap-3">
            <Layers className="h-8 w-8 text-muted-foreground" />
            <p className="text-[13px] text-muted-foreground">Session not found</p>
          </div>
        ) : data.traces.length === 0 ? (
          <div className="flex h-64 flex-col items-center justify-center gap-3">
            <Layers className="h-8 w-8 text-muted-foreground" />
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
  );
}
