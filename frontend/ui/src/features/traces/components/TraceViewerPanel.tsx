"use client";

import { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Workflow, X, ArrowUp, ArrowDown, BotMessageSquare, Radio } from "lucide-react";
import { Button } from "@/components/ui/button";
import { getTrace } from "@/lib/api";
import type { TraceSelection } from "../types";
import { SpanTreeView } from "./SpanTreeView";
import { SpanInfoPanel } from "./SpanInfoPanel";
import { AiChatOverlay } from "@/features/ai-assistant/components/ai-chat-overlay";
import { useTraceStream } from "../hooks/use-trace-stream";

interface TraceViewerPanelProps {
  projectId: string;
  traceId: string;
  onClose: () => void;
  onNavigate: (direction: "up" | "down") => void;
  canNavigateUp: boolean;
  canNavigateDown: boolean;
  dateFilter?: { id: string; isCustom?: boolean };
  customStartDate?: Date | null;
  customEndDate?: Date | null;
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
  dateFilter,
  customStartDate,
  customEndDate,
}: TraceViewerPanelProps) {
  const [selection, setSelection] = useState<TraceSelection>({ type: "trace" });
  const [aiChatOpen, setAiChatOpen] = useState(false);

  const {
    data: trace,
    isLoading,
    error,
  } = useQuery({
    queryKey: ["trace", projectId, traceId],
    queryFn: () => getTrace(projectId, traceId, ""),
  });

  // Only stream if the trace has not yet completed (no root span with end time).
  const isTraceComplete =
    trace?.spans.some((s) => s.parent_span_id === null && s.span_end_time !== null) ?? false;
  const { isStreaming } = useTraceStream(projectId, traceId, !isTraceComplete);

  // Reset selection when navigating to a different trace
  useEffect(() => {
    setSelection({ type: "trace" });
  }, [traceId]);

  return (
    <div className="flex h-full flex-col bg-background">
      {/* Top header bar */}
      <div className="flex h-10 items-center justify-between border-b border-border bg-muted/30 px-4">
        <div className="flex min-w-0 items-center gap-2">
          <Workflow className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-medium">Trace</span>
          <span className="truncate font-mono text-xs text-muted-foreground">{traceId}</span>
          {isStreaming && (
            <span className="flex items-center gap-1 rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-700 dark:bg-green-900/30 dark:text-green-400">
              <Radio className="h-3 w-3 animate-pulse" />
              Live
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          {/* Navigation buttons */}
          <Button
            variant="outline"
            size="sm"
            onClick={() => onNavigate("up")}
            disabled={!canNavigateUp}
            className="h-7 w-7 p-0"
            title="Previous trace"
          >
            <ArrowUp className="h-4 w-4" />
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => onNavigate("down")}
            disabled={!canNavigateDown}
            className="h-7 w-7 p-0"
            title="Next trace"
          >
            <ArrowDown className="h-4 w-4" />
          </Button>
          <div className="w-2" /> {/* Spacer */}
          <Button
            variant="outline"
            size="sm"
            onClick={() => setAiChatOpen(!aiChatOpen)}
            className="h-7 w-7 p-0"
            title="AI Assistant"
          >
            <BotMessageSquare className="h-4 w-4" />
          </Button>
          <Button variant="ghost" size="sm" onClick={onClose} className="h-7 w-7 p-0">
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Content */}
      {isLoading ? (
        <div className="flex flex-1 items-center justify-center">
          <p className="text-sm text-muted-foreground">Loading trace...</p>
        </div>
      ) : error || !trace ? (
        <div className="flex flex-1 items-center justify-center">
          <p className="text-sm text-destructive">Error loading trace</p>
        </div>
      ) : (
        <div className="flex flex-1 overflow-hidden">
          {/* Left: Tree view */}
          <div className="w-[320px] flex-shrink-0 overflow-y-auto border-r border-border bg-muted/30">
            <SpanTreeView trace={trace} selection={selection} onSelect={setSelection} />
          </div>

          {/* Right: Detail panel */}
          <div className="min-w-[280px] flex-1 overflow-hidden bg-background">
            <SpanInfoPanel
              projectId={projectId}
              trace={trace}
              selection={selection}
              onClose={onClose}
              dateFilter={dateFilter}
              customStartDate={customStartDate}
              customEndDate={customEndDate}
            />
          </div>

          {/* AI Chat overlay */}
          {aiChatOpen && (
            <AiChatOverlay
              projectId={projectId}
              traceId={traceId}
              onClose={() => setAiChatOpen(false)}
            />
          )}
        </div>
      )}
    </div>
  );
}
