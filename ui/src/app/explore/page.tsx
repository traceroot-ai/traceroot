"use client";

import { useState, useCallback, useEffect } from "react";
import Trace from "@/components/explore/Trace";
import ExploreHeader from "@/components/explore/ExploreHeader";
import { TimeRange, TIME_RANGES } from "@/components/explore/TimeButton";
import {
  CustomTimeRange,
  TimezoneMode,
} from "@/components/explore/CustomTimeRangeDialog";
import { SearchCriterion } from "@/components/explore/SearchBar";
import ResizablePanel from "@/components/resizable/ResizablePanel";
import RightPanelSwitch from "@/components/right-panel/RightPanelSwitch";
import { ViewType } from "@/components/right-panel/ModeToggle";
import AgentPanel from "@/components/agent-panel/AgentPanel";
import { Span, Trace as TraceType } from "@/models/trace";
import { initializeProviders } from "@/utils/provider";

// Custom hook for persistent state with localStorage
function usePersistentState<T>(
  key: string,
  defaultValue: T,
): [T, (value: T | ((prev: T) => T)) => void] {
  const [state, setState] = useState<T>(() => {
    if (typeof window === "undefined") return defaultValue;
    try {
      const saved = localStorage.getItem(key);
      return saved !== null ? JSON.parse(saved) : defaultValue;
    } catch {
      return defaultValue;
    }
  });

  const setPersistentState = useCallback(
    (value: T | ((prev: T) => T)) => {
      setState((prev) => {
        const newValue =
          typeof value === "function" ? (value as (prev: T) => T)(prev) : value;
        try {
          localStorage.setItem(key, JSON.stringify(newValue));
        } catch {
          // Ignore localStorage errors
        }
        return newValue;
      });
    },
    [key],
  );

  return [state, setPersistentState];
}

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

  // Header state - lifted from Trace.tsx and RightPanelSwitch.tsx
  const [viewType, setViewType] = useState<ViewType>("log");
  const [selectedTimeRange, setSelectedTimeRange] = useState<TimeRange>(
    TIME_RANGES[0],
  );
  const [timezone, setTimezone] = useState<TimezoneMode>("utc");
  const [searchCriteria, setSearchCriteria] = useState<SearchCriterion[]>([]);
  const [loading, setLoading] = useState(true);
  const [hasTraceIdInUrl, setHasTraceIdInUrl] = useState(false);

  // Agent panel state - persisted to localStorage
  const [agentOpen, setAgentOpen] = usePersistentState("agentPanelOpen", false);

  const handleAgentToggle = useCallback(() => {
    setAgentOpen((prev) => !prev);
  }, [setAgentOpen]);

  // Initialize providers
  useEffect(() => {
    initializeProviders();
  }, []);

  // Check if trace_id is in URL on mount
  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);
    const traceIdParam = urlParams.get("trace_id");
    setHasTraceIdInUrl(!!traceIdParam);
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

  // Header handlers
  const handleTimeRangeSelect = useCallback((range: TimeRange) => {
    setSelectedTimeRange(range);
    setSelectedTraceIds([]);
    setSelectedSpanIds([]);
    setLoading(true);
  }, []);

  const handleCustomTimeRangeSelect = useCallback(
    (customRange: CustomTimeRange, selectedTimezone: TimezoneMode) => {
      setTimezone(selectedTimezone);

      const customTimeRange: TimeRange = {
        label: customRange.label,
        isCustom: true,
        customRange: customRange,
      };

      if (customRange.type === "relative") {
        customTimeRange.minutes = customRange.minutes;
      }

      setSelectedTimeRange(customTimeRange);
      setSelectedTraceIds([]);
      setSelectedSpanIds([]);
      setLoading(true);
    },
    [],
  );

  const handleSearch = useCallback((criteria: SearchCriterion[]) => {
    setSearchCriteria(criteria);
    setLoading(true);
  }, []);

  const handleClearSearch = useCallback(() => {
    setSearchCriteria([]);
    setLogSearchValue("");
    handleLogSearchValueChange("");
    setLoading(true);
  }, [handleLogSearchValueChange]);

  const handleRefresh = useCallback(() => {
    setSelectedTraceIds([]);
    setSelectedSpanIds([]);
    setLoading(true);
  }, []);

  const handleLoadingChange = useCallback((isLoading: boolean) => {
    setLoading(isLoading);
  }, []);

  // TODO (xinwei): Add ProtectedRoute
  return (
    <div className="h-screen flex flex-col">
      <ExploreHeader
        onSearch={handleSearch}
        onClearSearch={handleClearSearch}
        onLogSearchValueChange={handleLogSearchValueChange}
        onMetadataSearchTermsChange={handleMetadataSearchTermsChange}
        searchDisabled={loading || hasTraceIdInUrl}
        selectedTimeRange={selectedTimeRange}
        onTimeRangeSelect={handleTimeRangeSelect}
        onCustomTimeRangeSelect={handleCustomTimeRangeSelect}
        currentTimezone={timezone}
        timeDisabled={loading || hasTraceIdInUrl}
        onRefresh={handleRefresh}
        refreshDisabled={loading || hasTraceIdInUrl}
        viewType={viewType}
        onViewTypeChange={setViewType}
        agentOpen={agentOpen}
        onAgentToggle={handleAgentToggle}
      />
      <div className="flex-1 overflow-hidden">
        <AgentPanel
          traceId={
            selectedTraceIds.length === 1 ? selectedTraceIds[0] : undefined
          }
          traceIds={selectedTraceIds}
          spanIds={selectedSpanIds}
          queryStartTime={timeRange?.start}
          queryEndTime={timeRange?.end}
          onSpanSelect={(spanId) => handleSpanSelect([spanId])}
          isOpen={agentOpen}
          onToggle={handleAgentToggle}
        >
          <ResizablePanel
            leftPanel={
              <Trace
                onTraceSelect={handleTraceSelect}
                onSpanSelect={handleSpanSelect}
                onTraceData={handleTraceData}
                onTracesUpdate={handleTracesUpdate}
                selectedTraceIds={selectedTraceIds}
                selectedSpanIds={selectedSpanIds}
                selectedTimeRange={selectedTimeRange}
                timezone={timezone}
                searchCriteria={searchCriteria}
                loading={loading}
                onLoadingChange={handleLoadingChange}
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
                viewType={viewType}
              />
            }
            minLeftWidth={35}
            maxLeftWidth={60}
            defaultLeftWidth={46}
          />
        </AgentPanel>
      </div>
    </div>
  );
}
