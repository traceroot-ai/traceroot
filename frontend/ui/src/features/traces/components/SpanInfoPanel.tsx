"use client";

import type { ReactNode } from "react";
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
} from "lucide-react";
import { CopyButton } from "@/components/ui/copy-button";
import { formatDuration, formatDate, buildUrlWithFilters } from "@/lib/utils";
import { TokenChip } from "./TokenChip";
import { CostChip } from "./CostChip";
import { MetricDelta } from "./MetricDelta";
import { TraceIODiffSection } from "./TraceIODiff";
import { SpanStatus } from "@traceroot/core";
import type { Span, TraceDetail } from "@/types/api";
import type { TraceSelection } from "../types";
import {
  getSpanDuration,
  getTraceDuration,
  getTraceTotalCost,
  getTraceTokenUsage,
  getTraceCostBreakdown,
} from "../utils";
import { SpanKindIcon } from "./SpanKindIcon";
import { TraceIOSection } from "./TraceIOValue";
import { useSpanIO } from "../hooks";

interface SpanInfoPanelProps {
  projectId: string;
  trace: TraceDetail;
  selection: TraceSelection;
  onClose?: () => void;
  dateFilter?: { id: string; isCustom?: boolean };
  customStartDate?: Date | null;
  customEndDate?: Date | null;
  /**
   * Optional action bar rendered between the header and the content, e.g. the
   * offline-eval "Save as test case" / "Review" buttons. Unset in production, so
   * the standard trace viewer is unaffected.
   */
  spanActions?: ReactNode;
  /**
   * Optional action rendered on the right of the header's title row, vertically
   * centred against the name + timestamp block (e.g. offline-eval's "Save as
   * test case"). Unset in production.
   */
  headerAction?: ReactNode;
  /**
   * Optional extra chips appended to the span-kind / latency badge row (e.g.
   * offline-eval's "Dataset:" chip). Unset in production.
   */
  extraTags?: ReactNode;
  /**
   * Diff mode (offline-eval only): when on, the latency/token/cost tags show ±
   * deltas and Input/Output/Metadata render as git-style line diffs vs the baseline
   * run — for the trace-level selection (using `baselineTrace`) as well as a span
   * selection (using the matched `baselineSpan`). Unset in production, so the
   * standard viewer is unaffected.
   */
  diffMode?: boolean;
  baselineSpan?: Span | null;
  baselineTrace?: TraceDetail | null;
}

