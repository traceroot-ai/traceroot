'use client';

import { useRouter } from 'next/navigation';
import { Clock, Users, Layers, ChevronRight, CircleStop, CircleDollarSign } from 'lucide-react';
import { CopyButton } from '@/components/ui/copy-button';
import { formatDuration, formatDate, formatTokens } from '@/lib/utils';
import type { TraceDetail } from '@/types/api';
import type { TraceSelection } from '../types';
import { getSpanDuration, getTraceDuration, getTraceTotalCost, getTraceTokenUsage } from '../utils';
import { SpanKindIcon } from './SpanKindIcon';
import { ContentRenderer } from './ContentRenderer';
import { ExpandableSection } from '@/components/ui/expandable-section';

interface SpanInfoPanelProps {
  projectId: string;
  trace: TraceDetail;
  selection: TraceSelection;
  onClose?: () => void;
}

/**
 * Right panel showing detailed information about selected trace or span
 */
export function SpanInfoPanel({ projectId, trace, selection, onClose }: SpanInfoPanelProps) {
  const router = useRouter();
  const isTrace = selection.type === 'trace';
  const name = isTrace ? trace.name : selection.span.name;
  const kind = isTrace ? 'trace' : selection.span.span_kind;
  const duration = isTrace ? getTraceDuration(trace) : getSpanDuration(selection.span);
  const timestamp = isTrace ? trace.trace_start_time : selection.span.span_start_time;
  const input = isTrace ? trace.input : selection.span.input;
  const output = isTrace ? trace.output : selection.span.output;

  // Trace-level aggregates
  const traceTotalCost = isTrace ? getTraceTotalCost(trace) : null;
  const traceTokenUsage = isTrace ? getTraceTokenUsage(trace) : null;

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
  };

  return (
    <div className="h-full overflow-y-auto">
      {/* Header */}
      <div className="px-4 py-3 border-b border-border sticky top-0 bg-background z-10">
        <div className="flex items-center gap-2 mb-1">
          <SpanKindIcon kind={kind} size="md" selected />
          <h3 className="text-sm font-medium">{name}</h3>
          <CopyButton
            value={isTrace ? trace.trace_id : selection.span.span_id}
            className="h-6 w-6 text-muted-foreground hover:text-foreground"
            title="Copy ID"
          />
        </div>
        <div className="text-xs text-muted-foreground mb-3">
          {formatDate(timestamp)}
        </div>
        {/* Static metadata badges */}
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
                ({formatTokens(traceTokenUsage.inputTokens)} in / {formatTokens(traceTokenUsage.outputTokens)} out)
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
            <div className="inline-flex items-center rounded-md bg-primary text-primary-foreground px-2.5 py-1 text-xs">
              {selection.span.model_name}
            </div>
          )}
          {!isTrace && selection.span.total_tokens != null && (
            <div className="inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs">
              <CircleStop className="h-3 w-3 text-muted-foreground" />
              <span className="font-medium">{formatTokens(selection.span.total_tokens)}</span>
              <span className="text-muted-foreground">
                ({formatTokens(selection.span.input_tokens)} in / {formatTokens(selection.span.output_tokens)} out)
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

        {/* Clickable User/Session links */}
        {isTrace && (trace.user_id || trace.session_id) && (
          <div className="flex flex-wrap items-center gap-2 mt-2">
            {trace.user_id && (
              <button
                type="button"
                onClick={() => {
                  onClose?.();
                  router.push(`/projects/${projectId}/traces?user_id=${encodeURIComponent(trace.user_id!)}`);
                }}
                className="inline-flex items-center gap-1.5 rounded-md border bg-muted/40 pl-2.5 pr-1.5 py-1 text-xs hover:bg-muted transition-colors cursor-pointer"
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
                onClick={() => {/* TODO: handle session_id click */}}
                className="inline-flex items-center gap-1.5 rounded-md border bg-muted/40 pl-2.5 pr-1.5 py-1 text-xs hover:bg-muted transition-colors cursor-pointer"
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
      <div className="p-4 space-y-3">
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
      </div>
    </div>
  );
}
