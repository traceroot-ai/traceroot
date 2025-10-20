"use client";

import React, { useEffect, useState, useRef, useCallback } from "react";
import { Trace as TraceType } from "@/models/trace";
import Span from "./span/Span";
import TimeButton, { TimeRange, TIME_RANGES } from "./TimeButton";
import RefreshButton from "./RefreshButton";
import SearchBar, { SearchCriterion } from "./SearchBar";
import {
  PERCENTILE_COLORS,
  getPercentileColor,
  PercentileKey,
} from "@/constants/colors";
import { fadeInAnimationStyles } from "@/constants/animations";
import { IoWarningOutline, IoLogoJavascript } from "react-icons/io5";
import { MdErrorOutline } from "react-icons/md";
import { FaPython, FaJava } from "react-icons/fa";
import { SiTypescript } from "react-icons/si";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/shadcn-io/spinner";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { CirclePlus, CircleMinus, Share2, Copy, Check } from "lucide-react";
import { buildProviderParams } from "@/utils/provider";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

interface TraceProps {
  onTraceSelect?: (traceId: string | null) => void;
  onSelectedTracesChange?: (traceIds: string[]) => void;
  onSpanSelect?: (spanIds: string[]) => void;
  onTraceData?: (startTime: Date, endTime: Date) => void;
  onTracesUpdate?: (traces: TraceType[]) => void;
  onLogSearchValueChange?: (value: string) => void;
  onMetadataSearchTermsChange?: (
    terms: { category: string; value: string }[],
  ) => void;
  selectedTraceId?: string | null;
  selectedSpanIds?: string[];
  traceQueryStartTime?: Date;
  traceQueryEndTime?: Date;
}

export function formatDateTime(ts: number) {
  const date = new Date(ts * 1000);
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];

  const y = date.getFullYear();
  const m = months[date.getMonth()];
  const d = date.getDate();
  const h = String(date.getHours()).padStart(2, "0");
  const min = String(date.getMinutes()).padStart(2, "0");
  const s = String(date.getSeconds()).padStart(2, "0");

  // Add ordinal suffix to day
  const getOrdinalSuffix = (day: number) => {
    if (day >= 11 && day <= 13) return "th";
    switch (day % 10) {
      case 1:
        return "st";
      case 2:
        return "nd";
      case 3:
        return "rd";
      default:
        return "th";
    }
  };

  return `${y} ${m} ${d}${getOrdinalSuffix(d)} ${h}:${min}:${s}`;
}

