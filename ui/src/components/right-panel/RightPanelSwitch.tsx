'use client';

import React, { useState, useEffect } from 'react';
import LogPanelSwitch from './log/LogPanelSwitch';
import Agent from './agent/Agent';
import TracePanelSwitch from './trace/TracePanelSwitch';
import ModeToggle, { ViewType } from './ModeToggle';
import { Span, Trace as TraceModel } from '@/models/trace';
import { useUser } from '@/hooks/useUser';

interface RightPanelSwitchProps {
  traceId?: string;
  spanIds?: string[];
  traceQueryStartTime?: Date;
  traceQueryEndTime?: Date;
  onTraceSelect?: (traceId: string) => void;
  onSpanClear?: () => void;
  onTraceSpansUpdate?: (spans: Span[]) => void;
}

export default function RightPanelSwitch({
  traceId,
  spanIds = [],
  traceQueryStartTime,
  traceQueryEndTime,
  onTraceSelect,
  onSpanClear,
  onTraceSpansUpdate
}: RightPanelSwitchProps) {
  const { getAuthState } = useUser();
  const [viewType, setViewType] = useState<ViewType>('log');
  const [spans, setSpans] = useState<Span[] | undefined>(undefined);
  const [traceDurations, setTraceDurations] = useState<number[]>([]);
  const [traceStartTimes, setTraceStartTimes] = useState<Date[]>([]);
  const [traceEndTimes, setTraceEndTimes] = useState<Date[]>([]);
  const [traceIDs, setTraceIDs] = useState<string[]>([]);
  const [tracePercentiles, setTracePercentiles] = useState<string[]>([]);
  const [allTraces, setAllTraces] = useState<TraceModel[]>([]);

  // Fetch traces only when time range changes, not when traceId changes
  useEffect(() => {
    const fetchTraces = async () => {
      try {
        // Use provided time range or generate default timestamps (last 10 minutes)
        // At the first loading, it's possible that the time range is not set,
        // so we use the default time range as 10 minutes.
        const endTime = traceQueryEndTime || new Date();
        const startTime = traceQueryStartTime || new Date(endTime.getTime() - 10 * 60 * 1000);

        const response = await fetch(`/api/list_trace?startTime=${startTime.toISOString()}&endTime=${endTime.toISOString()}`, {
          headers: {
            'Authorization': `Bearer ${getAuthState()}`,
          },
        });
        const result = await response.json();
        if (result.success) {
          // Get all trace data
          const traces = result.data as TraceModel[];
          setAllTraces(traces);
          setTraceIDs(traces.map(t => t.id));
          setTraceDurations(traces.map(t => t.duration));
          setTraceStartTimes(traces.map(t => new Date(t.start_time * 1000)));
          setTraceEndTimes(traces.map(t => new Date(t.end_time * 1000)));
          setTracePercentiles(traces.map(t => t.percentile));
        } else {
          // Clear all trace data on error
          setAllTraces([]);
          setTraceDurations([]);
          setTraceStartTimes([]);
          setTraceEndTimes([]);
          setTraceIDs([]);
          setTracePercentiles([]);
        }
      } catch {
        // Clear all trace data on error
        setAllTraces([]);
        setTraceDurations([]);
        setTraceStartTimes([]);
        setTraceEndTimes([]);
        setTraceIDs([]);
        setTracePercentiles([]);
      }
    };
    fetchTraces();
  }, [traceQueryStartTime, traceQueryEndTime]);

  // Update spans when traceId changes, using already fetched trace data
  useEffect(() => {
    if (traceId && allTraces.length > 0) {
      const trace: TraceModel | undefined = allTraces.find((t: TraceModel) => t.id === traceId);
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
        {viewType === 'log' ? (
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
            onTraceSelect={onTraceSelect}
            viewType={viewType}
          />
        ) : viewType === 'agent' ? (
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