/** Drop internal `traceroot.span.*` keys so the Metadata panel shows only user metadata. */
function stripInternalMetadata(raw: string | null | undefined): string | null {
  if (!raw) return raw ?? null;
  try {
    const parsed = JSON.parse(raw);
    const filtered = Object.fromEntries(
      Object.entries(parsed).filter(([k]) => !k.startsWith("traceroot.span.")),
    );
    return JSON.stringify(filtered);
  } catch {
    return raw;
  }
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
  spanActions,
  headerAction,
  extraTags,
  diffMode = false,
  baselineSpan,
  baselineTrace,
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

  // Per-span I/O comes from the lazy fetch, but fall back to whatever the span
  // object itself carries — a provided trace (e.g. an evaluation's reconstructed
  // trace) ships I/O on the span, and the `/io` fetch returns nothing for those
  // synthetic span ids. Production skeleton spans have null here, so normal traces
  // are unchanged (the fetch stays the source).
  const input = isTrace ? trace.input : (spanIO?.input ?? selection.span.input ?? null);
  const output = isTrace ? trace.output : (spanIO?.output ?? selection.span.output ?? null);
  const rawMetadata = isTrace
    ? trace.metadata
    : (spanIO?.metadata ?? selection.span.metadata ?? null);
  const metadata = stripInternalMetadata(rawMetadata);

  // Trace-level aggregates (also the diff baseline source for the trace selection).
  const traceTotalCost = isTrace ? getTraceTotalCost(trace) : null;
  const traceCostDetails = isTrace ? getTraceCostBreakdown(trace) : null;
  const traceTokenUsage = isTrace ? getTraceTokenUsage(trace) : null;

  // Diff mode (offline-eval): compare the current selection against its baseline —
  // the whole trace vs `baselineTrace`, or a span vs its matched `baselineSpan`.
  // Gated on the Diff toggle. Baseline span I/O is fetched the same lazy way (the
  // query stays disabled unless a span-level diff is active); the trace selection
  // diffs against the already-loaded baseline trace object, no fetch.
  const diffActive = diffMode && (isTrace ? !!baselineTrace : !!baselineSpan);
  const { data: baselineIO } = useSpanIO(
    projectId,
    baselineSpan?.trace_id ?? "",
    diffActive && !isTrace ? (baselineSpan?.span_id ?? null) : null,
  );
  const baselineInput = isTrace
    ? (baselineTrace?.input ?? null)
    : baselineSpan
      ? (baselineIO?.input ?? baselineSpan.input ?? null)
      : null;
  const baselineOutput = isTrace
    ? (baselineTrace?.output ?? null)
    : baselineSpan
      ? (baselineIO?.output ?? baselineSpan.output ?? null)
      : null;
  const baselineMetadata = isTrace
    ? stripInternalMetadata(baselineTrace?.metadata ?? null)
    : baselineSpan
      ? stripInternalMetadata(baselineIO?.metadata ?? baselineSpan.metadata ?? null)
      : null;

  // ± deltas for the latency / token / cost tags (lower is better). Candidate and
  // baseline are the trace aggregates for the trace selection, the span values for a
  // span selection.
  const baselineDuration = isTrace
    ? baselineTrace
      ? getTraceDuration(baselineTrace)
      : null
    : baselineSpan
      ? getSpanDuration(baselineSpan)
      : null;
  const durationDelta =
    diffActive && duration != null && baselineDuration != null ? duration - baselineDuration : null;
  const tokenDelta = (() => {
    if (!diffActive) return null;
    if (isTrace) {
      const c = traceTokenUsage?.totalTokens ?? null;
      const b = baselineTrace ? (getTraceTokenUsage(baselineTrace)?.totalTokens ?? null) : null;
      return c != null && b != null ? c - b : null;
    }
    if (!baselineSpan || selection.span.total_tokens == null) return null;
    return selection.span.total_tokens - (baselineSpan.total_tokens ?? 0);
  })();
  const costDelta = (() => {
    if (!diffActive) return null;
    if (isTrace) {
      const b = baselineTrace ? getTraceTotalCost(baselineTrace) : null;
      return traceTotalCost != null && b != null ? traceTotalCost - b : null;
    }
    if (!baselineSpan || selection.span.cost == null) return null;
    return selection.span.cost - (baselineSpan.cost ?? 0);
  })();
  const fmtTokens = (n: number) => Math.round(n).toLocaleString();
  const fmtCost = (n: number) => `$${n.toFixed(6)}`;

  // Error status
  const hasError = isTrace ? false : selection.span.status === SpanStatus.ERROR;
  const statusMessage = !isTrace ? selection.span.status_message : null;

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
  };

  // Show a spinner while a selected span's I/O is in flight; trace-level I/O is
  // already loaded so it never spins.
  // A selected span's I/O is fetched on demand; trace-level I/O is already loaded.
  const ioLoading = !isTrace && isLoadingIO;

  return (
    <div className="h-full overflow-y-auto">
      {/* Header */}
      <div className="sticky top-0 z-10 border-b border-border bg-background px-4 py-3">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="mb-1 flex items-center gap-2">
              <SpanKindIcon kind={kind} size="md" selected />
              <h3 className="text-sm font-medium">{name}</h3>
              <CopyButton
                value={isTrace ? trace.trace_id : selection.span.span_id}
                className="h-6 w-6 text-muted-foreground hover:text-foreground"
                title="Copy ID"
              />
            </div>
            <div className="text-xs text-muted-foreground">{formatDate(timestamp)}</div>
          </div>
          {headerAction && <div className="shrink-0">{headerAction}</div>}
        </div>
        {/* Row 1: LLM related badges */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs">
            <span className="text-muted-foreground">Span Kind:</span>
            <span className="font-medium">{kind.toLowerCase()}</span>
          </div>
          {extraTags}
          <div className="inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs">
            <Clock className="h-3 w-3 text-muted-foreground" />
            <span className="text-muted-foreground">Latency:</span>
            <span className="font-medium">{formatDuration(duration)}</span>
            <MetricDelta delta={durationDelta} format={formatDuration} />
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
              delta={<MetricDelta delta={tokenDelta} format={fmtTokens} />}
            />
          )}
          {isTrace && traceTotalCost != null && (
            <CostChip
              cost={traceTotalCost}
              costDetails={traceCostDetails}
              delta={<MetricDelta delta={costDelta} format={fmtCost} />}
            />
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
              delta={<MetricDelta delta={tokenDelta} format={fmtTokens} />}
            />
          )}
          {!isTrace && (
            <CostChip
              cost={selection.span.cost}
              costDetails={selection.span.cost_details}
              delta={<MetricDelta delta={costDelta} format={fmtCost} />}
            />
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

      {/* Optional injected actions (offline-eval); absent in production. */}
      {spanActions && (
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2">
          {spanActions}
        </div>
      )}

      {/* Content */}
      <div className="space-y-3 p-4">
        {/* Error message */}
        {statusMessage && (
          <div className="rounded-md border border-red-200 bg-red-50 p-3 dark:border-red-900 dark:bg-red-950/50">
            <div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-red-700 dark:text-red-400">
              <AlertCircle className="h-3 w-3" />
              Error
            </div>
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
              {statusMessage}
            </p>
          </div>
        )}

        {/* Input / Output / Metadata. In diff mode (eval trace with a baseline) each
            renders as a git-style line diff vs the matched baseline span; otherwise
            the normal value view with a header format switcher. The key resets
            per-value state when a different span/trace is selected. */}
        {diffActive ? (
          <>
            <TraceIODiffSection
              key={`${selectionId}:input`}
              title="Input"
              baseline={baselineInput}
              candidate={input}
            />
            <TraceIODiffSection
              key={`${selectionId}:output`}
              title="Output"
              baseline={baselineOutput}
              candidate={output}
            />
            <TraceIODiffSection
              key={`${selectionId}:metadata`}
              title="Metadata"
              baseline={baselineMetadata}
              candidate={metadata}
            />
          </>
        ) : (
          <>
            <TraceIOSection
              key={`${selectionId}:input`}
              title="Input"
              content={input}
              loading={ioLoading}
              onCopy={input ? () => copyToClipboard(input) : undefined}
            />
            <TraceIOSection
              key={`${selectionId}:output`}
              title="Output"
              content={output}
              loading={ioLoading}
              onCopy={output ? () => copyToClipboard(output) : undefined}
            />
            <TraceIOSection
              key={`${selectionId}:metadata`}
              title="Metadata"
              content={metadata}
              loading={ioLoading}
              onCopy={metadata ? () => copyToClipboard(metadata) : undefined}
            />
          </>
        )}
      </div>
    </div>
  );
}
