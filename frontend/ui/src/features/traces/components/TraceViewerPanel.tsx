"use client";

import { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Workflow, X, ArrowUp, ArrowDown, BotMessageSquare } from "lucide-react";
import { Button } from "@/components/ui/button";
import { getTrace } from "@/lib/api";
import type { TraceSelection } from "../types";
import { SpanTreeView } from "./SpanTreeView";
import { SpanInfoPanel } from "./SpanInfoPanel";
import { AiChatOverlay } from "@/features/ai-assistant/components/ai-chat-overlay";
import { useTraceStream } from "../hooks/use-trace-stream";
import { useTraceFindings, useRca } from "@/features/detectors/hooks/use-findings";

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
  /** When true, auto-opens chat with RCA loaded on mount (detector findings page only) */
  autoOpenRca?: boolean;
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
  autoOpenRca,
}: TraceViewerPanelProps) {
  const [selection, setSelection] = useState<TraceSelection>({ type: "trace" });
  const [aiChatOpen, setAiChatOpen] = useState(false);
  // "rca" = follow rcaSessionId once available; "fresh" = empty chat; null = closed
  const [chatMode, setChatMode] = useState<"rca" | "fresh" | null>(null);

  const { data: traceFindingsData } = useTraceFindings(projectId, traceId);
  // One finding per trace — take the first (and only) one
  const traceFinding = traceFindingsData?.findings?.[0];
  const hasFindings = !!traceFinding;

  // Fetch RCA for the trace-level finding to surface the Step 2 session in the chat
  const { data: rcaData } = useRca(projectId, traceFinding?.finding_id ?? "");
  const rcaSessionId = rcaData?.rca?.sessionId ?? undefined;

  // The session id passed into the chat overlay. Decoupled from chatMode so the
  // chat can open immediately on Alert click / autoOpenRca, even before useRca
  // has resolved — and updates in place once the session id arrives.
  const chatInitialSessionId = chatMode === "rca" ? rcaSessionId : undefined;

  // Auto-open chat in RCA mode when coming from the detector findings page.
  // Fires as soon as the panel mounts; rcaSessionId fills in via the prop above
  // when it loads.
  useEffect(() => {
    if (!autoOpenRca) return;
    setChatMode("rca");
    setAiChatOpen(true);
  }, [autoOpenRca]);

  const {
    data: trace,
    isLoading,
    error,
  } = useQuery({
    queryKey: ["trace", projectId, traceId],
    queryFn: () => getTrace(projectId, traceId, ""),
  });

  // Always stream — the backend is authoritative about when the trace is complete.
  // live.py will immediately emit trace_complete for already-finished traces,
  // so there is no cost to opening a connection for completed traces.
  useTraceStream(projectId, traceId, true);

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
        </div>
        <div className="flex items-center gap-1">
          {/* Alert | Agent | ↑ | ↓ | ✕ */}
          {hasFindings && (
            <button
              type="button"
              onClick={() => {
                setChatMode("rca");
                setAiChatOpen(true);
              }}
              className="rounded-md border border-red-300 bg-red-50 px-2 py-1 text-[11px] font-medium text-red-700 transition-colors hover:bg-red-100 dark:border-red-800 dark:bg-red-950/40 dark:text-red-400 dark:hover:bg-red-950/60"
              title="Findings detected — open root cause analysis"
            >
              Alert
            </button>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setChatMode("fresh"); // always fresh chat
              setAiChatOpen((v) => !v);
            }}
            className="h-7 w-7 p-0"
            title="AI Assistant"
          >
            <BotMessageSquare className="h-4 w-4" />
          </Button>
          <div className="w-1" />
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
          <div className="w-1" />
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

          {/* AI Chat overlay — chatMode controls whether RCA session is loaded */}
          {aiChatOpen && (
            <AiChatOverlay
              projectId={projectId}
              traceId={traceId}
              initialSessionId={chatInitialSessionId}
              onClose={() => {
                setAiChatOpen(false);
                setChatMode(null);
              }}
            />
          )}
        </div>
      )}
    </div>
  );
}
