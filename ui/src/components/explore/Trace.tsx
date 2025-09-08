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
import { useUser } from "@/hooks/useUser";
import { IoWarningOutline, IoLogoJavascript } from "react-icons/io5";
import { MdErrorOutline } from "react-icons/md";
import { FaPython } from "react-icons/fa";
import { SiTypescript } from "react-icons/si";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/shadcn-io/spinner";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { CirclePlus, CircleMinus } from "lucide-react";

interface TraceProps {
  onTraceSelect?: (traceId: string | null) => void;
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
  const { getAuthState } = useUser();
  const [traces, setTraces] = useState<TraceType[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedTimeRange, setSelectedTimeRange] = useState<TimeRange>(
    TIME_RANGES[0],
  );
  const [selectedTraceId, setSelectedTraceId] = useState<string | null>(null);
  const [selectedSpanId, setSelectedSpanId] = useState<string | null>(null);
  const [selectedSpanIds, setSelectedSpanIds] = useState<string[]>([]);
  const [searchCriteria, setSearchCriteria] = useState<SearchCriterion[]>([]);
  const [logSearchValue, setLogSearchValue] = useState<string>("");
  const [isTraceExpanded, setIsTraceExpanded] = useState<boolean>(true);
  const [expandedSpans, setExpandedSpans] = useState<Set<string>>(new Set());
  const timeRangeRef = useRef<{ start: Date; end: Date } | null>(null);

  const handleTimeRangeSelect = (range: TimeRange) => {
    setSelectedTimeRange(range);
    setSelectedTraceId(null);
    setSelectedSpanId(null);
    setSelectedSpanIds([]);
    setIsTraceExpanded(true);
    setExpandedSpans(new Set());
    onTraceSelect?.(null);
    onSpanSelect?.([]);
    setLoading(true);
  };

  const handleSearch = (criteria: SearchCriterion[]) => {
    setSearchCriteria(criteria);
    setLoading(true); // Trigger a new API call when search criteria change
  };

  const handleClearSearch = () => {
    setSearchCriteria([]);
    setLogSearchValue("");
    setExpandedSpans(new Set());
    onLogSearchValueChange?.("");
    setLoading(true); // Trigger a new API call when search is cleared
  };

  const handleLogSearchValueChange = (value: string) => {
    setLogSearchValue(value);
    onLogSearchValueChange?.(value);
  };

