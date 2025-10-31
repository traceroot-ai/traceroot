"use client";

import React, { useState, useEffect } from "react";
import LogPanelSwitch from "./log/LogPanelSwitch";
import TracePanelSwitch from "./trace/TracePanelSwitch";
import LogModeLayout from "./log/LogModeLayout";
import ModeToggle, { ViewType } from "./ModeToggle";
import { Span, Trace as TraceModel } from "@/models/trace";
import { useAuth } from "@/lib/auth";

interface RightPanelSwitchProps {
  traceIds?: string[];
  spanIds?: string[];
  traceQueryStartTime?: Date;
  traceQueryEndTime?: Date;
  allTraces?: TraceModel[];
  logSearchValue?: string;
  metadataSearchTerms?: { category: string; value: string }[];
  onTraceSelect?: (traceIds: string[]) => void;
  onSpanClear?: () => void;
  onTraceSpansUpdate?: (spans: Span[]) => void;
  onSpanSelect?: (spanIds: string[]) => void;
  isLogMode?: boolean;
}

export default function RightPanelSwitch({
  traceIds = [],
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
  isLogMode = false,
}: RightPanelSwitchProps) {
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

  // Update spans when traceIds changes, using already fetched trace data
  // For single trace selection, we load the spans from that trace.
  // For multiple traces, we merge all spans from selected traces.
  useEffect(() => {
    if (traceIds.length > 0 && allTraces.length > 0) {
      if (traceIds.length === 1) {
        // Single trace: load spans from that trace
        const trace: TraceModel | undefined = allTraces.find(
          (t: TraceModel) => t.id === traceIds[0],
        );
        const newSpans = trace ? trace.spans : undefined;
        setSpans(newSpans);
        // Notify parent of spans update for validation
        onTraceSpansUpdate?.(newSpans || []);
      } else {
        // Multiple traces: merge all spans from selected traces
        const allSpans: Span[] = [];
        traceIds.forEach((traceId) => {
          const trace = allTraces.find((t) => t.id === traceId);
          if (trace && trace.spans) {
            allSpans.push(...trace.spans);
          }
        });
        setSpans(allSpans.length > 0 ? allSpans : undefined);
        onTraceSpansUpdate?.(allSpans);
      }
    } else {
      setSpans(undefined);
      onTraceSpansUpdate?.([]);
    }
  }, [traceIds, allTraces, onTraceSpansUpdate]);

  // If in log mode (trace collapsed), render LogModeLayout
  // Don't pass trace mode time range - let log mode use its own default
  if (isLogMode) {
    return (
      <LogModeLayout
        key="log-mode"
        logSearchValue={logSearchValue}
        metadataSearchTerms={metadataSearchTerms}
      />
    );
  }

  // Normal mode with ModeToggle
  return (
    <div className="h-screen flex flex-col">
      <ModeToggle viewType={viewType} onViewTypeChange={setViewType} />

      {/* View content */}
      <div className="flex-1 overflow-hidden">
        {/* Log view */}
        {viewType === "log" && (
          <LogPanelSwitch
            traceIds={traceIds}
            spanIds={spanIds}
            traceQueryStartTime={traceQueryStartTime}
            traceQueryEndTime={traceQueryEndTime}
            segments={spans}
            allTraces={allTraces}
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

        {/* Trace view */}
        {viewType === "trace" && (
          <TracePanelSwitch
            traceId={traceIds.length === 1 ? traceIds[0] : undefined}
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
