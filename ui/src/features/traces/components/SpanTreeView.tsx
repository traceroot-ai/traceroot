'use client';

import { useState } from 'react';
import { ChevronRight, ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import { formatDuration } from '@/lib/utils';
import type { TraceDetail, Span } from '@/types/api';
import type { TraceSelection } from '../types';
import { buildSpanTree, buildChildrenMap, getSpanDuration, getTraceDuration, TREE_LAYOUT } from '../utils';
import { SpanKindIcon } from './SpanKindIcon';
import { SpanTreeConnector } from './SpanTreeConnector';

interface SpanTreeViewProps {
  trace: TraceDetail;
  selection: TraceSelection;
  onSelect: (selection: TraceSelection) => void;
}

/**
 * Tree view component for displaying trace and span hierarchy
 */
export function SpanTreeView({ trace, selection, onSelect }: SpanTreeViewProps) {
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(new Set());

  const childrenByParent = buildChildrenMap(trace.spans);

  const hasChildren = (spanId: string | null) => {
    const children = childrenByParent.get(spanId) || [];
    return children.length > 0;
  };

  const toggleCollapse = (spanId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setCollapsedIds(prev => {
      const next = new Set(prev);
      if (next.has(spanId)) {
        next.delete(spanId);
      } else {
        next.add(spanId);
      }
      return next;
    });
  };

  // Check if a span should be visible (not hidden by collapsed ancestor)
  const isVisible = (span: Span): boolean => {
    let currentId = span.parent_span_id;
    while (currentId) {
      if (collapsedIds.has(currentId)) return false;
      const parent = trace.spans.find(s => s.span_id === currentId);
      currentId = parent?.parent_span_id || null;
    }
    return true;
  };

  const spanRows = buildSpanTree(trace.spans);
  const isTraceSelected = selection.type === 'trace';
  const traceDuration = getTraceDuration(trace);
  const traceHasChildren = hasChildren(null);
  const traceIsCollapsed = collapsedIds.has('trace');

  return (
    <div>
      {/* Trace row */}
      <div
        className={cn(
          'flex items-center cursor-pointer transition-colors rounded-sm',
          isTraceSelected
            ? 'bg-muted'
            : 'hover:bg-muted/50'
        )}
        style={{ height: TREE_LAYOUT.ROW_HEIGHT, paddingLeft: TREE_LAYOUT.LEFT_PADDING }}
        onClick={() => onSelect({ type: 'trace' })}
      >
        <div className="flex items-center gap-1.5 min-w-0 pr-2 flex-1">
          <SpanKindIcon kind="trace" inTree />
          <span className="truncate text-xs">{trace.name}</span>
          <span className="text-[10px] text-muted-foreground font-mono whitespace-nowrap">
            {formatDuration(traceDuration)}
          </span>
          <div className="flex-1" />
          {traceHasChildren && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                setCollapsedIds(prev => {
                  const next = new Set(prev);
                  if (next.has('trace')) {
                    next.delete('trace');
                  } else {
                    next.add('trace');
                  }
                  return next;
                });
              }}
              className="p-0.5 hover:bg-muted rounded transition-colors flex-shrink-0"
            >
              {traceIsCollapsed ? (
                <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
              ) : (
                <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
              )}
            </button>
          )}
        </div>
      </div>

      {/* Span rows */}
      {!traceIsCollapsed && spanRows.map(({ span, level, isTerminal, parentLevels }) => {
        // Skip if hidden by collapsed ancestor
        if (!isVisible(span)) return null;

        const isSelected = selection.type === 'span' && selection.span.span_id === span.span_id;
        const adjustedLevel = level + 1;
        const adjustedParentLevels = parentLevels.map(l => l + 1);
        const spanHasChildren = hasChildren(span.span_id);
        const isCollapsed = collapsedIds.has(span.span_id);

        return (
          <div
            key={span.span_id}
            className={cn(
              'flex items-center cursor-pointer transition-colors pr-2 rounded-r-sm',
              isSelected
                ? 'bg-muted'
                : 'hover:bg-muted/50'
            )}
            style={{ height: TREE_LAYOUT.ROW_HEIGHT }}
            onClick={() => onSelect({ type: 'span', span })}
          >
            <SpanTreeConnector level={adjustedLevel} isTerminal={isTerminal} parentLevels={adjustedParentLevels} />
            <div className="flex items-center gap-1.5 min-w-0 flex-1">
              <SpanKindIcon kind={span.span_kind} inTree />
              <span className="truncate text-xs">{span.name}</span>
              <span className="text-[10px] text-muted-foreground font-mono whitespace-nowrap">
                {formatDuration(getSpanDuration(span))}
              </span>
              <div className="flex-1" />
              {spanHasChildren && (
                <button
                  onClick={(e) => toggleCollapse(span.span_id, e)}
                  className="p-0.5 hover:bg-muted rounded transition-colors flex-shrink-0"
                >
                  {isCollapsed ? (
                    <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                  ) : (
                    <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                  )}
                </button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
