"use client";

import { useRouter } from "next/navigation";
import {
  Clock,
  Users,
  Layers,
  ChevronRight,
  AlertCircle,
  GitBranch,
  GitCommitHorizontal,
  FileCode,
  Loader2,
} from "lucide-react";
import { CopyButton } from "@/components/ui/copy-button";
import { formatDuration, formatDate, buildUrlWithFilters } from "@/lib/utils";
import { TokenChip } from "./TokenChip";
import { CostChip } from "./CostChip";
import { SpanStatus } from "@traceroot/core";
import type { TraceDetail, Span } from "@/types/api";
import type { TraceSelection } from "../types";
import {
  getSpanDuration,
  getTraceDuration,
  getTraceTotalCost,
  getTraceTokenUsage,
  getTraceCostBreakdown,
} from "../utils";
import { SpanKindIcon } from "./SpanKindIcon";
import { ContentRenderer } from "./ContentRenderer";
import { ExpandableSection } from "@/components/ui/expandable-section";
import { useSpanIO } from "../hooks";

interface SpanInfoPanelProps {
  projectId: string;
  trace: TraceDetail;
  selection: TraceSelection;
  onClose?: () => void;
  dateFilter?: { id: string; isCustom?: boolean };
  customStartDate?: Date | null;
  customEndDate?: Date | null;
}

const ERROR_ATTRIBUTE_KEYS = [
  "exception.message",
  "exception.type",
  "error.message",
  "error.type",
  "ai.response.finishReason",
  "gen_ai.response.finish_reasons",
];

function extractErrorSignal(metadata: string | null): { key: string; value: string } | null {
  if (!metadata) return null;
  try {
    const parsed = JSON.parse(metadata) as Record<string, unknown>;
    for (const key of ERROR_ATTRIBUTE_KEYS) {
      const val = parsed[key];
      if (typeof val === "string" && val) return { key, value: val };
      if (Array.isArray(val) && val.length > 0) return { key, value: String(val[0]) };
    }
  } catch {
    // ignore malformed metadata
  }
  return null;
}

// BFS through all descendants to find the best span with error context.
// Prefers any descendant with a status_message, otherwise returns the first
// descendant so its metadata can be fetched and inspected.
function findBestErrorDescendant(spans: Span[], rootSpanId: string): Span | null {
  const descendants: Span[] = [];
  const queue = [rootSpanId];
  const visited = new Set<string>();
  while (queue.length > 0) {
    const parentId = queue.shift()!;
    if (visited.has(parentId)) continue;
    visited.add(parentId);
    const children = spans.filter((s) => s.parent_span_id === parentId);
    descendants.push(...children);
    queue.push(...children.map((c) => c.span_id));
  }
  return descendants.find((s) => !!s.status_message) ?? descendants[0] ?? null;
}

/**
 * Right panel showing detailed information about selected trace or span
 */
