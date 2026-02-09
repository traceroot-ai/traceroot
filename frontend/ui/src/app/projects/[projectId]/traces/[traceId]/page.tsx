"use client";

import { useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, Clock, Cpu, DollarSign } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ProjectBreadcrumb } from "@/features/projects/components";
import { formatDuration, formatDate, cn } from "@/lib/utils";
import type { Span, TraceDetail } from "@/types/api";
import { useTrace } from "@/features/traces/hooks";
import { SpanKindBadge } from "@/features/traces/components";
import {
  buildSpanTree,
  getSpanDuration,
  getTraceDuration,
  TREE_LAYOUT,
} from "@/features/traces/utils";
import type { TraceSelection } from "@/features/traces/types";

const NESTING_INDENT = 20;

// L-shaped connector component
function TreeEdge({
  level,
  isTerminal,
  parentLevels,
}: {
  level: number;
  isTerminal: boolean;
  parentLevels: number[];
}) {
  if (level === 0) return null;

  return (
    <div className="flex h-9" style={{ width: level * NESTING_INDENT }}>
      {Array.from({ length: level }).map((_, i) => {
        const showContinuingLine = parentLevels.includes(i);
        const isCurrentLevel = i === level - 1;

        return (
          <div key={i} className="relative" style={{ width: NESTING_INDENT }}>
            {showContinuingLine && (
              <div
                className="absolute bottom-0 top-0 w-px bg-border"
                style={{ left: NESTING_INDENT / 2 }}
              />
            )}
            {isCurrentLevel && (
              <div
                className={cn(
                  "absolute border-b border-l border-border",
                  isTerminal ? "top-0 h-[18px]" : "bottom-0 top-0",
                )}
                style={{
                  left: NESTING_INDENT / 2,
                  width: NESTING_INDENT / 2,
                }}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

function FullPageTreeView({
  trace,
  selection,
  onSelect,
}: {
  trace: TraceDetail;
  selection: TraceSelection;
  onSelect: (selection: TraceSelection) => void;
}) {
  const spanRows = buildSpanTree(trace.spans);
  const isTraceSelected = selection.type === "trace";
  const traceDuration = getTraceDuration(trace);

  return (
    <div className="text-sm">
      {/* Trace node at top */}
      <div
        className={cn(
          "flex cursor-pointer items-center transition-all duration-200",
          isTraceSelected
            ? "border-l-2 border-l-primary bg-muted"
            : "border-l-2 border-l-transparent hover:bg-muted/50",
        )}
        onClick={() => onSelect({ type: "trace" })}
      >
        <div className="flex min-w-0 flex-1 items-center gap-2 px-3 py-2">
          <SpanKindBadge kind="trace" />
          <span
            className={cn(
              "flex-1 truncate",
              isTraceSelected ? "font-semibold text-foreground" : "font-medium text-foreground/80",
            )}
          >
            {trace.name}
          </span>
          <span className="whitespace-nowrap text-xs text-muted-foreground">
            {formatDuration(traceDuration)}
          </span>
        </div>
      </div>

      {/* Span rows */}
      {spanRows.map(({ span, level, isTerminal, parentLevels }) => {
        const isSelected = selection.type === "span" && selection.span.span_id === span.span_id;
        const adjustedLevel = level + 1;
        const adjustedParentLevels = parentLevels.map((l) => l + 1);

        return (
          <div
            key={span.span_id}
            className={cn(
              "flex cursor-pointer items-center transition-all duration-200",
              isSelected
                ? "border-l-2 border-l-foreground bg-muted"
                : "border-l-2 border-l-transparent hover:bg-muted/50",
            )}
            onClick={() => onSelect({ type: "span", span })}
          >
            <TreeEdge
              level={adjustedLevel}
              isTerminal={isTerminal}
              parentLevels={adjustedParentLevels}
            />
            <div className="flex min-w-0 flex-1 items-center gap-2 py-2 pr-3">
              <SpanKindBadge kind={span.span_kind} />
              <span
                className={cn(
                  "flex-1 truncate",
                  isSelected ? "font-semibold text-foreground" : "font-medium text-foreground/80",
                )}
              >
                {span.name}
              </span>
              <span className="whitespace-nowrap text-xs text-muted-foreground">
                {formatDuration(getSpanDuration(span))}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function TraceInfoPanel({ trace }: { trace: TraceDetail }) {
  const durationMs = getTraceDuration(trace);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex items-center gap-1.5 rounded bg-muted px-2.5 py-1 text-sm">
          <Clock className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="text-muted-foreground">Latency:</span>
          <span className="font-medium text-foreground">{formatDuration(durationMs)}</span>
        </div>
        {trace.environment && (
          <div className="inline-flex items-center gap-1.5 rounded bg-muted px-2.5 py-1 text-sm">
            <span className="text-muted-foreground">Env:</span>
            <span className="font-medium text-foreground">{trace.environment}</span>
          </div>
        )}
        {trace.user_id && (
          <div className="inline-flex items-center gap-1.5 rounded bg-muted px-2.5 py-1 text-sm">
            <span className="text-muted-foreground">User:</span>
            <span className="font-medium text-foreground">{trace.user_id}</span>
          </div>
        )}
        {trace.session_id && (
          <div className="inline-flex items-center gap-1.5 rounded bg-muted px-2.5 py-1 text-sm">
            <span className="text-muted-foreground">Session:</span>
            <span className="font-medium text-foreground">{trace.session_id}</span>
          </div>
        )}
      </div>

      {trace.input && (
        <div>
          <h4 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Input
          </h4>
          <div className="rounded border border-border bg-muted/50 p-4">
            <pre className="whitespace-pre-wrap break-words text-sm text-foreground">
              {trace.input}
            </pre>
          </div>
        </div>
      )}

      {trace.output && (
        <div>
          <h4 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Output
          </h4>
          <div className="rounded border border-border bg-muted/50 p-4">
            <pre className="whitespace-pre-wrap break-words text-sm text-foreground">
              {trace.output}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}

function SpanInfoPanel({ span }: { span: Span }) {
  const durationMs = getSpanDuration(span);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex items-center gap-1.5 rounded bg-muted px-2.5 py-1 text-sm">
          <Clock className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="text-muted-foreground">Latency:</span>
          <span className="font-medium text-foreground">{formatDuration(durationMs)}</span>
        </div>
        {span.model_name && (
          <div className="inline-flex items-center gap-1.5 rounded bg-muted px-2.5 py-1 text-sm">
            <Cpu className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="font-medium text-foreground">{span.model_name}</span>
          </div>
        )}
        {span.cost !== null && span.cost > 0 && (
          <div className="inline-flex items-center gap-1.5 rounded bg-muted px-2.5 py-1 text-sm">
            <DollarSign className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="font-medium text-foreground">${span.cost.toFixed(4)}</span>
          </div>
        )}
        <div
          className={cn(
            "ml-auto inline-flex items-center rounded px-2 py-0.5 text-xs font-medium uppercase",
            span.status === "ERROR"
              ? "bg-destructive/10 text-destructive"
              : "bg-green-500/10 text-green-600 dark:text-green-400",
          )}
        >
          {span.status}
        </div>
      </div>

      {span.input && (
        <div>
          <h4 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Input
          </h4>
          <div className="rounded border border-border bg-muted/50 p-4">
            <pre className="whitespace-pre-wrap break-words text-sm text-foreground">
              {span.input}
            </pre>
          </div>
        </div>
      )}

      {span.output && (
        <div>
          <h4 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Output
          </h4>
          <div className="rounded border border-border bg-muted/50 p-4">
            <pre className="whitespace-pre-wrap break-words text-sm text-foreground">
              {span.output}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}

export default function TraceDetailPage() {
  const params = useParams();
  const projectId = params.projectId as string;
  const traceId = params.traceId as string;
  const [selection, setSelection] = useState<TraceSelection>({ type: "trace" });

  const { data: trace, isLoading, error } = useTrace(projectId, traceId);

  if (isLoading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <p className="text-muted-foreground">Loading trace...</p>
      </div>
    );
  }

  if (error || !trace) {
    return (
      <div className="flex h-64 items-center justify-center">
        <p className="text-destructive">Error loading trace</p>
      </div>
    );
  }

  const durationMs = getTraceDuration(trace);

  return (
    <div className="min-h-screen bg-background p-6">
      <ProjectBreadcrumb projectId={projectId} current={trace.name} />

      {/* Header */}
      <div className="mb-4">
        <Link href={`/projects/${projectId}/traces`}>
          <Button
            variant="ghost"
            size="sm"
            className="-ml-2 mb-2 text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back to traces
          </Button>
        </Link>

        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-xl font-bold text-foreground">{trace.name}</h2>
            <p className="text-sm text-muted-foreground">
              {formatDate(trace.trace_start_time)} • {formatDuration(durationMs)}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {trace.environment && (
              <span className="inline-flex items-center rounded bg-muted px-2 py-1 text-xs font-medium text-muted-foreground">
                {trace.environment}
              </span>
            )}
            {trace.release && (
              <span className="inline-flex items-center rounded bg-muted px-2 py-1 text-xs font-medium text-muted-foreground">
                {trace.release}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="flex items-start gap-4">
        {/* Trace/Span tree */}
        <div className="w-[340px] flex-shrink-0 rounded-lg border border-border bg-background">
          <div className="border-b border-border px-4 py-3">
            <h3 className="font-semibold text-foreground">Trace & Spans ({trace.spans.length})</h3>
          </div>
          <div className="max-h-[calc(100vh-240px)] overflow-y-auto">
            <FullPageTreeView trace={trace} selection={selection} onSelect={setSelection} />
          </div>
        </div>

        {/* Detail panel */}
        <div className="min-w-0 flex-1 rounded-lg border border-border bg-background">
          <div className="flex items-center gap-3 border-b border-border px-4 py-3">
            {selection.type === "trace" ? (
              <>
                <SpanKindBadge kind="trace" />
                <h3 className="truncate font-semibold text-foreground">{trace.name}</h3>
              </>
            ) : (
              <>
                <SpanKindBadge kind={selection.span.span_kind} />
                <h3 className="truncate font-semibold text-foreground">{selection.span.name}</h3>
              </>
            )}
          </div>
          <div className="max-h-[calc(100vh-240px)] overflow-y-auto p-4">
            {selection.type === "trace" ? (
              <TraceInfoPanel trace={trace} />
            ) : (
              <SpanInfoPanel span={selection.span} />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