  useEffect(() => {
    const fetchTraces = async () => {
      if (!loading) return;

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

        // Add search criteria to the API call
        searchCriteria.forEach((criterion) => {
          apiUrl += `&categories=${encodeURIComponent(criterion.category)}`;
          apiUrl += `&values=${encodeURIComponent(criterion.value)}`;
          apiUrl += `&operations=${encodeURIComponent(criterion.operation)}`;
        });

        const response = await fetch(apiUrl, {
          headers: {
            Authorization: `Bearer ${getAuthState()}`,
          },
        });
        const result = await response.json();

        if (!result.success) {
          throw new Error(result.error || "Failed to fetch traces");
        }

        setTraces(result.data);

        // Check if currently selected trace is still in the filtered results
        if (selectedTraceId) {
          const isSelectedTraceInResults = result.data.some(
            (trace: TraceType) => trace.id === selectedTraceId,
          );

          if (!isSelectedTraceInResults) {
            // Clear selection if selected trace is not in new results
            setSelectedTraceId(null);
            setSelectedSpanId(null);
            setSelectedSpanIds([]);
            onTraceSelect?.(null);
            onSpanSelect?.([]);
          }
        }

        onTraceData?.(timeRangeRef.current.start, timeRangeRef.current.end);
        onTracesUpdate?.(result.data);
      } catch (err) {
        setError(
          err instanceof Error
            ? err.message
            : "An error occurred while fetching traces",
        );
      } finally {
        setLoading(false);
      }
    };

    fetchTraces();
  }, [
    selectedTimeRange,
    loading,
    traceQueryStartTime,
    traceQueryEndTime,
    searchCriteria,
  ]);

  useEffect(() => {
    setLoading(true);
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
    const newSelectedTraceId = selectedTraceId === traceId ? null : traceId;
    setSelectedTraceId(newSelectedTraceId);
    onTraceSelect?.(newSelectedTraceId);

    // When selecting a new trace, default to expanded
    if (newSelectedTraceId && newSelectedTraceId !== selectedTraceId) {
      setIsTraceExpanded(true);
    }

    // Always clear span selection when trace selection changes
    // This unifies behavior with right panel components
    setSelectedSpanId(null);
    setSelectedSpanIds([]);
    onSpanSelect?.([]);
  };

  const handleTraceExpandToggle = (
    traceId: string,
    event: React.MouseEvent,
  ) => {
    event.stopPropagation(); // Prevent trace selection
    if (selectedTraceId === traceId) {
      setIsTraceExpanded(!isTraceExpanded);
    }
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

  const handleSpanSelect = (spanId: string, childSpanIds: string[]) => {
    const newSelectedSpanId = selectedSpanId === spanId ? null : spanId;
    setSelectedSpanId(newSelectedSpanId);

    const allSpanIds = newSelectedSpanId
      ? [newSelectedSpanId, ...childSpanIds]
      : [];
    setSelectedSpanIds(allSpanIds);
    onSpanSelect?.(allSpanIds);
  };

  const handleRefresh = () => {
    setSelectedTraceId(null);
    setSelectedSpanId(null);
    setSelectedSpanIds([]);
    setIsTraceExpanded(true);
    setExpandedSpans(new Set());
    onTraceSelect?.(null);
    onSpanSelect?.([]);
    setLoading(true);
  };

  useEffect(() => {
    if (externalSelectedTraceId !== selectedTraceId) {
      setSelectedTraceId(externalSelectedTraceId || null);
    }
  }, [externalSelectedTraceId, selectedTraceId]);

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
                disabled={loading}
              />
            </div>
            <div className="flex space-x-2 flex-shrink-0 justify-end">
              <RefreshButton onRefresh={handleRefresh} disabled={loading} />
              <TimeButton
                selectedTimeRange={selectedTimeRange}
                onTimeRangeSelect={handleTimeRangeSelect}
                disabled={loading}
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
              <div className="space-y-1.5 transition-all duration-100 ease-in-out">
                {traces.map((trace, index) => (
                  <div key={trace.id} className="relative">
                    {/* Trace Block */}
                    <div
                      className={`relative h-[43px] p-2 rounded border border-neutral-300 dark:border-neutral-700 transition-colors cursor-pointer transform transition-all duration-100 ease-in-out hover:shadow-sm animate-fadeIn ${
                        selectedTraceId === trace.id
                          ? "bg-zinc-100 dark:bg-zinc-900"
                          : "bg-white dark:bg-zinc-800"
                      }`}
                      style={{
                        animationDelay: `${index * 5}ms`,
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
                              </div>
                            )}

                          {/* Service Name Badge */}
                          {(() => {
                            const fullServiceName =
                              trace.service_name || "Unknown Service";
                            const shouldShowTooltip =
                              fullServiceName.length > 25;

                            const badge = (
                              <Badge
                                variant="default"
                                className="min-w-16 h-6 mr-2 justify-start font-mono font-normal max-w-full overflow-hidden text-ellipsis flex-shrink text-left"
                                title={
                                  shouldShowTooltip
                                    ? fullServiceName
                                    : undefined
                                }
                              >
                                {fullServiceName}
                              </Badge>
                            );

                            return shouldShowTooltip ? (
                              <Tooltip>
                                <TooltipTrigger asChild>{badge}</TooltipTrigger>
                                <TooltipContent>
                                  <p>{fullServiceName}</p>
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
                            {trace.service_environment || "Unknown Environment"}
                          </Badge>

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

                        {/* Start time and Expand/Collapse icon */}
                        <div className="flex items-center gap-2 flex-shrink-0">
                          <span className="text-xs text-neutral-600 dark:text-neutral-300 flex-shrink-0 whitespace-nowrap">
                            {formatDateTime(trace.start_time)}
                          </span>
                          {selectedTraceId === trace.id && (
                            <button
                              onClick={(e) =>
                                handleTraceExpandToggle(trace.id, e)
                              }
                              className="p-0.5 hover:bg-neutral-200 dark:hover:bg-neutral-600 rounded transition-colors"
                            >
                              {isTraceExpanded ? (
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
                          )}
                        </div>
                      </div>
                    </div>

                    {/* Spans Container - Only rendered when trace is selected AND expanded */}
                    {selectedTraceId === trace.id && isTraceExpanded && (
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
                                isSelected={selectedSpanIds.includes(span.id)}
                                selectedSpanId={selectedSpanId}
                                selectedSpanIds={selectedSpanIds}
                                onSpanSelect={handleSpanSelect}
                                expandedSpans={expandedSpans}
                                onSpanExpandToggle={handleSpanExpandToggle}
                              />
                            ))}
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
};

export default Trace;
