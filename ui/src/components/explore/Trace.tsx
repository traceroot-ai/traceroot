'use client';

import React, { useEffect, useState, useRef, useCallback } from 'react';
import { Trace as TraceType, Span as SpanType } from '@/models/trace';
import Span from './span/Span';
import TimeButton, { TimeRange, TIME_RANGES } from './TimeButton';
import RefreshButton from './RefreshButton';
import SearchBar, { SearchCriterion } from './SearchBar';
import { PERCENTILE_COLORS, getPercentileColor, PercentileKey } from '@/constants/colors';
import { fadeInAnimationStyles } from '@/constants/animations';
import { useUser } from '@/hooks/useUser';
import { IoWarningOutline, IoLogoJavascript } from "react-icons/io5";
import { MdErrorOutline } from "react-icons/md";
import { FaPython } from "react-icons/fa";
import { SiTypescript } from "react-icons/si";

interface TraceProps {
  onTraceSelect?: (traceId: string | null) => void;
  onSpanSelect?: (spanIds: string[]) => void;
  onTraceData?: (startTime: Date, endTime: Date) => void;
  selectedTraceId?: string | null;
  traceQueryStartTime?: Date;
  traceQueryEndTime?: Date;
}

export function formatDateTime(ts: number) {
  const date = new Date(ts * 1000);
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const h = String(date.getHours()).padStart(2, '0');
  const min = String(date.getMinutes()).padStart(2, '0');
  const s = String(date.getSeconds()).padStart(2, '0');
  return `${y}-${m}-${d} ${h}:${min}:${s}`;
}

