"use client";

import { useState, useCallback, useEffect } from "react";
import Trace from "@/components/explore/Trace";
import ResizablePanel from "@/components/resizable/ResizablePanel";
import RightPanelSwitch from "@/components/right-panel/RightPanelSwitch";
import { Span, Trace as TraceType } from "@/models/trace";
import { initializeProviders } from "@/utils/provider";

export default function Explore() {
  // Initialize providers from URL on mount, or use defaults
  useEffect(() => {
    initializeProviders();
  }, []);
  const [selectedTraceId, setSelectedTraceId] = useState<string | null>(null);
  const [selectedSpanIds, setSelectedSpanIds] = useState<string[]>([]);
  const [timeRange, setTimeRange] = useState<{ start: Date; end: Date } | null>(
    null,
  );
  const [currentTraceSpans, setCurrentTraceSpans] = useState<Span[]>([]);
  const [allTraces, setAllTraces] = useState<TraceType[]>([]);
  const [logSearchValue, setLogSearchValue] = useState<string>("");
  const [metadataSearchTerms, setMetadataSearchTerms] = useState<
    { category: string; value: string }[]
  >([]);

  // Helper function to get all span IDs from a trace recursively
  const getAllSpanIds = (spans: Span[]): string[] => {
    const spanIds: string[] = [];
    const collectSpanIds = (spanList: Span[]) => {
      spanList.forEach((span) => {
        spanIds.push(span.id);
        if (span.spans && span.spans.length > 0) {
          collectSpanIds(span.spans);
        }
      });
    };
    collectSpanIds(spans);
    return spanIds;
  };

  // Validate selected spans when trace changes
  useEffect(() => {
    if (
      selectedTraceId &&
      currentTraceSpans.length > 0 &&
      selectedSpanIds.length > 0
    ) {
      const validSpanIds = getAllSpanIds(currentTraceSpans);
      const validSelectedSpans = selectedSpanIds.filter((spanId) =>
        validSpanIds.includes(spanId),
      );

      // If some selected spans are no longer valid, update the selection
      if (validSelectedSpans.length !== selectedSpanIds.length) {
        setSelectedSpanIds(validSelectedSpans);
      }
    } else if (!selectedTraceId) {
      // Clear spans when no trace is selected
      setSelectedSpanIds([]);
    }
  }, [selectedTraceId, currentTraceSpans]);

  const handleSpanSelect = (spanIds: string[]) => {
    setSelectedSpanIds(spanIds);
  };

  const handleSpanClear = () => {
    setSelectedSpanIds([]);
  };

  const handleTraceSelect = useCallback((traceId: string | null) => {
    setSelectedTraceId(traceId);
    // Note: We don't clear spans here - the useEffect above will validate them
  }, []);

  const handleTraceData = useCallback((startTime: Date, endTime: Date) => {
    setTimeRange({ start: startTime, end: endTime });
  }, []);

  const handleTracesUpdate = useCallback((traces: TraceType[]) => {
    setAllTraces(traces);
  }, []);

  // Callback to receive current trace spans from RightPanelSwitch
  const handleTraceSpansUpdate = useCallback((spans: Span[]) => {
    setCurrentTraceSpans(spans || []);
  }, []);

  // Callback to receive log search value from SearchBar
  const handleLogSearchValueChange = useCallback((value: string) => {
    setLogSearchValue(value);
  }, []);

  // Callback to receive metadata search terms from SearchBar
  const handleMetadataSearchTermsChange = useCallback(
    (terms: { category: string; value: string }[]) => {
      setMetadataSearchTerms(terms);
    },
    [],
  );

  // TODO (xinwei): Add ProtectedRoute
  return (
    <ResizablePanel
      leftPanel={
        <Trace
          onTraceSelect={handleTraceSelect}
          onSpanSelect={handleSpanSelect}
          onTraceData={handleTraceData}
          onTracesUpdate={handleTracesUpdate}
          onLogSearchValueChange={handleLogSearchValueChange}
          onMetadataSearchTermsChange={handleMetadataSearchTermsChange}
          selectedTraceId={selectedTraceId}
          selectedSpanIds={selectedSpanIds}
        />
      }
      rightPanel={
        <RightPanelSwitch
          traceId={selectedTraceId || undefined}
          spanIds={selectedSpanIds}
          traceQueryStartTime={timeRange?.start}
          traceQueryEndTime={timeRange?.end}
          allTraces={allTraces}
          logSearchValue={logSearchValue}
          metadataSearchTerms={metadataSearchTerms}
          onTraceSelect={handleTraceSelect}
          onSpanClear={handleSpanClear}
          onTraceSpansUpdate={handleTraceSpansUpdate}
          onSpanSelect={handleSpanSelect}
        />
      }
      minLeftWidth={35}
      maxLeftWidth={60}
      defaultLeftWidth={46}
    />
  );
}
