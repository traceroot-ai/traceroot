"use client";

import { useRouter } from "next/navigation";
import {
  Clock,
  Users,
  Layers,
  ChevronRight,
  CircleStop,
  CircleDollarSign,
  AlertCircle,
  GitBranch,
  GitCommitHorizontal,
  FileCode,
} from "lucide-react";
import { CopyButton } from "@/components/ui/copy-button";
import { formatDuration, formatDate, formatTokens, buildUrlWithFilters } from "@/lib/utils";
import { SpanStatus } from "@traceroot/core";
import type { TraceDetail } from "@/types/api";
import type { TraceSelection } from "../types";
import { getSpanDuration, getTraceDuration, getTraceTotalCost, getTraceTokenUsage } from "../utils";
import { SpanKindIcon } from "./SpanKindIcon";
import { ContentRenderer } from "./ContentRenderer";
import { ExpandableSection } from "@/components/ui/expandable-section";

interface SpanInfoPanelProps {
  projectId: string;
  trace: TraceDetail;
  selection: TraceSelection;
  onClose?: () => void;
  dateFilter?: { id: string; isCustom?: boolean };
  customStartDate?: Date | null;
  customEndDate?: Date | null;
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
  const name = isTrace ? trace.name : selection.span.name;
  const kind = isTrace ? "trace" : selection.span.span_kind;
  const duration = isTrace ? getTraceDuration(trace) : getSpanDuration(selection.span);
  const timestamp = isTrace ? trace.trace_start_time : selection.span.span_start_time;
  const input = isTrace ? trace.input : selection.span.input;
  const output = isTrace ? trace.output : selection.span.output;
  const metadata = isTrace ? trace.metadata : selection.span.metadata;

  // Trace-level aggregates
  const traceTotalCost = isTrace ? getTraceTotalCost(trace) : null;
  const traceTokenUsage = isTrace ? getTraceTokenUsage(trace) : null;

  // Error status
  const hasError = isTrace ? false : selection.span.status === SpanStatus.ERROR;
  const statusMessage = !isTrace ? selection.span.status_message : null;

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
  };

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
            <div className="inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs">
              <CircleStop className="h-3 w-3 text-muted-foreground" />
              <span className="font-medium">{formatTokens(traceTokenUsage.totalTokens)}</span>
              <span className="text-muted-foreground">
                ({formatTokens(traceTokenUsage.inputTokens)} in /{" "}
                {formatTokens(traceTokenUsage.outputTokens)} out)
              </span>
            </div>
          )}
          {isTrace && traceTotalCost && (
            <div className="inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs">
              <CircleDollarSign className="h-3 w-3 text-muted-foreground" />
              <span className="font-medium">{traceTotalCost.toFixed(6)}</span>
            </div>
          )}
          {!isTrace && selection.span.model_name && (
            <div className="inline-flex items-center rounded-md bg-primary px-2.5 py-1 text-xs text-primary-foreground">
              {selection.span.model_name}
            </div>
          )}
          {!isTrace && selection.span.total_tokens != null && (
            <div className="inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs">
              <CircleStop className="h-3 w-3 text-muted-foreground" />
              <span className="font-medium">{formatTokens(selection.span.total_tokens)}</span>
              <span className="text-muted-foreground">
                ({formatTokens(selection.span.input_tokens)} in /{" "}
                {formatTokens(selection.span.output_tokens)} out)
              </span>
            </div>
          )}
          {!isTrace && selection.span.cost != null && selection.span.cost > 0 && (
            <div className="inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs">
              <CircleDollarSign className="h-3 w-3 text-muted-foreground" />
              <span className="font-medium">{selection.span.cost.toFixed(6)}</span>
            </div>
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

        {/* Input */}
        <ExpandableSection
          title="Input"
          defaultOpen={true}
          onCopy={input ? () => copyToClipboard(input) : undefined}
        >
          <ContentRenderer content={input} />
        </ExpandableSection>

        {/* Output */}
        <ExpandableSection
          title="Output"
          defaultOpen={true}
          onCopy={output ? () => copyToClipboard(output) : undefined}
        >
          <ContentRenderer content={output} />
        </ExpandableSection>

        {/* Metadata */}
        <ExpandableSection
          title="Metadata"
          defaultOpen={true}
          onCopy={metadata ? () => copyToClipboard(metadata) : undefined}
        >
          <ContentRenderer content={metadata} />
        </ExpandableSection>
      </div>
    </div>
  );
}