export const Trace: React.FC<TraceProps> = ({
  onTraceSelect,
  onSpanSelect,
  onTraceData,
  selectedTraceId: externalSelectedTraceId,
  traceQueryStartTime,
  traceQueryEndTime
}) => {
  const { getAuthState } = useUser();
  const [traces, setTraces] = useState<TraceType[]>([]);
  const [filteredTraces, setFilteredTraces] = useState<TraceType[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedTimeRange, setSelectedTimeRange] = useState<TimeRange>(TIME_RANGES[0]);
  const [selectedTraceId, setSelectedTraceId] = useState<string | null>(null);
  const [selectedSpanId, setSelectedSpanId] = useState<string | null>(null);
  const [selectedSpanIds, setSelectedSpanIds] = useState<string[]>([]);
  const [searchCriteria, setSearchCriteria] = useState<SearchCriterion[]>([]);
  const timeRangeRef = useRef<{ start: Date; end: Date } | null>(null);

  const handleTimeRangeSelect = (range: TimeRange) => {
    setSelectedTimeRange(range);
    setSelectedTraceId(null);
    setSelectedSpanId(null);
    setSelectedSpanIds([]);
    onTraceSelect?.(null);
    onSpanSelect?.([]);
    setLoading(true);
  };

  const filterTraces = useCallback((traces: TraceType[], criteria: SearchCriterion[]) => {
    if (criteria.length === 0) {
      return traces;
    }

    return traces.filter(trace => {
      let result = true;
      let currentLogicalOperator: 'AND' | 'OR' | null = null;

      for (const criterion of criteria) {
        let conditionMet = false;

        // Get the value to compare against
        let traceValue: string | number | undefined;
        switch (criterion.category) {
          case 'service_name':
            traceValue = trace.service_name;
            break;
          case 'service_environment':
            traceValue = trace.service_environment;
            break;
          case 'duration':
            traceValue = trace.duration;
            break;
          case 'percentile':
            traceValue = trace.percentile;
            break;
          case 'span_name':
            // Check if any span name matches
            const checkSpanName = (spans: SpanType[]): boolean => {
              return spans.some(span => {
                if (span.name && performOperation(span.name, criterion.operation, criterion.value)) {
                  return true;
                }
                return span.spans && span.spans.length > 0 ? checkSpanName(span.spans) : false;
              });
            };
            conditionMet = checkSpanName(trace.spans);
            break;
          case 'start_time':
            traceValue = trace.start_time;
            break;
          case 'end_time':
            traceValue = trace.end_time;
            break;
          default:
            conditionMet = false;
            break;
        }

        // Skip span_name as it's handled separately
        if (criterion.category !== 'span_name' && traceValue !== undefined) {
          conditionMet = performOperation(traceValue, criterion.operation, criterion.value);
        }

        // Apply logical operator
        if (currentLogicalOperator === 'AND') {
          result = result && conditionMet;
        } else if (currentLogicalOperator === 'OR') {
          result = result || conditionMet;
        } else {
          // First condition
          result = conditionMet;
        }

        currentLogicalOperator = criterion.logicalOperator || null;
      }

      return result;
    });
  }, []);

  const performOperation = (value: string | number, operation: string, searchValue: string): boolean => {
    if (value === undefined || value === null) return false;

    const stringValue = String(value).toLowerCase();
    const searchStringValue = searchValue.toLowerCase();

    switch (operation) {
      case '=':
        return stringValue === searchStringValue;
      case 'contains':
        return stringValue.includes(searchStringValue);
      case '>':
        return parseFloat(String(value)) > parseFloat(searchValue);
      case '<':
        return parseFloat(String(value)) < parseFloat(searchValue);
      case '>=':
        return parseFloat(String(value)) >= parseFloat(searchValue);
      case '<=':
        return parseFloat(String(value)) <= parseFloat(searchValue);
      default:
        return false;
    }
  };

  const handleSearch = (criteria: SearchCriterion[]) => {
    setSearchCriteria(criteria);
  };

  const handleClearSearch = () => {
    setSearchCriteria([]);
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
          startTime.setMinutes(endTime.getMinutes() - selectedTimeRange.minutes);
        }

        timeRangeRef.current = {
          start: new Date(startTime),
          end: new Date(endTime)
        };

        const response = await fetch(`/api/list_trace?startTime=${startTime.toISOString()}&endTime=${endTime.toISOString()}`, {
          headers: {
            'Authorization': `Bearer ${getAuthState()}`,
          },
        });
        const result = await response.json();

        if (!result.success) {
          throw new Error(result.error || 'Failed to fetch traces');
        }

        setTraces(result.data);
        onTraceData?.(timeRangeRef.current.start, timeRangeRef.current.end);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'An error occurred while fetching traces');
      } finally {
        setLoading(false);
      }
    };

    fetchTraces();
  }, [selectedTimeRange, loading, traceQueryStartTime, traceQueryEndTime, getAuthState, onTraceData]);

  useEffect(() => {
    setLoading(true);
  }, []);

  // Initialize filteredTraces when traces change
  useEffect(() => {
    if (traces.length > 0) {
      const filtered = filterTraces(traces, searchCriteria);
      setFilteredTraces(filtered);
    } else {
      setFilteredTraces([]);
    }
  }, [traces, searchCriteria, filterTraces]);

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
          color: 'black',
          boxShadow: 'inset 0 1px 1px rgba(255, 255, 255, 0.2)'
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

    // Always clear span selection when trace selection changes
    // This unifies behavior with right panel components
    setSelectedSpanId(null);
    setSelectedSpanIds([]);
    onSpanSelect?.([]);
  };

  const handleSpanSelect = (spanId: string, childSpanIds: string[]) => {
    const newSelectedSpanId = selectedSpanId === spanId ? null : spanId;
    setSelectedSpanId(newSelectedSpanId);

    const allSpanIds = newSelectedSpanId ? [newSelectedSpanId, ...childSpanIds] : [];
    setSelectedSpanIds(allSpanIds);
    onSpanSelect?.(allSpanIds);
  };

  const handleRefresh = () => {
    setSelectedTraceId(null);
    setSelectedSpanId(null);
    setSelectedSpanIds([]);
    onTraceSelect?.(null);
    onSpanSelect?.([]);
    setLoading(true);
  };

  useEffect(() => {
    if (externalSelectedTraceId !== selectedTraceId) {
      setSelectedTraceId(externalSelectedTraceId || null);
    }
  }, [externalSelectedTraceId, selectedTraceId]);

  return (
    <>
      <style>{fadeInAnimationStyles}</style>
      <div className="h-screen bg-white dark:bg-gray-800 p-4 overflow-y-auto overflow-x-hidden">
        <div className="space-y-4">
        <div className="flex flex-col lg:flex-row lg:justify-between lg:items-center gap-2">
          <div className="flex-1 min-w-0">
            <SearchBar onSearch={handleSearch} onClear={handleClearSearch} />
          </div>
          <div className="flex space-x-2 flex-shrink-0 justify-end">
            <RefreshButton onRefresh={handleRefresh} />
            <TimeButton
              selectedTimeRange={selectedTimeRange}
              onTimeRangeSelect={handleTimeRangeSelect}
            />
          </div>
        </div>

        {loading && (
          <div className="flex flex-col items-center justify-center py-12 space-y-4">
            {/* Loading text with animated dots */}
            <div className="flex items-center space-x-1 text-sm text-gray-600 dark:text-gray-300">
              <div className="flex space-x-1">
                <div className="w-1 h-1 bg-gray-500 dark:bg-gray-400 rounded-full loading-dot-1"></div>
                <div className="w-1 h-1 bg-gray-500 dark:bg-gray-400 rounded-full loading-dot-2"></div>
                <div className="w-1 h-1 bg-gray-500 dark:bg-gray-400 rounded-full loading-dot-3"></div>
              </div>
            </div>
          </div>
        )}

        {error && (
          <div className="text-sm text-red-500 dark:text-red-400">{error}</div>
        )}

        {!loading && !error && filteredTraces.length === 0 && traces.length > 0 && (
          <div className="text-sm text-gray-500 dark:text-gray-400">No traces match your search criteria</div>
        )}

        {!loading && !error && traces.length === 0 && (
          <div className="text-sm text-gray-500 dark:text-gray-400">No Information Found</div>
        )}

        {!loading && !error && filteredTraces.length > 0 && (
          <div className="space-y-1 transition-all duration-300 ease-in-out">
            {filteredTraces.map((trace, index) => (
              <div key={trace.id} className="relative">
                {/* Trace Block */}
                <div
                  className={`relative h-[45px] p-3 rounded border border-gray-200 dark:border-gray-700 transition-colors cursor-pointer transform transition-all duration-300 ease-in-out hover:scale-[1.01] hover:shadow-sm animate-fadeIn ${
                    selectedTraceId === trace.id
                      ? 'bg-green-50 dark:bg-green-900/10 hover:bg-green-100 dark:hover:bg-green-900/20'
                      : 'bg-white dark:bg-gray-800 hover:bg-green-100 dark:hover:bg-green-900/20'
                  }`}
                  style={{
                    animationDelay: `${index * 10}ms`
                  }}
                  onClick={() => handleTraceClick(trace.id)}
                  role="button"
                  tabIndex={0}
                >
                  <div className="flex justify-between items-center h-full">
                    <div className="flex items-center text-sm">
                      {/* Telemetry SDK Language Icons */}
                      {trace.telemetry_sdk_language && trace.telemetry_sdk_language.length > 0 && (
                        <>
                          {/* Python Icon - show when telemetry_sdk_language includes "python" */}
                          {trace.telemetry_sdk_language.includes("python") && (
                            <div className="w-5 h-5 flex items-center justify-center mr-2">
                              <FaPython className="text-gray-600 dark:text-gray-300" size={14} />
                            </div>
                          )}

                          {/* TypeScript Icon - show when telemetry_sdk_language includes "ts" */}
                          {trace.telemetry_sdk_language.includes("ts") && (
                            <div className="w-5 h-5 flex items-center justify-center mr-2">
                              <SiTypescript className="text-gray-600 dark:text-gray-300" size={14} />
                            </div>
                          )}

                          {/* JavaScript Icon - show when telemetry_sdk_language includes "js" */}
                          {trace.telemetry_sdk_language.includes("js") && (
                            <div className="w-5 h-5 flex items-center justify-center mr-2">
                              <IoLogoJavascript className="text-gray-600 dark:text-gray-300" size={14} />
                            </div>
                          )}
                        </>
                      )}

                      {/* Tags */}
                      <span
                        className="inline-flex min-w-16 max-w-32 h-6 mr-2 text-xs items-center justify-center rounded-md whitespace-nowrap px-2"
                        style={{
                          background: '#f3f3f3',
                          color: '#1e1e1e',
                          boxShadow: 'inset 0 1px 1px rgba(255, 255, 255, 0.2)'
                        }}
                        title={((trace.service_name || "Unknown Service").length > 25) ? (trace.service_name || "Unknown Service") : undefined}
                      >
                        {((trace.service_name || "Unknown Service").length > 25) ? (trace.service_name || "Unknown Service").slice(0, 9) + '......' : (trace.service_name || "Trace")}
                      </span>

                      {/* Environment */}
                      <span
                        className="inline-flex h-6 mr-2 text-xs items-center justify-center rounded-md px-2"
                        style={{
                          background: '#dbeafe',
                          color: '#1e40af',
                          boxShadow: 'inset 0 1px 1px rgba(255, 255, 255, 0.2)'
                        }}
                      >
                        {trace.service_environment || "Unknown Environment"}
                      </span>

                      {getPercentileTag(trace.percentile)}

                      {/* Error icon for error/critical logs */}
                      {((trace.num_error_logs ?? 0) > 0 || (trace.num_critical_logs ?? 0) > 0) && (
                        <MdErrorOutline
                          className="text-red-600 mr-1"
                          size={20}
                          title={`${trace.num_error_logs ?? 0} error logs, ${trace.num_critical_logs ?? 0} critical logs`}
                        />
                      )}

                      {/* Warning icon for error/critical logs */}
                      {((trace.num_warning_logs ?? 0) > 0) && (
                        <IoWarningOutline
                          className="text-yellow-600 mr-1"
                          size={20}
                          title={`${trace.num_warning_logs ?? 0} warning logs`}
                        />
                      )}
                    </div>

                    {/* Start and end time */}
                    <span className="text-xs text-gray-500 dark:text-gray-400 flex-shrink-0 ml-4 whitespace-nowrap">
                      {formatDateTime(trace.start_time)} - {formatDateTime(trace.end_time)}
                    </span>
                  </div>
                </div>

                {/* Spans Container - Only rendered when trace is selected */}
                {selectedTraceId === trace.id && (
                  <div className="relative pb-2 pt-2" style={{ zIndex: 1 }}>
                    {/* Vertical Line: extends naturally with the content */}
                    <div
                      className="absolute top-0 w-px"
                      style={{
                        left: '3%',
                        height: '100%',
                        background: '#e5e7eb',
                        zIndex: -1,
                      }}
                    />

                    <div className="space-y-3" style={{ width: '97%', marginLeft: '3%' }}>
                      {trace.spans.map((span) => (
                        <Span
                          key={span.id}
                          span={span}
                          widthPercentage={97}
                          isSelected={selectedSpanIds.includes(span.id)}
                          selectedSpanId={selectedSpanId}
                          selectedSpanIds={selectedSpanIds}
                          onSpanSelect={handleSpanSelect}
                        />
                      ))}
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
    </>
  );
};

export default Trace;
