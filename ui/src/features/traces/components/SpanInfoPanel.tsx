'use client';

import { Clock } from 'lucide-react';
import { CopyButton } from '@/components/ui/copy-button';
import { formatDuration, formatDate } from '@/lib/utils';
import type { TraceDetail } from '@/types/api';
import type { TraceSelection } from '../types';
import { getSpanDuration, getTraceDuration } from '../utils';
import { SpanKindIcon } from './SpanKindIcon';
import { ContentRenderer } from './ContentRenderer';
import { ExpandableSection } from '@/components/ui/expandable-section';

interface SpanInfoPanelProps {
  trace: TraceDetail;
  selection: TraceSelection;
}

/**
 * Right panel showing detailed information about selected trace or span
 */
export function SpanInfoPanel({ trace, selection }: SpanInfoPanelProps) {
  const isTrace = selection.type === 'trace';
  const name = isTrace ? trace.name : selection.span.name;
  const kind = isTrace ? 'trace' : selection.span.span_kind;
  const duration = isTrace ? getTraceDuration(trace) : getSpanDuration(selection.span);
  const timestamp = isTrace ? trace.trace_start_time : selection.span.span_start_time;
  const input = isTrace ? trace.input : selection.span.input;
  const output = isTrace ? trace.output : selection.span.output;

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
  };

  return (
    <div className="h-full overflow-y-auto">
      {/* Header */}
      <div className="px-4 py-3 border-b sticky top-0 bg-background z-10">
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
          {!isTrace && selection.span.model_name && (
            <div className="inline-flex items-center rounded-md bg-primary text-primary-foreground px-2.5 py-1 text-xs">
              {selection.span.model_name}
            </div>
          )}
          {!isTrace && selection.span.cost !== null && selection.span.cost > 0 && (
            <div className="inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs">
              <span className="font-medium">${selection.span.cost.toFixed(4)}</span>
            </div>
          )}
        </div>
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
