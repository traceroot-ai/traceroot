"use client";

import React, { useState, useEffect } from "react";
import LogPanelSwitch from "./log/LogPanelSwitch";
import Agent from "./agent/Agent";
import TracePanelSwitch from "./trace/TracePanelSwitch";
import ModeToggle, { ViewType } from "./ModeToggle";
import { Span, Trace as TraceModel } from "@/models/trace";
import { useUser } from "@/hooks/useUser";

interface RightPanelSwitchProps {
  traceId?: string;
  spanIds?: string[];
  traceQueryStartTime?: Date;
  traceQueryEndTime?: Date;
  allTraces?: TraceModel[];
  logSearchValue?: string;
  metadataSearchTerms?: { category: string; value: string }[];
  onTraceSelect?: (traceId: string) => void;
  onSpanClear?: () => void;
  onTraceSpansUpdate?: (spans: Span[]) => void;
  onSpanSelect?: (spanIds: string[]) => void;
}

export default function RightPanelSwitch({
  traceId,
  spanIds = [],
  traceQueryStartTime,
  traceQueryEndTime,
  allTraces = [],
  logSearchValue = "",
  metadataSearchTerms = [],
  onTraceSelect,
  onSpanClear,
  onTraceSpansUpdate,
  onSpanSelect,
}: RightPanelSwitchProps) {
  const { getAuthState } = useUser();
  const [viewType, setViewType] = useState<ViewType>("log");
  const [spans, setSpans] = useState<Span[] | undefined>(undefined);
  const [traceDurations, setTraceDurations] = useState<number[]>([]);
  const [traceStartTimes, setTraceStartTimes] = useState<Date[]>([]);
  const [traceEndTimes, setTraceEndTimes] = useState<Date[]>([]);
  const [traceIDs, setTraceIDs] = useState<string[]>([]);
  const [tracePercentiles, setTracePercentiles] = useState<string[]>([]);

  // Update trace data when allTraces prop changes
  useEffect(() => {
    if (allTraces && allTraces.length > 0) {
      setTraceIDs(allTraces.map((t) => t.id));
      setTraceDurations(allTraces.map((t) => t.duration));
      setTraceStartTimes(allTraces.map((t) => new Date(t.start_time * 1000)));
      setTraceEndTimes(allTraces.map((t) => new Date(t.end_time * 1000)));
      setTracePercentiles(allTraces.map((t) => t.percentile));
    } else {
      // Clear all trace data when no traces provided
      setTraceDurations([]);
      setTraceStartTimes([]);
      setTraceEndTimes([]);
      setTraceIDs([]);
      setTracePercentiles([]);
    }
  }, [allTraces]);

  // Update spans when traceId changes, using already fetched trace data
  useEffect(() => {
    if (traceId && allTraces.length > 0) {
      const trace: TraceModel | undefined = allTraces.find(
        (t: TraceModel) => t.id === traceId,
      );
      const newSpans = trace ? trace.spans : undefined;
      setSpans(newSpans);
      // Notify parent of spans update for validation
      onTraceSpansUpdate?.(newSpans || []);
    } else {
      setSpans(undefined);
      onTraceSpansUpdate?.([]);
    }
  }, [traceId, allTraces, onTraceSpansUpdate]);

  // Handler for span selection from chat references
  const handleSpanSelectFromChat = (spanId: string) => {
    if (!spans) {
      onSpanSelect?.([spanId]);
      return;
    }

    // Recursively find the span and get all its child span IDs
    const findSpanWithChildren = (
      spanNodes: Span[],
      targetId: string,
    ): { span: Span; childIds: string[] } | null => {
      for (const span of spanNodes) {
        if (span.id === targetId) {
          // Found the target span, now get all child IDs recursively
          const getAllChildSpanIds = (spanNode: Span): string[] => {
            const childIds: string[] = [];
            if (spanNode.spans) {
              for (const childSpan of spanNode.spans) {
                childIds.push(childSpan.id);
                childIds.push(...getAllChildSpanIds(childSpan));
              }
            }
            return childIds;
          };

          return { span, childIds: getAllChildSpanIds(span) };
        }

        // Recursively search in child spans
        if (span.spans) {
          const result = findSpanWithChildren(span.spans, targetId);
          if (result) return result;
        }
      }
      return null;
    };

    const result = findSpanWithChildren(spans, spanId);
    if (result) {
      // Include both the parent span and all child spans (same as Trace component)
      const allSpanIds = [result.span.id, ...result.childIds];
      onSpanSelect?.(allSpanIds);
    } else {
      // Fallback if span not found in current trace
      onSpanSelect?.([spanId]);
    }
  };

  // Handler for view type change from chat references
  const handleViewTypeChangeFromChat = (newViewType: ViewType) => {
    setViewType(newViewType);
  };

  return (
    <div className="h-screen flex flex-col">
      <ModeToggle viewType={viewType} onViewTypeChange={setViewType} />

      {/* View content */}
      <div className="flex-1 overflow-hidden">
        {/* Log view - conditionally rendered */}
        {viewType === "log" && (
          <LogPanelSwitch
            traceId={traceId}
            spanIds={spanIds}
            traceQueryStartTime={traceQueryStartTime}
            traceQueryEndTime={traceQueryEndTime}
            segments={spans}
            traceDurations={traceDurations}
            traceStartTimes={traceStartTimes}
            traceEndTimes={traceEndTimes}
            traceIDs={traceIDs}
            tracePercentiles={tracePercentiles}
            logSearchValue={logSearchValue}
            metadataSearchTerms={metadataSearchTerms}
            onTraceSelect={onTraceSelect}
            viewType={viewType}
          />
        )}

        {/*
          Agent view - always rendered in same location to persist chat state
          This ensures the Agent component never unmounts, preserving:
          - Chat tabs and their content
          - Active chat selection
          - Input messages and loading states
          - All other component state across view switches
        */}
        <div
          style={
            viewType !== "agent"
              ? {
                  // When hidden: overlay invisibly behind other content
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  height: "100%",
                  visibility: "hidden", // Completely invisible
                  pointerEvents: "none", // No interaction when hidden
                  zIndex: -1, // Behind other content
                }
              : {
                  // When visible: normal flex child with full height
                  height: "100%",
                }
          }
        >
          <Agent
            traceId={traceId}
            spanIds={spanIds}
            queryStartTime={traceQueryStartTime}
            queryEndTime={traceQueryEndTime}
            onSpanSelect={handleSpanSelectFromChat}
            onViewTypeChange={handleViewTypeChangeFromChat}
          />
        </div>

        {/* Trace view - conditionally rendered */}
        {viewType === "trace" && (
          <TracePanelSwitch
            traceId={traceId}
            spanIds={spanIds}
            traceQueryStartTime={traceQueryStartTime}
            traceQueryEndTime={traceQueryEndTime}
            segments={spans}
            traceDurations={traceDurations}
            traceStartTimes={traceStartTimes}
            traceEndTimes={traceEndTimes}
            traceIDs={traceIDs}
            tracePercentiles={tracePercentiles}
            onTraceSelect={onTraceSelect}
          />
        )}
      </div>
    </div>
  );
}
