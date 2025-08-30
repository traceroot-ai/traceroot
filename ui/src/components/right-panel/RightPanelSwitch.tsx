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

  return (
    <div className="h-screen flex flex-col">
      <ModeToggle viewType={viewType} onViewTypeChange={setViewType} />

      {/* View content */}
      <div className="flex-1 overflow-hidden">
        {viewType === "log" ? (
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
        ) : viewType === "agent" ? (
          <Agent
            traceId={traceId}
            spanIds={spanIds}
            queryStartTime={traceQueryStartTime}
            queryEndTime={traceQueryEndTime}
          />
        ) : (
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