export function SpanInfoPanel({
  projectId,
  trace,
  selection,
  onClose,
  dateFilter,
  customStartDate,
  customEndDate,
}: SpanInfoPanelProps) {
  const router = useRouter();

  const buildUrl = (basePath: string, extraParams?: Record<string, string>) =>
    buildUrlWithFilters(basePath, { dateFilter, customStartDate, customEndDate, extraParams });

  const isTrace = selection.type === "trace";
  // Identity of the current selection. Used to key the I/O renderers so their
  // per-value "expand" state resets when you switch spans/traces (and persists
  // within the same selection, e.g. across live updates).
  const selectionId = isTrace ? trace.trace_id : selection.span.span_id;
  const name = isTrace ? trace.name : selection.span.name;
  const kind = isTrace ? "trace" : selection.span.span_kind;
  const duration = isTrace ? getTraceDuration(trace) : getSpanDuration(selection.span);
  const timestamp = isTrace ? trace.trace_start_time : selection.span.span_start_time;
  // Per-span I/O is fetched lazily (the trace skeleton no longer ships it).
  // Trace-level I/O still lives on the trace object and needs no fetch.
  const selectedSpanId = isTrace ? null : selection.span.span_id;
  const { data: spanIO, isLoading: isLoadingIO } = useSpanIO(
    projectId,
    trace.trace_id,
    selectedSpanId,
  );

  const input = isTrace ? trace.input : (spanIO?.input ?? null);
  const output = isTrace ? trace.output : (spanIO?.output ?? null);
  const rawMetadata = isTrace ? trace.metadata : (spanIO?.metadata ?? null);
  const metadata = (() => {
    if (!rawMetadata) return rawMetadata;
    try {
      const parsed = JSON.parse(rawMetadata);
      const filtered = Object.fromEntries(
        Object.entries(parsed).filter(([k]) => !k.startsWith("traceroot.span.")),
      );
      return JSON.stringify(filtered);
    } catch {
      return rawMetadata;
    }
  })();

  // Trace-level aggregates
  const traceTotalCost = isTrace ? getTraceTotalCost(trace) : null;
  const traceCostDetails = isTrace ? getTraceCostBreakdown(trace) : null;
  const traceTokenUsage = isTrace ? getTraceTokenUsage(trace) : null;

  // Error status
  const hasError = isTrace ? false : selection.span.status === SpanStatus.ERROR;
  const statusMessage = !isTrace ? selection.span.status_message : null;

  // Fallback error signal: when status=ERROR but status_message is null,
  // walk all descendants (BFS) and surface the first useful error attribute.
  const fallbackChildSpan =
    !isTrace && hasError && !statusMessage
      ? findBestErrorDescendant(trace.spans, selection.span.span_id)
      : null;
  const { data: fallbackChildIO } = useSpanIO(
    projectId,
    trace.trace_id,
    fallbackChildSpan?.span_id ?? null,
  );
  const fallbackSignal =
    hasError && !statusMessage
      ? fallbackChildSpan?.status_message
        ? { key: "status_message", value: fallbackChildSpan.status_message }
        : extractErrorSignal(fallbackChildIO?.metadata ?? null)
      : null;
  const fallbackError = fallbackSignal?.value ?? null;

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
  };

  // Show a spinner while a selected span's I/O is in flight; trace-level I/O is
  // already loaded so it never spins.
  const renderIOContent = (content: string | null) =>
    !isTrace && isLoadingIO ? (
      <div className="flex items-center gap-2 py-3 text-xs text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" />
        Loading…
      </div>
    ) : (
      <ContentRenderer key={selectionId} content={content} />
    );

  return (
    <div className="h-full overflow-y-auto">
      {/* Header */}
      <div className="sticky top-0 z-10 border-b border-border bg-background px-4 py-3">
        <div className="mb-1 flex items-center gap-2">
          <SpanKindIcon kind={kind} size="md" selected />
          <h3 className="text-sm font-medium">{name}</h3>
          <CopyButton
            value={isTrace ? trace.trace_id : selection.span.span_id}
            className="h-6 w-6 text-muted-foreground hover:text-foreground"
            title="Copy ID"
          />
        </div>
        <div className="mb-3 text-xs text-muted-foreground">{formatDate(timestamp)}</div>
        {/* Row 1: LLM related badges */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs">
            <span className="text-muted-foreground">Span Kind:</span>
            <span className="font-medium">{kind.toLowerCase()}</span>
          </div>
          <div className="inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs">
            <Clock className="h-3 w-3 text-muted-foreground" />
            <span className="text-muted-foreground">Latency:</span>
            <span className="font-medium">{formatDuration(duration)}</span>
          </div>
          {hasError && (
            <div className="inline-flex items-center gap-1.5 rounded-md bg-red-100 px-2.5 py-1 text-xs font-medium text-red-700 dark:bg-red-950 dark:text-red-400">
              <AlertCircle className="h-3 w-3" />
              ERROR
            </div>
          )}
          {isTrace && trace.environment && (
            <div className="inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs">
              <span className="text-muted-foreground">Env:</span>
              <span className="font-medium">{trace.environment}</span>
            </div>
          )}
          {isTrace && traceTokenUsage && (
            <TokenChip
              inputTokens={traceTokenUsage.inputTokens}
              outputTokens={traceTokenUsage.outputTokens}
              totalTokens={traceTokenUsage.totalTokens}
              cacheReadTokens={traceTokenUsage.cacheReadTokens}
              cacheWriteTokens={traceTokenUsage.cacheWriteTokens}
              reasoningTokens={traceTokenUsage.reasoningTokens}
            />
          )}
          {isTrace && traceTotalCost != null && (
            <CostChip cost={traceTotalCost} costDetails={traceCostDetails} />
          )}
          {!isTrace && selection.span.model_name && (
            <div className="inline-flex items-center rounded-md bg-primary px-2.5 py-1 text-xs text-primary-foreground">
              {selection.span.model_name}
            </div>
          )}
          {!isTrace && selection.span.total_tokens != null && (
            <TokenChip
              inputTokens={selection.span.input_tokens}
              outputTokens={selection.span.output_tokens}
              totalTokens={selection.span.total_tokens}
              cacheReadTokens={selection.span.usage_details?.cache_read_tokens}
              cacheWriteTokens={selection.span.usage_details?.cache_write_tokens}
              reasoningTokens={selection.span.usage_details?.reasoning_tokens}
            />
          )}
          {!isTrace && (
            <CostChip cost={selection.span.cost} costDetails={selection.span.cost_details} />
          )}
        </div>

        {/* Row 2: Git related badges */}
        {isTrace && (trace.git_ref || trace.git_repo) && (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {trace.git_repo && (
              <a
                href={`https://github.com/${trace.git_repo}`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs transition-colors hover:bg-muted"
              >
                <GitBranch className="h-3 w-3 text-muted-foreground" />
                <span className="text-muted-foreground">Repo:</span>
                <span className="font-mono font-medium">{trace.git_repo}</span>
              </a>
            )}
            {trace.git_ref && (
              <a
                href={
                  trace.git_repo
                    ? `https://github.com/${trace.git_repo}/commit/${trace.git_ref}`
                    : undefined
                }
                target="_blank"
                rel="noopener noreferrer"
                className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs ${
                  trace.git_repo ? "cursor-pointer transition-colors hover:bg-muted" : ""
                }`}
                title={trace.git_ref}
              >
                <GitCommitHorizontal className="h-3 w-3 text-muted-foreground" />
                <span className="text-muted-foreground">Ref:</span>
                <span className="font-mono font-medium">{trace.git_ref.substring(0, 7)}</span>
              </a>
            )}
          </div>
        )}

        {/* Row 3: User/Session links */}
        {isTrace && (trace.user_id || trace.session_id) && (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {trace.user_id && (
              <button
                type="button"
                onClick={() => {
                  onClose?.();
                  router.push(
                    buildUrl(`/projects/${projectId}/traces`, {
                      user_id: trace.user_id!,
                    }),
                  );
                }}
                className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border bg-muted/40 py-1 pl-2.5 pr-1.5 text-xs transition-colors hover:bg-muted"
              >
                <Users className="h-3 w-3 text-muted-foreground" />
                <span className="text-muted-foreground">User:</span>
                <span className="font-medium">{trace.user_id}</span>
                <ChevronRight className="h-3 w-3 text-muted-foreground" />
              </button>
            )}
            {trace.session_id && (
              <button
                type="button"
                onClick={() => {
                  onClose?.();
                  router.push(
                    buildUrl(`/projects/${projectId}/sessions`, {
                      sessionId: trace.session_id!,
                    }),
                  );
                }}
                className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border bg-muted/40 py-1 pl-2.5 pr-1.5 text-xs transition-colors hover:bg-muted"
              >
                <Layers className="h-3 w-3 text-muted-foreground" />
                <span className="text-muted-foreground">Session:</span>
                <span className="font-medium">{trace.session_id}</span>
                <ChevronRight className="h-3 w-3 text-muted-foreground" />
              </button>
            )}
          </div>
        )}
      </div>

      {/* Content */}
      <div className="space-y-3 p-4">
        {/* Error message */}
        {(statusMessage || fallbackError) && (
          <div className="rounded-md border border-red-200 bg-red-50 p-3 dark:border-red-900 dark:bg-red-950/50">
            <div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-red-700 dark:text-red-400">
              <AlertCircle className="h-3 w-3" />
              Error
              {!statusMessage && fallbackChildSpan && (
                <span className="ml-1 font-normal opacity-75">
                  (from &quot;{fallbackChildSpan.name}&quot;)
                </span>
              )}
            </div>
            {!statusMessage && fallbackError && (
              <p className="mb-2 text-xs italic text-red-500 dark:text-red-500">
                No error message on this span — showing the closest failure signal from a descendant
                span.
              </p>
            )}
            {!statusMessage && fallbackSignal && (
              <p className="mb-1 text-xs text-red-500 dark:text-red-500">
                <span className="font-medium">Source:</span>{" "}
                <span className="font-mono">{fallbackSignal.key}</span>
              </p>
            )}
            {/* Source location info */}
            {!isTrace && (trace.git_repo || trace.git_ref || selection.span.git_source_file) && (
              <div className="mb-2 flex flex-wrap items-center gap-2">
                {trace.git_repo && (
                  <div className="inline-flex items-center gap-1.5 rounded bg-red-100 px-2 py-0.5 text-xs dark:bg-red-900/50">
                    <GitBranch className="h-3 w-3 text-red-600 dark:text-red-400" />
                    <span className="font-mono text-red-700 dark:text-red-300">
                      {trace.git_repo}
                    </span>
                  </div>
                )}
                {trace.git_ref && (
                  <div className="inline-flex items-center gap-1.5 rounded bg-red-100 px-2 py-0.5 text-xs dark:bg-red-900/50">
                    <GitCommitHorizontal className="h-3 w-3 text-red-600 dark:text-red-400" />
                    <span className="font-mono text-red-700 dark:text-red-300">
                      {trace.git_ref.substring(0, 7)}
                    </span>
                  </div>
                )}
                {selection.span.git_source_file && (
                  <div className="inline-flex items-center gap-1.5 rounded bg-red-100 px-2 py-0.5 text-xs dark:bg-red-900/50">
                    <FileCode className="h-3 w-3 text-red-600 dark:text-red-400" />
                    <span className="font-mono text-red-700 dark:text-red-300">
                      {selection.span.git_source_file}
                      {selection.span.git_source_line && `:${selection.span.git_source_line}`}
                    </span>
                  </div>
                )}
              </div>
            )}
            <p className="whitespace-pre-wrap break-all font-mono text-xs text-red-600 dark:text-red-400">
              {statusMessage ?? fallbackError}
            </p>
          </div>
        )}

        {/* Input */}
        <ExpandableSection
          title="Input"
          defaultOpen={true}
          onCopy={input ? () => copyToClipboard(input) : undefined}
        >
          {renderIOContent(input)}
        </ExpandableSection>

        {/* Output */}
        <ExpandableSection
          title="Output"
          defaultOpen={true}
          onCopy={output ? () => copyToClipboard(output) : undefined}
        >
          {renderIOContent(output)}
        </ExpandableSection>

        {/* Metadata */}
        <ExpandableSection
          title="Metadata"
          defaultOpen={true}
          onCopy={metadata ? () => copyToClipboard(metadata) : undefined}
        >
          {renderIOContent(metadata)}
        </ExpandableSection>
      </div>
    </div>
  );
}
