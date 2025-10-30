"use client";

import { useState, useCallback, useEffect } from "react";
import Trace from "@/components/explore/Trace";
import ResizablePanel from "@/components/resizable/ResizablePanel";
import RightPanelSwitch from "@/components/right-panel/RightPanelSwitch";
import AgentPanel from "@/components/agent-panel/AgentPanel";
import { Span, Trace as TraceType } from "@/models/trace";
import {
  initializeProviders,
  loadProviderSelection,
  getProviderRegion,
} from "@/utils/provider";

export default function Explore() {
  const [selectedTraceIds, setSelectedTraceIds] = useState<string[]>([]);
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
  const [initialCollapseState, setInitialCollapseState] = useState<
    boolean | null
  >(null);
  const [isLogMode, setIsLogMode] = useState<boolean>(false);

  // Initialize providers and determine initial collapse state from URL
  useEffect(() => {
    initializeProviders();

    // Determine initial collapse state based on URL
    const url = new URL(window.location.href);
    const mode = url.searchParams.get("mode");
    const hasTraceId = url.searchParams.has("trace_id");

    // If URL has trace_id, force expand (trace mode)
    // Otherwise, check mode parameter, default to localStorage
    if (hasTraceId) {
      setInitialCollapseState(false);
      setIsLogMode(false);
      localStorage.setItem("traceCollapsed", "false");
      // Remove mode param if it exists
      if (mode) {
        url.searchParams.delete("mode");
        window.history.replaceState({}, "", url);
      }
    } else if (mode === "log") {
      setInitialCollapseState(true);
      setIsLogMode(true);
      localStorage.setItem("traceCollapsed", "true");
    } else {
      // Use localStorage or default to expanded
      const stored = localStorage.getItem("traceCollapsed");
      const isCollapsed = stored === "true";
      setInitialCollapseState(isCollapsed);
      setIsLogMode(isCollapsed);
    }
  }, []);

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
      selectedTraceIds.length > 0 &&
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
    } else if (selectedTraceIds.length === 0) {
      // Clear spans when no trace is selected
      setSelectedSpanIds([]);
    }
  }, [selectedTraceIds, currentTraceSpans]);

  const handleSpanSelect = (spanIds: string[]) => {
    setSelectedSpanIds(spanIds);
  };

  const handleSpanClear = () => {
    setSelectedSpanIds([]);
  };

  const handleTraceSelect = useCallback((traceIds: string[]) => {
    setSelectedTraceIds(traceIds);
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

  // Handle trace panel collapse/expand
  const handleLeftPanelCollapse = useCallback((isCollapsed: boolean) => {
    const url = new URL(window.location.href);

    if (isCollapsed) {
      // Clear selected traces and spans
      setSelectedTraceIds([]);
      setSelectedSpanIds([]);
      // Clear search terms when switching to log mode
      setMetadataSearchTerms([]);
      setLogSearchValue("");
      setIsLogMode(true);

      // Rebuild URL with mode=log at the end
      const traceProvider = url.searchParams.get("trace_provider");
      const traceRegion = url.searchParams.get("trace_region");
      const logProvider = url.searchParams.get("log_provider");
      const logRegion = url.searchParams.get("log_region");

      const newUrl = new URL(url.origin + url.pathname);
      if (traceProvider) {
        newUrl.searchParams.set("trace_provider", traceProvider);
      }
      if (traceRegion) {
        newUrl.searchParams.set("trace_region", traceRegion);
      }
      if (logProvider) {
        newUrl.searchParams.set("log_provider", logProvider);
      }
      if (logRegion) {
        newUrl.searchParams.set("log_region", logRegion);
      }
      newUrl.searchParams.set("mode", "log");

      window.history.replaceState({}, "", newUrl);
    } else {
      // Remove mode param when expanded (default is trace mode)
      setIsLogMode(false);
      url.searchParams.delete("mode");
      window.history.replaceState({}, "", url);
    }
  }, []);

  // TODO (xinwei): Add ProtectedRoute
  return (
    <AgentPanel
      traceId={selectedTraceIds.length === 1 ? selectedTraceIds[0] : undefined}
      traceIds={selectedTraceIds}
      spanIds={selectedSpanIds}
      queryStartTime={timeRange?.start}
      queryEndTime={timeRange?.end}
      onSpanSelect={(spanId) => handleSpanSelect([spanId])}
    >
      <ResizablePanel
        leftPanel={
          <Trace
            onTraceSelect={handleTraceSelect}
            onSpanSelect={handleSpanSelect}
            onTraceData={handleTraceData}
            onTracesUpdate={handleTracesUpdate}
            onLogSearchValueChange={handleLogSearchValueChange}
            onMetadataSearchTermsChange={handleMetadataSearchTermsChange}
            selectedTraceIds={selectedTraceIds}
            selectedSpanIds={selectedSpanIds}
          />
        }
        rightPanel={
          <RightPanelSwitch
            traceIds={selectedTraceIds}
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
            isLogMode={isLogMode}
          />
        }
        minLeftWidth={35}
        maxLeftWidth={60}
        defaultLeftWidth={46}
        initialCollapsed={initialCollapseState}
        onLeftPanelCollapse={handleLeftPanelCollapse}
      />
    </AgentPanel>
  );
}
