"use client";

import React, { useEffect, useState } from "react";
import { TraceLog, LogEntry } from "@/models/log";
import { Span, Trace as TraceModel } from "@/models/trace";
import { FaPython, FaJava } from "react-icons/fa";
import { IoLogoJavascript } from "react-icons/io5";
import { SiTypescript } from "react-icons/si";
import { CirclePlus, CircleMinus } from "lucide-react";
import { fadeInAnimationStyles } from "@/constants/animations";
import { ViewType } from "../ModeToggle";
import { useAuth } from "@clerk/nextjs";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/shadcn-io/spinner";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { initializeProviders, appendProviderParams } from "@/utils/provider";

interface LogDetailProps {
  traceIds: string[];
  spanIds?: string[];
  traceQueryStartTime?: Date;
  traceQueryEndTime?: Date;
  segments?: Span[];
  allTraces?: TraceModel[];
  logSearchValue?: string;
  metadataSearchTerms?: { category: string; value: string }[];
  viewType?: ViewType;
}

export default function LogDetail({
  traceIds,
  spanIds = [],
  traceQueryStartTime,
  traceQueryEndTime,
  segments,
  allTraces = [],
  logSearchValue = "",
  metadataSearchTerms = [],
  viewType,
}: LogDetailProps) {
  const [allLogs, setAllLogs] = useState<TraceLog | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedEntries, setExpandedEntries] = useState<Set<string>>(
    new Set(),
  );
  const [expandedTraceBlocks, setExpandedTraceBlocks] = useState<Set<string>>(
    new Set(),
  );
  const { getToken } = useAuth();

  // Expand all trace blocks by default when traces are selected
  useEffect(() => {
    if (traceIds.length > 0) {
      setExpandedTraceBlocks(new Set(traceIds));
    }
  }, [traceIds]);

  useEffect(() => {
    // Inject styles on client side only
    const styleSheet = document.createElement("style");
    styleSheet.innerText = fadeInAnimationStyles;
    document.head.appendChild(styleSheet);

    // Cleanup function to remove the style when component unmounts
    return () => {
      document.head.removeChild(styleSheet);
    };
  }, []); // Empty dependency array means this only runs once on mount

  useEffect(() => {
    const fetchLogs = async () => {
      if (!traceIds || traceIds.length === 0) {
        setAllLogs(null);
        return;
      }

      setLoading(true);
      setError(null);

      try {
        const { traceProvider, logProvider, traceRegion, logRegion } =
          initializeProviders();
        const token = await getToken();

        // Fetch logs for all traces in parallel
        type FetchResult =
          | { traceId: string; data: TraceLog; success: true }
          | { traceId: string; data: null; success: false; error: string };

        const fetchPromises = traceIds.map(
          async (traceId): Promise<FetchResult> => {
            try {
              const url = new URL("/api/get_trace_log", window.location.origin);
              url.searchParams.append("traceId", traceId);

              // Optimization: Pass trace start/end times for faster log queries
              // Find the trace in allTraces to get its timestamps
              const trace = allTraces.find((t) => t.id === traceId);
              if (
                trace &&
                trace.start_time &&
                trace.end_time &&
                trace.start_time !== 0
              ) {
                // Convert Unix timestamps to ISO 8601 UTC strings
                const startTime = new Date(
                  trace.start_time * 1000,
                ).toISOString();
                const endTime = new Date(trace.end_time * 1000).toISOString();
                url.searchParams.append("start_time", startTime);
                url.searchParams.append("end_time", endTime);
              }
              // If trace not found or has invalid timestamps (start_time=0),
              // don't send any time params - let backend fetch the trace and determine the correct time

              appendProviderParams(
                url,
                traceProvider,
                traceRegion,
                logProvider,
                logRegion,
              );

              const response = await fetch(url.toString(), {
                headers: {
                  Authorization: `Bearer ${token}`,
                },
              });
              const result = await response.json();

              if (!result.success) {
                throw new Error(result.error || "Failed to fetch logs");
              }

              return { traceId, data: result.data as TraceLog, success: true };
            } catch (err) {
              console.error(`LogDetail fetchLogs - error for ${traceId}:`, err);
              return {
                traceId,
                data: null,
                success: false,
                error:
                  err instanceof Error
                    ? err.message
                    : "An error occurred while fetching logs",
              };
            }
          },
        );

        // Wait for all requests to complete
        const results = await Promise.all(fetchPromises);

        // Merge all successful results
        const mergedLogs: TraceLog = {};
        let hasErrors = false;
        let errorMessage = "";

        results.forEach((result) => {
          if (result.success && result.data) {
            // Merge the trace logs
            Object.entries(result.data).forEach(([traceId, spanLogs]) => {
              mergedLogs[traceId] = spanLogs;
            });
          } else {
            hasErrors = true;
            errorMessage =
              result.error || "Failed to fetch logs for some traces";
          }
        });

        setAllLogs(mergedLogs);

        if (hasErrors && Object.keys(mergedLogs).length === 0) {
          // Only set error if ALL requests failed
          setError(errorMessage);
        }
      } catch (err) {
        console.error("LogDetail fetchLogs - error:", err);
        setError(
          err instanceof Error
            ? err.message
            : "An error occurred while fetching logs",
        );
      } finally {
        setLoading(false);
      }
    };
    fetchLogs();
  }, [traceIds]); // Only re-fetch when trace selection changes

  // Filter logs based on selected spans
  const logs = React.useMemo(() => {
    if (!allLogs) {
      return allLogs;
    }

    // If no spanIds selected, show all logs for selected traces
    if (spanIds.length === 0) {
      return allLogs;
    }

    // Build a mapping of spanId -> traceId from allTraces
    const spanToTraceMap = new Map<string, string>();
    const collectSpanIds = (spans: Span[], traceId: string) => {
      spans.forEach((span) => {
        spanToTraceMap.set(span.id, traceId);
        if (span.spans && span.spans.length > 0) {
          collectSpanIds(span.spans, traceId);
        }
      });
    };

    allTraces.forEach((trace) => {
      if (trace.spans && trace.spans.length > 0) {
        collectSpanIds(trace.spans, trace.id);
      }
    });

    // Group selected spans by their trace
    const spansByTrace = new Map<string, string[]>();
    spanIds.forEach((spanId) => {
      const traceId = spanToTraceMap.get(spanId);
      if (traceId) {
        if (!spansByTrace.has(traceId)) {
          spansByTrace.set(traceId, []);
        }
        spansByTrace.get(traceId)!.push(spanId);
      }
    });

    // Filter logs for each trace independently
    const filteredLogs: TraceLog = {};
    Object.entries(allLogs).forEach(([traceId, spanLogs]) => {
      if (!traceIds.includes(traceId)) {
        // Skip traces that are not selected
        return;
      }

      const selectedSpansForThisTrace = spansByTrace.get(traceId);

      if (selectedSpansForThisTrace && selectedSpansForThisTrace.length > 0) {
        // This trace has selected spans - filter to show only those spans
        const filteredSpanLogs = (spanLogs as any[]).filter((spanLog) => {
          const spanId = Object.keys(spanLog)[0];
          return selectedSpansForThisTrace.includes(spanId);
        });
        if (filteredSpanLogs.length > 0) {
          filteredLogs[traceId] = filteredSpanLogs;
        }
      } else {
        // This trace has no selected spans - show all logs
        filteredLogs[traceId] = spanLogs;
      }
    });

    return filteredLogs;
  }, [allLogs, spanIds, traceIds, allTraces]);

  const formatTimestamp = (timestamp: number) => {
    const date = new Date(timestamp * 1000);
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
  };

  const getLogLevelColor = (level: string) => {
    switch (level) {
      case "CRITICAL":
        return "font-medium text-[#7f1d1d]";
      case "ERROR":
        return "font-medium text-[#dc2626]";
      case "WARNING":
        return "font-medium text-[#fb923c]";
      case "INFO":
        return "font-medium text-[#64748b]";
      case "DEBUG":
        return "font-medium text-[#a855f7]";
      case "TRACE":
        return "font-medium text-[#6366f1]";
      default:
        return "font-medium text-[#64748b]";
    }
  };

  // Build flat list of log entries from all selected traces
  const buildOrderedLogEntries = (
    logs: TraceLog | null,
    traceIds: string[],
    sortDescending: boolean,
  ) => {
    const result: { entry: LogEntry; spanId: string; traceId: string }[] = [];
    if (!logs) return result;

    // Collect logs from all selected traces
    traceIds.forEach((traceId) => {
      if (!logs[traceId]) return;
      logs[traceId].forEach((spanLog: any) => {
        Object.entries(spanLog).forEach(([spanId, entries]) => {
          (entries as LogEntry[]).forEach((entry) => {
            result.push({ entry, spanId, traceId });
          });
        });
      });
    });

    // Sort all logs by timestamp
    result.sort((a, b) => {
      const diff = a.entry.time - b.entry.time;
      return sortDescending ? -diff : diff;
    });

    return result;
  };

  // Build grouped log entries for grouped view
  // NOTE: We pass in orderedEntries to reuse the same entry references
  const buildGroupedLogEntries = (
    orderedEntries: { entry: LogEntry; spanId: string; traceId: string }[],
    traceIds: string[],
    allTraces: TraceModel[],
    sortDescending: boolean,
  ) => {
    const groupedData: Map<
      string,
      {
        trace: TraceModel | undefined;
        logs: { entry: LogEntry; spanId: string }[];
      }
    > = new Map();

    if (!orderedEntries || orderedEntries.length === 0) return groupedData;

    // Build the grouped data first
    const entries: Array<
      [
        string,
        {
          trace: TraceModel | undefined;
          logs: { entry: LogEntry; spanId: string }[];
        },
      ]
    > = [];

    traceIds.forEach((traceId) => {
      // Find the trace metadata
      const trace = allTraces.find((t) => t.id === traceId);

      // Filter logs for this trace (reuses same entry references from orderedEntries)
      const traceLogs = orderedEntries
        .filter((item) => item.traceId === traceId)
        .map(({ entry, spanId }) => ({ entry, spanId }));

      if (traceLogs.length > 0) {
        entries.push([
          traceId,
          {
            trace,
            logs: traceLogs,
          },
        ]);
      }
    });

    // Sort the entries by trace start time
    entries.sort((a, b) => {
      const traceA = a[1].trace;
      const traceB = b[1].trace;
      if (!traceA || !traceB) return 0;
      const diff = traceA.start_time - traceB.start_time;
      return sortDescending ? -diff : diff;
    });

    // Convert back to Map preserving the sorted order
    entries.forEach(([traceId, data]) => {
      groupedData.set(traceId, data);
    });

    return groupedData;
  };

  // Compute ordered log entries (for ungrouped view)
  // Sort logs in descending order (latest first)
  const orderedLogEntries = buildOrderedLogEntries(logs, traceIds, true);
  // Compute grouped log entries (for grouped view) - reuses same entry references from orderedLogEntries
  const groupedLogEntries = buildGroupedLogEntries(
    orderedLogEntries,
    traceIds,
    allTraces,
    true,
  );

  const toggleExpandEntry = (entryKey: string) => {
    setExpandedEntries((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(entryKey)) {
        newSet.delete(entryKey);
      } else {
        newSet.add(entryKey);
      }
      return newSet;
    });
  };

  const truncateMessage = (message: string, maxLength: number = 500) => {
    if (message.length <= maxLength) {
      return message;
    }
    return message.substring(0, maxLength) + "......";
  };

  const isMessageExpandable = (message: string, maxLength: number = 500) => {
    return message.length > maxLength;
  };

  // Format message with smart line breaks for long content
  const formatMessage = (message: string, maxLineLength: number = 80) => {
    // Split message into existing lines first
    const existingLines = message.split("\n");
    const processedLines: string[] = [];

    // Process each line individually
    for (const line of existingLines) {
      // If line is shorter than max length, keep as is
      if (line.length <= maxLineLength) {
        processedLines.push(line);
        continue;
      }

      // For long lines, add smart breaks while preserving leading whitespace
      const leadingWhitespace = line.match(/^\s*/)?.[0] || "";
      const trimmedLine = line.trimStart();
      const words = trimmedLine.split(" ");
      const wrappedLines: string[] = [];
      let currentLine = "";

      for (const word of words) {
        const wordWithSpace = (currentLine ? " " : "") + word;
        const potentialLine = leadingWhitespace + currentLine + wordWithSpace;

        if (potentialLine.length <= maxLineLength) {
          currentLine += wordWithSpace;
        } else {
          if (currentLine) {
            wrappedLines.push(leadingWhitespace + currentLine);
          }
          currentLine = word;
        }
      }

      if (currentLine) {
        wrappedLines.push(leadingWhitespace + currentLine);
      }

      processedLines.push(...wrappedLines);
    }

    return processedLines.join("\n");
  };

  // Helper function to highlight search terms in text
  const highlightText = (
    text: string,
    logSearchTerm: string,
    metadataTerms: { category: string; value: string }[],
  ) => {
    // Collect all search patterns
    const searchPatterns: RegExp[] = [];

    // Add log search term if present
    if (logSearchTerm.trim()) {
      const escapedTerm = logSearchTerm.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      searchPatterns.push(new RegExp(`(${escapedTerm})`, "gi"));
    }

    // Add metadata terms as quoted key-value pairs
    metadataTerms.forEach((term) => {
      if (term.category.trim() && term.value.trim()) {
        const escapedCategory = term.category.replace(
          /[.*+?^${}()|[\]\\]/g,
          "\\$&",
        );
        const escapedValue = term.value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        // Match pattern: "key": "value" (with optional whitespace)
        const keyValuePattern = `"${escapedCategory}"\\s*:\\s*"${escapedValue}"`;
        searchPatterns.push(new RegExp(`(${keyValuePattern})`, "gi"));
      }
    });

    // If no search patterns, return original text
    if (searchPatterns.length === 0) return text;

    // Create a combined pattern that captures all search terms
    const combinedPattern = new RegExp(
      `(${searchPatterns.map((p) => p.source.slice(1, -1)).join("|")})`,
      "gi",
    );

    const parts = text.split(combinedPattern);

    return parts.map((part, index) => {
      // Check if this part matches any of our patterns
      const isMatch = searchPatterns.some((pattern) => {
        const testPattern = new RegExp(pattern.source, pattern.flags);
        return testPattern.test(part);
      });

      if (isMatch && part.trim()) {
        return (
          <span
            key={index}
            className="bg-yellow-300 dark:bg-yellow-700 py-0.5 rounded-xs font-medium text-black dark:text-white"
          >
            {part}
          </span>
        );
      }
      return part;
    });
  };

  return (
    <div className="h-screen flex flex-col text-xs">
      {/*
        TODO: The 'pt-0' (padding-top: 0) and 'pb-22' (padding-bottom: 5.5rem)
        classes are used here, but it's not clear why these specific values
        are required for the layout.
        If you refactor the layout or see layout issues related to the
        top/bottom spacing, please confirm if these are still necessary, and
        feel free to adjust as needed.
      */}
      <div className="bg-white dark:bg-zinc-950 pt-0 px-4 pb-22 overflow-y-auto overflow-x-visible">
        {loading && (
          <div className="bg-zinc-50 dark:bg-zinc-950 p-4 rounded-md border border-zinc-200 dark:border-zinc-700">
            <div className="flex flex-col items-center justify-center py-1 space-y-1">
              <Spinner
                variant="infinite"
                className="w-8 h-8 text-gray-500 dark:text-gray-300"
              />
            </div>
          </div>
        )}
        {error && (
          <div className="bg-zinc-50 dark:bg-zinc-950 p-4 rounded-md border border-red-200 dark:border-red-700">
            <p className="text-red-700 dark:text-red-300">{error}</p>
          </div>
        )}
        {/* Render logs in the order of SpanLogs, using span depth for indentation */}
        {!loading && !error && orderedLogEntries.length > 0 && (
          <div className="text-sm bg-zinc-50 dark:bg-zinc-900 rounded-lg pt-2.5 px-2.5 pb-2.5 overflow-x-visible transition-all duration-100 ease-in-out">
            <div className="space-y-1.5">
              {/* Grouped View: Show logs grouped by trace */}
              {Array.from(groupedLogEntries.entries()).map(
                ([traceId, { trace, logs }]) => {
                  const isTraceExpanded = expandedTraceBlocks.has(traceId);

                  return (
                    <div
                      key={traceId}
                      className="border border-neutral-300 dark:border-neutral-700 rounded-lg bg-white dark:bg-zinc-950 overflow-hidden mb-2"
                    >
                      {/* Trace Block Header */}
                      <div className="bg-white dark:bg-black p-1 border-b border-neutral-300 dark:border-neutral-700">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-0.5 flex-1">
                            {/* Language Icon */}
                            {trace?.telemetry_sdk_language &&
                              trace.telemetry_sdk_language.length > 0 && (
                                <div className="flex items-center flex-shrink-0 ml-1 mr-2">
                                  {trace.telemetry_sdk_language.includes(
                                    "python",
                                  ) && (
                                    <FaPython
                                      className="text-neutral-800 dark:text-neutral-200"
                                      size={14}
                                    />
                                  )}
                                  {trace.telemetry_sdk_language.includes(
                                    "ts",
                                  ) && (
                                    <SiTypescript
                                      className="text-neutral-800 dark:text-neutral-200"
                                      size={14}
                                    />
                                  )}
                                  {trace.telemetry_sdk_language.includes(
                                    "js",
                                  ) && (
                                    <IoLogoJavascript
                                      className="text-neutral-800 dark:text-neutral-200"
                                      size={14}
                                    />
                                  )}
                                  {trace.telemetry_sdk_language.includes(
                                    "java",
                                  ) && (
                                    <FaJava
                                      className="text-neutral-800 dark:text-neutral-200"
                                      size={14}
                                    />
                                  )}
                                </div>
                              )}
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Badge
                                  variant="default"
                                  className="min-w-16 h-6 mr-2 justify-start font-mono font-normal max-w-full overflow-hidden text-ellipsis flex-shrink text-left cursor-default"
                                >
                                  {traceId.substring(0, 8)}...
                                </Badge>
                              </TooltipTrigger>
                              <TooltipContent>
                                <p className="font-mono text-xs">{traceId}</p>
                              </TooltipContent>
                            </Tooltip>
                          </div>
                          {trace?.start_time && (
                            <Badge
                              variant="outline"
                              className="h-6 px-2 font-mono text-xs font-normal flex-shrink-0 whitespace-nowrap mr-1"
                            >
                              {formatTimestamp(trace.start_time)}
                            </Badge>
                          )}
                          <Badge
                            variant="outline"
                            className="h-6 px-1.5 cursor-pointer hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors flex-shrink-0 whitespace-nowrap"
                            onClick={(e) => {
                              e.stopPropagation(); // Prevent trace selection
                              setExpandedTraceBlocks((prev) => {
                                const newSet = new Set(prev);
                                if (newSet.has(traceId)) {
                                  newSet.delete(traceId);
                                } else {
                                  newSet.add(traceId);
                                }
                                return newSet;
                              });
                            }}
                          >
                            {isTraceExpanded ? (
                              <CircleMinus size={12} />
                            ) : (
                              <CirclePlus size={12} />
                            )}
                          </Badge>
                        </div>
                      </div>

                      {/* Trace Logs */}
                      {isTraceExpanded && (
                        <div className="p-2 space-y-1 bg-zinc-50 dark:bg-zinc-950">
                          {logs.map(({ entry, spanId }, idx) => {
                            const entryKey = `${traceId}-${spanId}-${idx}`;
                            const isExpanded = expandedEntries.has(entryKey);
                            const formattedMessage = formatMessage(
                              entry.message,
                            );
                            const messageExpandable =
                              isMessageExpandable(formattedMessage);
                            const displayMessage =
                              messageExpandable && !isExpanded
                                ? truncateMessage(formattedMessage)
                                : formattedMessage;

                            return (
                              <div
                                key={entryKey}
                                className={`relative rounded bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 transform transition-all duration-100 ease-in-out hover:shadow overflow-hidden`}
                              >
                                {/* Header Section */}
                                <div className="flex items-center justify-between px-2 py-1.5 border-b border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-black">
                                  <div className="flex font-mono items-center space-x-2 text-xs flex-wrap min-w-0">
                                    <span
                                      className={`font-medium ${getLogLevelColor(entry.level)}`}
                                    >
                                      {entry.level}
                                    </span>
                                    <span className="text-gray-500 dark:text-gray-400">
                                      {formatTimestamp(entry.time)}
                                    </span>
                                    <span className="text-gray-400 dark:text-gray-500 font-mono">
                                      {entry.file_name}:{entry.line_number}
                                    </span>
                                  </div>
                                  {messageExpandable && (
                                    <Badge
                                      variant="outline"
                                      className="h-6 px-1.5 cursor-pointer hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors flex-shrink-0 whitespace-nowrap"
                                      onClick={() =>
                                        toggleExpandEntry(entryKey)
                                      }
                                    >
                                      {isExpanded ? (
                                        <CircleMinus size={12} />
                                      ) : (
                                        <CirclePlus size={12} />
                                      )}
                                    </Badge>
                                  )}
                                </div>
                                {/* Content Section */}
                                <div className="relative font-mono p-2 bg-white dark:bg-zinc-900 text-neutral-800 dark:text-neutral-300 text-xs">
                                  <span className="whitespace-pre-wrap break-all word-break-break-all overflow-wrap-anywhere m-0 max-w-full block">
                                    {logSearchValue ||
                                    metadataSearchTerms.length > 0
                                      ? highlightText(
                                          displayMessage,
                                          logSearchValue,
                                          metadataSearchTerms,
                                        )
                                      : displayMessage}
                                  </span>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                },
              )}
            </div>
          </div>
        )}
        {!loading &&
          !error &&
          traceIds.length > 0 &&
          orderedLogEntries.length === 0 && (
            <div className="p-4 rounded-lg border border-gray-200 dark:border-gray-700">
              <p className="text-gray-600 dark:text-gray-300">
                No logs found for the selected trace
                {traceIds.length > 1 ? "s" : ""} or span
              </p>
            </div>
          )}
      </div>
    </div>
  );
}