export const Trace: React.FC<TraceProps> = ({
  onTraceSelect,
  onSelectedTracesChange,
  onSpanSelect,
  onTraceData,
  onTracesUpdate,
  onLogSearchValueChange,
  onMetadataSearchTermsChange,
  selectedTraceId: externalSelectedTraceId,
  selectedSpanIds: externalSelectedSpanIds,
  traceQueryStartTime,
  traceQueryEndTime,
}) => {
  const [traces, setTraces] = useState<TraceType[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedTimeRange, setSelectedTimeRange] = useState<TimeRange>(
    TIME_RANGES[0],
  );

  // Multi-trace state
  const [selectedTraceIds, setSelectedTraceIds] = useState<Set<string>>(
    new Set(),
  );
  const [expandedTraceIds, setExpandedTraceIds] = useState<Set<string>>(
    new Set(),
  );
  const [activeTraceId, setActiveTraceId] = useState<string | null>(null);

  // Span state
  const [selectedSpanId, setSelectedSpanId] = useState<string | null>(null);
  const [selectedSpanIds, setSelectedSpanIds] = useState<string[]>([]);
  const [expandedSpans, setExpandedSpans] = useState<Set<string>>(new Set());

  // Search and other state
  const [searchCriteria, setSearchCriteria] = useState<SearchCriterion[]>([]);
  const [logSearchValue, setLogSearchValue] = useState<string>("");
  const timeRangeRef = useRef<{ start: Date; end: Date } | null>(null);
  const [shareDialogOpen, setShareDialogOpen] = useState<boolean>(false);
  const [shareTraceId, setShareTraceId] = useState<string | null>(null);
  const [copied, setCopied] = useState<boolean>(false);
  const [hasTraceIdInUrl, setHasTraceIdInUrl] = useState<boolean>(false);
  const [nextPaginationToken, setNextPaginationToken] = useState<string | null>(
    null,
  );
  const [hasMore, setHasMore] = useState<boolean>(false);
  const [loadingMore, setLoadingMore] = useState<boolean>(false);
  const previousTraceCountRef = useRef<number>(0);

  const handleTimeRangeSelect = (range: TimeRange) => {
    setSelectedTimeRange(range);
    setSelectedTraceIds(new Set());
    setExpandedTraceIds(new Set());
    setActiveTraceId(null);
    setSelectedSpanId(null);
    setSelectedSpanIds([]);
    setExpandedSpans(new Set());
    setNextPaginationToken(null);
    setHasMore(false);
    previousTraceCountRef.current = 0;
    onTraceSelect?.(null);
    onSpanSelect?.([]);
    onSelectedTracesChange?.([]);
    setLoading(true);
  };

  const handleSearch = (criteria: SearchCriterion[]) => {
    setSearchCriteria(criteria);
    setNextPaginationToken(null);
    setHasMore(false);
    previousTraceCountRef.current = 0;
    setLoading(true); // Trigger a new API call when search criteria change
  };

  const handleClearSearch = () => {
    setSearchCriteria([]);
    setLogSearchValue("");
    setExpandedSpans(new Set());
    setNextPaginationToken(null);
    setHasMore(false);
    previousTraceCountRef.current = 0;
    onLogSearchValueChange?.("");
    setLoading(true); // Trigger a new API call when search is cleared
  };

  const handleLogSearchValueChange = (value: string) => {
    setLogSearchValue(value);
    onLogSearchValueChange?.(value);
  };

  const fetchTraces = useCallback(
    async (paginationToken?: string | null) => {
      const isLoadingMore = !!paginationToken;

      if (isLoadingMore) {
        setLoadingMore(true);
      }

      try {
        let startTime: Date;
        let endTime: Date;

        // Use provided time range if available, otherwise use time range selector
        if (traceQueryStartTime && traceQueryEndTime) {
          startTime = traceQueryStartTime;
          endTime = traceQueryEndTime;
        } else {
          endTime = new Date();
          startTime = new Date(endTime);
          startTime.setMinutes(
            endTime.getMinutes() - selectedTimeRange.minutes,
          );
        }

        timeRangeRef.current = {
          start: new Date(startTime),
          end: new Date(endTime),
        };

        // Build API URL with search criteria
        let apiUrl = `/api/list_trace?startTime=${startTime.toISOString()}&endTime=${endTime.toISOString()}`;

        // Add provider information from URL (always required)
        apiUrl += `&${buildProviderParams()}`;

        // Check if trace_id is in URL parameters
        const urlParams = new URLSearchParams(window.location.search);
        const traceIdParam = urlParams.get("trace_id");
        if (traceIdParam) {
          apiUrl += `&trace_id=${encodeURIComponent(traceIdParam)}`;
        }

        // Add search criteria to the API call
        searchCriteria.forEach((criterion) => {
          apiUrl += `&categories=${encodeURIComponent(criterion.category)}`;
          apiUrl += `&values=${encodeURIComponent(criterion.value)}`;
          apiUrl += `&operations=${encodeURIComponent(criterion.operation)}`;
        });

        // Add pagination token if provided
        if (paginationToken) {
          apiUrl += `&pagination_token=${encodeURIComponent(paginationToken)}`;
        }

        const response = await fetch(apiUrl);
        const result = await response.json();

        if (!result.success) {
          throw new Error(result.error || "Failed to fetch traces");
        }

        // Store pagination info
        setNextPaginationToken(result.next_pagination_token || null);
        setHasMore(result.has_more || false);

        // If loading more, append to existing traces; otherwise replace
        if (isLoadingMore) {
          setTraces((prevTraces) => {
            const updatedTraces = [...prevTraces, ...result.data];
            previousTraceCountRef.current = prevTraces.length;
            return updatedTraces;
          });
        } else {
          setTraces(result.data);
          previousTraceCountRef.current = 0;

          // If trace_id in URL, auto-select that trace
          if (traceIdParam && result.data.length > 0) {
            const traceToSelect = result.data.find(
              (trace: TraceType) => trace.id === traceIdParam,
            );
            if (traceToSelect) {
              setActiveTraceId(traceToSelect.id);
              setSelectedTraceIds(new Set([traceToSelect.id]));
              setExpandedTraceIds(new Set([traceToSelect.id]));
              onTraceSelect?.(traceToSelect.id);
            }
          } else {
            // Check if currently active trace is still in the filtered results
            if (activeTraceId) {
              const isActiveTraceInResults = result.data.some(
                (trace: TraceType) => trace.id === activeTraceId,
              );

              if (!isActiveTraceInResults) {
                // Clear active trace if not in new results
                setActiveTraceId(null);
                setSelectedSpanId(null);
                setSelectedSpanIds([]);
                onTraceSelect?.(null);
                onSpanSelect?.([]);
              }
            }
          }

          onTraceData?.(timeRangeRef.current.start, timeRangeRef.current.end);
          onTracesUpdate?.(result.data);
        }
      } catch (err) {
        setError(
          err instanceof Error
            ? err.message
            : "An error occurred while fetching traces",
        );
      } finally {
        if (isLoadingMore) {
          setLoadingMore(false);
        } else {
          setLoading(false);
        }
      }
    },
    [
      selectedTimeRange,
      traceQueryStartTime,
      traceQueryEndTime,
      searchCriteria,
      activeTraceId,
      onTraceData,
      onTracesUpdate,
      onTraceSelect,
      onSpanSelect,
    ],
  );

  useEffect(() => {
    if (!loading) return;
    fetchTraces();
  }, [loading, fetchTraces]);

  // Auto-select and auto-expand all traces when they load initially
  // Only runs on initial load, not when loading more traces
  useEffect(() => {
    if (traces.length > 0 && !hasTraceIdInUrl && !loading && !loadingMore) {
      // Only auto-select if we don't have any selections yet
      if (selectedTraceIds.size === 0) {
        const allTraceIds = traces.map((trace) => trace.id);

        setSelectedTraceIds(new Set(allTraceIds));
        setExpandedTraceIds(new Set(allTraceIds));
      }
    }
  }, [traces, hasTraceIdInUrl, loading, loadingMore, selectedTraceIds.size]);

  // Notify parent of selected traces changes
  useEffect(() => {
    onSelectedTracesChange?.(Array.from(selectedTraceIds));
  }, [selectedTraceIds, onSelectedTracesChange]);

  useEffect(() => {
    setLoading(true);
  }, []);

  // Check if trace_id is in URL on mount
  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);
    const traceIdParam = urlParams.get("trace_id");
    setHasTraceIdInUrl(!!traceIdParam);
  }, []);

  const getPercentileTag = (percentile: string) => {
    // Ensure the percentile is a valid key
    if (!Object.keys(PERCENTILE_COLORS).includes(percentile)) {
      return null;
    }
    const color = getPercentileColor(percentile as PercentileKey);
    return (
      <span
        className="inline-flex w-12 h-5 mr-2 text-xs font-mono items-center justify-center rounded-md"
        style={{
          background: `${color}`,
          color: "black",
          boxShadow: "inset 0 1px 1px rgba(255, 255, 255, 0.2)",
        }}
      >
        {percentile}
      </span>
    );
  };

  const handleTraceClick = (traceId: string) => {
    const isCurrentlySelected = selectedTraceIds.has(traceId);

    if (isCurrentlySelected) {
      // Deselecting - remove from selection
      setSelectedTraceIds((prev) => {
        const newSet = new Set(prev);
        newSet.delete(traceId);
        return newSet;
      });

      // Also collapse the trace spans
      setExpandedTraceIds((prev) => {
        const newSet = new Set(prev);
        newSet.delete(traceId);
        return newSet;
      });

      // If this was the active trace, set another one as active or clear
      if (activeTraceId === traceId) {
        const remainingTraces = Array.from(selectedTraceIds).filter(
          (id) => id !== traceId,
        );
        if (remainingTraces.length > 0) {
          // Set the first remaining trace as active
          setActiveTraceId(remainingTraces[0]);
          onTraceSelect?.(remainingTraces[0]);
        } else {
          // No traces left, clear everything
          setActiveTraceId(null);
          onTraceSelect?.(null);
        }
        setSelectedSpanId(null);
        setSelectedSpanIds([]);
        onSpanSelect?.([]);
      }
    } else {
      // Selecting - add to selection
      setSelectedTraceIds((prev) => {
        const newSet = new Set(prev);
        newSet.add(traceId);
        return newSet;
      });

      // Also expand the trace spans
      setExpandedTraceIds((prev) => {
        const newSet = new Set(prev);
        newSet.add(traceId);
        return newSet;
      });

      // Make it the active trace for span interaction
      setActiveTraceId(traceId);
      onTraceSelect?.(traceId);

      // Clear span selection when switching active trace
      setSelectedSpanId(null);
      setSelectedSpanIds([]);
      onSpanSelect?.([]);
    }
  };

  const handleTraceExpandToggle = (
    traceId: string,
    event: React.MouseEvent,
  ) => {
    event.stopPropagation(); // Prevent trace selection

    setExpandedTraceIds((prev) => {
      const newSet = new Set(prev);

      if (newSet.has(traceId)) {
        newSet.delete(traceId); // Collapse spans
      } else {
        newSet.add(traceId); // Expand spans
      }

      return newSet;
    });
  };

  const handleSpanExpandToggle = (spanId: string, event: React.MouseEvent) => {
    event.stopPropagation(); // Prevent span selection
    setExpandedSpans((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(spanId)) {
        // If span is in the set (collapsed), remove it (expand it)
        newSet.delete(spanId);
      } else {
        // If span is not in the set (expanded), add it (collapse it)
        newSet.add(spanId);
      }
      return newSet;
    });
  };

  const handleSpanSelect = (
    spanId: string,
    childSpanIds: string[],
    traceId: string,
  ) => {
    const newSelectedSpanId = selectedSpanId === spanId ? null : spanId;
    setSelectedSpanId(newSelectedSpanId);

    const allSpanIds = newSelectedSpanId
      ? [newSelectedSpanId, ...childSpanIds]
      : [];
    setSelectedSpanIds(allSpanIds);

    // Set this trace as the active trace when a span is selected
    if (newSelectedSpanId) {
      setActiveTraceId(traceId);
      onTraceSelect?.(traceId);
    }

    onSpanSelect?.(allSpanIds);
  };

  const handleRefresh = () => {
    setSelectedTraceIds(new Set());
    setExpandedTraceIds(new Set());
    setActiveTraceId(null);
    setSelectedSpanId(null);
    setSelectedSpanIds([]);
    setExpandedSpans(new Set());
    setNextPaginationToken(null);
    setHasMore(false);
    previousTraceCountRef.current = 0;
    onTraceSelect?.(null);
    onSpanSelect?.([]);
    onSelectedTracesChange?.([]);
    setLoading(true);
  };

  const handleLoadMore = () => {
    if (nextPaginationToken && !loadingMore) {
      fetchTraces(nextPaginationToken);
    }
  };

  const handleShareClick = (traceId: string, event: React.MouseEvent) => {
    event.stopPropagation(); // Prevent trace selection
    setShareTraceId(traceId);
    setShareDialogOpen(true);
    setCopied(false);
  };

  const getShareUrl = (traceId: string): string => {
    const baseUrl = window.location.origin + window.location.pathname;
    const params = new URLSearchParams(window.location.search);
    params.set("trace_id", traceId);
    return `${baseUrl}?${params.toString()}`;
  };

  const handleCopyUrl = async () => {
    if (shareTraceId) {
      const url = getShareUrl(shareTraceId);
      try {
        await navigator.clipboard.writeText(url);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      } catch (err) {
        console.error("Failed to copy:", err);
      }
    }
  };

  useEffect(() => {
    if (externalSelectedTraceId !== activeTraceId) {
      setActiveTraceId(externalSelectedTraceId || null);
    }
  }, [externalSelectedTraceId, activeTraceId]);

  // Sync external selectedSpanIds with internal state
  useEffect(() => {
    if (
      externalSelectedSpanIds &&
      JSON.stringify(externalSelectedSpanIds) !==
        JSON.stringify(selectedSpanIds)
    ) {
      setSelectedSpanIds(externalSelectedSpanIds);
      // Also set the first span as selected span for consistency
      if (externalSelectedSpanIds.length > 0) {
        setSelectedSpanId(externalSelectedSpanIds[0]);
      } else {
        setSelectedSpanId(null);
      }
    }
  }, [externalSelectedSpanIds, selectedSpanIds]);

  // Clean up expand state when traces change
  useEffect(() => {
    if (traces.length > 0) {
      // Collect all valid span IDs from current traces
      const allValidSpanIds = new Set<string>();
      traces.forEach((trace) => {
        const collectSpanIds = (span: any) => {
          allValidSpanIds.add(span.id);
          if (span.spans) {
            span.spans.forEach(collectSpanIds);
          }
        };
        if (trace.spans) {
          trace.spans.forEach(collectSpanIds);
        }
      });

      // Remove any collapsed span IDs that no longer exist
      setExpandedSpans((prev) => {
        const newSet = new Set<string>();
        prev.forEach((spanId) => {
          if (allValidSpanIds.has(spanId)) {
            newSet.add(spanId);
          }
        });
        return newSet;
      });
    }
  }, [traces]);

  return (
    <>
      <style>{fadeInAnimationStyles}</style>
      <div className="h-screen bg-white dark:bg-zinc-950 text-neutral-800 dark:text-neutral-200 transition-colors duration-300 p-4 overflow-y-auto overflow-x-hidden">
        {/* Search and Time Range Selector */}
        <div className="space-y-4">
          <div className="flex flex-col lg:flex-row lg:justify-between lg:items-center gap-2">
            <div className="flex-1 min-w-0">
              <SearchBar
                onSearch={handleSearch}
                onClear={handleClearSearch}
                onLogSearchValueChange={handleLogSearchValueChange}
                onMetadataSearchTermsChange={onMetadataSearchTermsChange}
                disabled={loading || hasTraceIdInUrl}
              />
            </div>
            <div className="flex space-x-2 flex-shrink-0 justify-end">
              <RefreshButton
                onRefresh={handleRefresh}
                disabled={loading || hasTraceIdInUrl}
              />
              <TimeButton
                selectedTimeRange={selectedTimeRange}
                onTimeRangeSelect={handleTimeRangeSelect}
                disabled={loading || hasTraceIdInUrl}
              />
            </div>
          </div>

          {/* Content container with zinc-50 background */}
          <div className="mt-4 bg-zinc-50 dark:bg-zinc-900 p-2.5 rounded-lg">
            {loading && (
              <div className="flex flex-col items-center justify-center py-1 space-y-1">
                <Spinner
                  variant="infinite"
                  className="w-8 h-8 text-gray-500 dark:text-gray-300"
                />
              </div>
            )}

            {error && (
              <div className="text-sm text-red-500 dark:text-red-400">
                {error}
              </div>
            )}

            {!loading && !error && traces.length === 0 && (
              <div className="text-muted-foreground text-sm">
                No Information Found
              </div>
            )}

            {!loading && !error && traces.length > 0 && (
              <>
                <div className="space-y-1.5 transition-all duration-100 ease-in-out">
                  {traces.map((trace, index) => {
                    const isNewTrace = index >= previousTraceCountRef.current;
                    const animationDelay = isNewTrace
                      ? `${(index - previousTraceCountRef.current) * 5}ms`
                      : "0ms";
                    return (
                      <div key={trace.id} className="relative">
                        {/* Trace Block */}
                        <div
                          className={`relative h-[43px] p-2 rounded border border-neutral-300 dark:border-neutral-700 transition-colors cursor-pointer transform transition-all duration-100 ease-in-out hover:shadow-sm ${isNewTrace ? "animate-fadeIn" : ""} ${
                            selectedTraceIds.has(trace.id)
                              ? "bg-zinc-100 dark:bg-zinc-900"
                              : "bg-white dark:bg-zinc-950"
                          } ${
                            activeTraceId === trace.id
                              ? "border-l-4 border-l-zinc-600 dark:border-l-zinc-400"
                              : ""
                          }`}
                          style={{
                            animationDelay: animationDelay,
                          }}
                          onClick={() => handleTraceClick(trace.id)}
                          role="button"
                          tabIndex={0}
                        >
                          <div className="flex justify-between items-center h-full">
                            <div className="flex items-center text-sm min-w-0 flex-1 pr-4">
                              {/* Telemetry SDK Language Icons */}
                              {trace.telemetry_sdk_language &&
                                trace.telemetry_sdk_language.length > 0 && (
                                  <div className="flex items-center flex-shrink-0">
                                    {/* Python Icon - show when telemetry_sdk_language includes "python" */}
                                    {trace.telemetry_sdk_language.includes(
                                      "python",
                                    ) && (
                                      <FaPython
                                        className="text-neutral-800 dark:text-neutral-200 mr-2"
                                        size={14}
                                      />
                                    )}

                                    {/* TypeScript Icon - show when telemetry_sdk_language includes "ts" */}
                                    {trace.telemetry_sdk_language.includes(
                                      "ts",
                                    ) && (
                                      <SiTypescript
                                        className="text-neutral-800 dark:text-neutral-200 mr-2"
                                        size={14}
                                      />
                                    )}

                                    {/* JavaScript Icon - show when telemetry_sdk_language includes "js" */}
                                    {trace.telemetry_sdk_language.includes(
                                      "js",
                                    ) && (
                                      <IoLogoJavascript
                                        className="text-neutral-800 dark:text-neutral-200 mr-2"
                                        size={14}
                                      />
                                    )}

                                    {/* Java Icon - show when telemetry_sdk_language includes "java" */}
                                    {trace.telemetry_sdk_language.includes(
                                      "java",
                                    ) && (
                                      <FaJava
                                        className="text-neutral-800 dark:text-neutral-200 mr-2"
                                        size={14}
                                      />
                                    )}
                                  </div>
                                )}

                              {/* Service Name Badge */}
                              {(() => {
                                const fullServiceName =
                                  trace.service_name || "Unknown Service";
                                const isLimitExceeded =
                                  fullServiceName === "LimitExceeded";
                                const shouldShowTooltip =
                                  fullServiceName.length > 25 ||
                                  isLimitExceeded;

                                const badge = (
                                  <Badge
                                    variant="default"
                                    className={`min-w-16 h-6 mr-2 justify-start font-mono font-normal max-w-full overflow-hidden text-ellipsis flex-shrink text-left ${
                                      isLimitExceeded
                                        ? "bg-red-600 hover:bg-red-700 text-white"
                                        : ""
                                    }`}
                                    title={
                                      shouldShowTooltip && !isLimitExceeded
                                        ? fullServiceName
                                        : undefined
                                    }
                                  >
                                    {fullServiceName}
                                  </Badge>
                                );

                                return shouldShowTooltip ? (
                                  <Tooltip>
                                    <TooltipTrigger asChild>
                                      {badge}
                                    </TooltipTrigger>
                                    <TooltipContent>
                                      <p>
                                        {isLimitExceeded
                                          ? "The trace is too large or took too long to complete."
                                          : fullServiceName}
                                      </p>
                                    </TooltipContent>
                                  </Tooltip>
                                ) : (
                                  badge
                                );
                              })()}

                              {/* Environment */}
                              <Badge
                                variant="outline"
                                className="h-6 mr-2 justify-center font-mono font-normal flex-shrink-0"
                              >
                                {trace.service_environment ||
                                  "Unknown Environment"}
                              </Badge>

                              {/* Trace ID */}
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <span className="text-xs font-mono text-neutral-500 dark:text-neutral-400 mr-2 flex-shrink-0">
                                    {trace.id.substring(0, 8)}
                                  </span>
                                </TooltipTrigger>
                                <TooltipContent>
                                  <p className="font-mono text-xs">
                                    {trace.id}
                                  </p>
                                </TooltipContent>
                              </Tooltip>

                              {/* Warning and Error Badges Container */}
                              <div className="flex items-center flex-shrink-0">
                                {/* Error icon for error/critical logs */}
                                {((trace.num_error_logs ?? 0) > 0 ||
                                  (trace.num_critical_logs ?? 0) > 0) && (
                                  <Tooltip>
                                    <TooltipTrigger asChild>
                                      <Badge
                                        variant="destructive"
                                        className="h-6 mr-1 px-1 font-light"
                                      >
                                        <MdErrorOutline
                                          size={16}
                                          className="text-white"
                                        />
                                      </Badge>
                                    </TooltipTrigger>
                                    <TooltipContent>
                                      <p>{`${trace.num_error_logs ?? 0} error logs, ${trace.num_critical_logs ?? 0} critical logs`}</p>
                                    </TooltipContent>
                                  </Tooltip>
                                )}

                                {/* Warning icon for error/critical logs */}
                                {(trace.num_warning_logs ?? 0) > 0 && (
                                  <Tooltip>
                                    <TooltipTrigger asChild>
                                      <Badge
                                        variant="secondary"
                                        className="h-6 m-1 px-1 bg-[#fb923c] text-white hover:bg-[#fb923c]/80 font-light"
                                      >
                                        <IoWarningOutline
                                          size={16}
                                          className="text-white"
                                        />
                                      </Badge>
                                    </TooltipTrigger>
                                    <TooltipContent>
                                      <p>{`${trace.num_warning_logs ?? 0} warning logs`}</p>
                                    </TooltipContent>
                                  </Tooltip>
                                )}
                              </div>
                            </div>

                            {/* Start time, Share button, and Expand/Collapse icon */}
                            <div className="flex items-center gap-2 flex-shrink-0">
                              <span className="text-xs text-neutral-600 dark:text-neutral-300 flex-shrink-0 whitespace-nowrap">
                                {trace.start_time === 0
                                  ? "N/A"
                                  : formatDateTime(trace.start_time)}
                              </span>
                              {selectedTraceIds.has(trace.id) && (
                                <>
                                  <Tooltip>
                                    <TooltipTrigger asChild>
                                      <button
                                        onClick={(e) =>
                                          handleShareClick(trace.id, e)
                                        }
                                        className="p-0.5 hover:bg-neutral-200 dark:hover:bg-neutral-600 rounded transition-colors"
                                      >
                                        <Share2
                                          size={14}
                                          className="text-neutral-600 dark:text-neutral-300"
                                        />
                                      </button>
                                    </TooltipTrigger>
                                    <TooltipContent>
                                      <p>Share trace</p>
                                    </TooltipContent>
                                  </Tooltip>
                                  <button
                                    onClick={(e) =>
                                      handleTraceExpandToggle(trace.id, e)
                                    }
                                    className="p-0.5 hover:bg-neutral-200 dark:hover:bg-neutral-600 rounded transition-colors"
                                  >
                                    {expandedTraceIds.has(trace.id) ? (
                                      <CircleMinus
                                        size={14}
                                        className="text-neutral-600 dark:text-neutral-300"
                                      />
                                    ) : (
                                      <CirclePlus
                                        size={14}
                                        className="text-neutral-600 dark:text-neutral-300"
                                      />
                                    )}
                                  </button>
                                </>
                              )}
                            </div>
                          </div>
                        </div>

                        {/* Spans Container - Only rendered when trace is expanded */}
                        {expandedTraceIds.has(trace.id) && (
                          <div
                            className="relative pb-1 pt-1.5"
                            style={{ zIndex: 1 }}
                          >
                            {/* Vertical Line: extends naturally with the content */}
                            <div
                              className="absolute top-0 w-px"
                              style={{
                                left: "3%",
                                height: "100%",
                                background: "#e5e7eb",
                                zIndex: -1,
                              }}
                            />

                            <div
                              className="overflow-y-auto"
                              style={{
                                width: "97%",
                                marginLeft: "3%",
                                maxHeight: "500px", // ✅ Enables vertical scroll
                              }}
                            >
                              <div className="space-y-2">
                                {trace.spans.map((span) => (
                                  <Span
                                    key={span.id}
                                    span={span}
                                    widthPercentage={97}
                                    isSelected={selectedSpanIds.includes(
                                      span.id,
                                    )}
                                    selectedSpanId={selectedSpanId}
                                    selectedSpanIds={selectedSpanIds}
                                    onSpanSelect={(spanId, childSpanIds) =>
                                      handleSpanSelect(
                                        spanId,
                                        childSpanIds,
                                        trace.id,
                                      )
                                    }
                                    expandedSpans={expandedSpans}
                                    onSpanExpandToggle={handleSpanExpandToggle}
                                  />
                                ))}
                              </div>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>

                {/* Load More Button */}
                {hasMore && !loadingMore && (
                  <div className="mt-1.5">
                    <button
                      onClick={handleLoadMore}
                      className="w-full h-[40px] p-2 rounded border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-zinc-950 hover:bg-zinc-50 dark:hover:bg-zinc-900 transition-colors cursor-pointer flex items-center justify-center text-sm text-neutral-600 dark:text-neutral-300"
                    >
                      <span className="text-xs">Load more traces...</span>
                    </button>
                  </div>
                )}

                {/* Loading More Indicator */}
                {loadingMore && (
                  <div className="mt-1.5 flex justify-center py-3">
                    <Spinner
                      variant="infinite"
                      className="w-6 h-6 text-gray-500 dark:text-gray-300"
                    />
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </div>

      {/* Share Dialog */}
      <Dialog open={shareDialogOpen} onOpenChange={setShareDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Share Trace</DialogTitle>
            <DialogDescription>
              Share this trace with others using the URL below.
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-center space-x-2">
            <div className="grid flex-1 gap-2">
              <div className="flex items-center space-x-2">
                <input
                  readOnly
                  value={shareTraceId ? getShareUrl(shareTraceId) : ""}
                  className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                />
                <Button
                  type="button"
                  size="sm"
                  className="px-3"
                  onClick={handleCopyUrl}
                >
                  {copied ? (
                    <>
                      <Check className="h-4 w-4" />
                      <span className="sr-only">Copied</span>
                    </>
                  ) : (
                    <>
                      <Copy className="h-4 w-4" />
                      <span className="sr-only">Copy</span>
                    </>
                  )}
                </Button>
              </div>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
};

export default Trace;
