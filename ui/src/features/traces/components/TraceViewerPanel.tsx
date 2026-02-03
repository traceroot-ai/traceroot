'use client';

import { useState, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Workflow, X, ArrowUp, ArrowDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { getTrace } from '@/lib/api';
import type { TraceSelection } from '../types';
import { SpanTreeView } from './SpanTreeView';
import { SpanInfoPanel } from './SpanInfoPanel';

interface TraceViewerPanelProps {
  projectId: string;
  traceId: string;
  onClose: () => void;
  onNavigate: (direction: 'up' | 'down') => void;
  canNavigateUp: boolean;
  canNavigateDown: boolean;
}

/**
 * Full-screen slide-in panel for viewing trace details
 */
export function TraceViewerPanel({
  projectId,
  traceId,
  onClose,
  onNavigate,
  canNavigateUp,
  canNavigateDown,
}: TraceViewerPanelProps) {
  const [selection, setSelection] = useState<TraceSelection>({ type: 'trace' });

  const { data: trace, isLoading, error } = useQuery({
    queryKey: ['trace', projectId, traceId],
    queryFn: () => getTrace(projectId, traceId, ''),
  });

  // Reset selection when navigating to a different trace
  useEffect(() => {
    setSelection({ type: 'trace' });
  }, [traceId]);

  return (
    <div className="h-full flex flex-col bg-background">
      {/* Top header bar */}
      <div className="flex items-center justify-between px-4 h-10 border-b bg-muted/30">
        <div className="flex items-center gap-2 min-w-0">
          <Workflow className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-medium">Trace</span>
          <span className="text-xs text-muted-foreground font-mono truncate">
            {traceId}
          </span>
        </div>
        <div className="flex items-center gap-1">
          {/* Navigation buttons */}
          <Button
            variant="outline"
            size="sm"
            onClick={() => onNavigate('up')}
            disabled={!canNavigateUp}
            className="h-7 w-7 p-0"
            title="Previous trace"
          >
            <ArrowUp className="h-4 w-4" />
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => onNavigate('down')}
            disabled={!canNavigateDown}
            className="h-7 w-7 p-0"
            title="Next trace"
          >
            <ArrowDown className="h-4 w-4" />
          </Button>
          <div className="w-2" /> {/* Spacer */}
          <Button
            variant="ghost"
            size="sm"
            onClick={onClose}
            className="h-7 w-7 p-0"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Content */}
      {isLoading ? (
        <div className="flex-1 flex items-center justify-center">
          <p className="text-sm text-muted-foreground">Loading trace...</p>
        </div>
      ) : error || !trace ? (
        <div className="flex-1 flex items-center justify-center">
          <p className="text-sm text-destructive">Error loading trace</p>
        </div>
      ) : (
        <div className="flex-1 flex overflow-hidden">
          {/* Left: Tree view */}
          <div className="w-[320px] flex-shrink-0 border-r overflow-y-auto">
            <SpanTreeView trace={trace} selection={selection} onSelect={setSelection} />
          </div>

          {/* Right: Detail panel */}
          <div className="flex-1 overflow-hidden">
            <SpanInfoPanel projectId={projectId} trace={trace} selection={selection} onClose={onClose} />
          </div>
        </div>
      )}
    </div>
  );
}
