"use client";

import React, { useEffect, useState, useRef } from "react";
import { TraceLog, LogEntry } from "@/models/log";
import { Span } from "@/models/trace";
import { FaGithub } from "react-icons/fa";
import { IoCopyOutline } from "react-icons/io5";
import { Plus, Minus } from "lucide-react";
import { fadeInAnimationStyles } from "@/constants/animations";
import ShowCodeToggle from "./ShowCodeToggle";
import CodeContext from "./CodeContext";
import { ViewType } from "../ModeToggle";
import { useUser } from "@/hooks/useUser";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/shadcn-io/spinner";

interface LogDetailProps {
  traceId: string;
  spanIds?: string[];
  traceQueryStartTime?: Date;
  traceQueryEndTime?: Date;
  segments?: Span[];
  viewType?: ViewType;
}

export default function LogDetail({
  traceId,
  spanIds = [],
  traceQueryStartTime,
  traceQueryEndTime,
  segments,
  viewType,
}: LogDetailProps) {
  const [allLogs, setAllLogs] = useState<TraceLog | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showCode, setShowCode] = useState(false);
  const [, forceUpdate] = useState({});
  const [expandedEntries, setExpandedEntries] = useState<Set<string>>(
    new Set(),
  );
  const { getAuthState } = useUser();

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

  // Reset showCode and clear code data when traceId or spanIds changes
  useEffect(() => {
    setShowCode(false);
    // Clear code data from all log entries
    if (allLogs) {
      Object.values(allLogs).forEach((spanLogs) => {
        (spanLogs as any[]).forEach((spanLog) => {
          Object.values(spanLog).forEach((entries) => {
            (entries as LogEntry[]).forEach((entry) => {
              entry.line = undefined;
              entry.lines_above = undefined;
              entry.lines_below = undefined;
            });
          });
        });
      });
    }
  }, [traceId, spanIds, allLogs]);

  // Reset showCode when viewType is not 'log'
  useEffect(() => {
    if (viewType && viewType !== "log") {
      setShowCode(false);
      // Clear code data from all log entries
      if (allLogs) {
        Object.values(allLogs).forEach((spanLogs) => {
          (spanLogs as any[]).forEach((spanLog) => {
            Object.values(spanLog).forEach((entries) => {
              (entries as LogEntry[]).forEach((entry) => {
                entry.line = undefined;
                entry.lines_above = undefined;
                entry.lines_below = undefined;
              });
            });
          });
        });
      }
    }
  }, [viewType, allLogs]);

  useEffect(() => {
    const fetchLogs = async () => {
      if (!traceId) {
        setAllLogs(null);
        return;
      }
      setLoading(true);
      setError(null);
      try {
        // Build URL with query parameters
        const url = new URL("/api/get_trace_log", window.location.origin);
        url.searchParams.append("traceId", traceId);

        const endTime = traceQueryEndTime || new Date();
        const startTime =
          traceQueryStartTime || new Date(endTime.getTime() - 10 * 60 * 1000); // 10 minutes before endTime

        url.searchParams.append("start_time", startTime.toISOString());
        url.searchParams.append("end_time", endTime.toISOString());

        const response = await fetch(url.toString(), {
          headers: {
            Authorization: `Bearer ${getAuthState()}`,
          },
        });
        const result = await response.json();
        if (!result.success) {
          throw new Error(result.error || "Failed to fetch logs");
        }
        // Always store the full logs data
        setAllLogs(result.data);
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
  }, [traceId, traceQueryStartTime, traceQueryEndTime]);

  // Filter logs based on selected spans
  const logs = React.useMemo(() => {
    if (!allLogs) {
      return allLogs;
    }

    // If no spanIds selected, show all logs
    if (spanIds.length === 0) {
      return allLogs;
    }

    // Check if any of the spanIds exist in the current trace data
    const traceData = allLogs[traceId];
    if (!traceData) {
      return allLogs;
    }

    // Get all span IDs that exist in current trace
    const existingSpanIds = new Set<string>();
    traceData.forEach((spanLog: any) => {
      Object.keys(spanLog).forEach((spanId) => existingSpanIds.add(spanId));
    });

    // Check if any of the selected spanIds exist in the current trace
    const hasValidSpanIds = spanIds.some((spanId) =>
      existingSpanIds.has(spanId),
    );
    if (!hasValidSpanIds) {
      return {};
    }

    const filteredLogs: TraceLog = {};
    Object.entries(allLogs).forEach(([traceId, spanLogs]) => {
      const filteredSpanLogs = (spanLogs as any[]).filter((spanLog) => {
        const spanId = Object.keys(spanLog)[0];
        return spanIds.includes(spanId);
      });
      if (filteredSpanLogs.length > 0) {
        filteredLogs[traceId] = filteredSpanLogs;
      }
    });
    return filteredLogs;
  }, [allLogs, spanIds, traceId]);

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
      default:
        return "font-medium text-[#64748b]";
    }
  };

  const getLogStyle = (level: number) => {
    const leftMargin = level * 3 + 1.5;
    const rightMargin = 1.5;
    const width = 100 - leftMargin - rightMargin;

    return {
      width: `${width}%`,
      marginLeft: `${leftMargin}%`,
      marginRight: `${rightMargin}%`,
    };
  };

  // Build spanId -> depth mapping by traversing the span tree
  const buildSpanDepthMap = (spans: Span[] | undefined) => {
    const map: { [spanId: string]: number } = {};
    const traverse = (span: Span, depth: number) => {
      map[span.id] = depth;
      if (span.spans && span.spans.length > 0) {
        span.spans.forEach((childSpan) => traverse(childSpan, depth + 1));
      }
    };
    if (spans) {
      spans.forEach((span) => traverse(span, 0));
    }
    return map;
  };

  // Build flat list of log entries in the order of SpanLogs in LogFile
  const buildOrderedLogEntries = (
    logs: TraceLog | null,
    traceId: string | undefined,
  ) => {
    const result: { entry: LogEntry; spanId: string }[] = [];
    if (!logs || !traceId || !logs[traceId]) return result;
    logs[traceId].forEach((spanLog: any) => {
      Object.entries(spanLog).forEach(([spanId, entries]) => {
        (entries as LogEntry[]).forEach((entry) => {
          result.push({ entry, spanId });
        });
      });
    });
    return result;
  };

  // Compute spanId->depth map
  const spanDepthMap = buildSpanDepthMap(segments);
  // Compute ordered log entries
  const orderedLogEntries = buildOrderedLogEntries(logs, traceId);

  // Calculate log level statistics
  const calculateLogStats = (
    logEntries: { entry: LogEntry; spanId: string }[],
  ) => {
    const stats = {
      DEBUG: 0,
      INFO: 0,
      WARNING: 0,
      ERROR: 0,
      CRITICAL: 0,
    };

    logEntries.forEach(({ entry }) => {
      if (entry.level in stats) {
        stats[entry.level as keyof typeof stats]++;
      }
    });

    return stats;
  };

  const logStats = calculateLogStats(orderedLogEntries);

  // Callback to trigger re-render when log entries are updated
  const handleForceUpdate = () => {
    forceUpdate({});
  };

  const getGitHubLink = (entry: LogEntry) => {
    if (entry.git_url && entry.commit_id) {
      return entry.git_url;
    }
    return null;
  };

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

  const copyToClipboard = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch (err) {
      // Fallback for older browsers
      const textArea = document.createElement("textarea");
      textArea.value = text;
      document.body.appendChild(textArea);
      textArea.select();
      document.execCommand("copy");
      document.body.removeChild(textArea);
    }
  };

  return (
    <div className="h-screen flex flex-col text-xs">
      <div className="bg-white dark:bg-gray-900 pt-0 px-4 pb-6 overflow-y-auto overflow-x-visible">
        {loading && (
          <div className="bg-zinc-50 dark:bg-zinc-900 p-4 rounded-md border border-gray-200 dark:border-gray-700">
            <div className="flex flex-col items-center justify-center py-1 space-y-1">
              <Spinner
                variant="infinite"
                className="w-8 h-8 text-gray-500 dark:text-gray-300"
              />
            </div>
          </div>
        )}
        {error && (
          <div className="bg-zinc-50 dark:bg-zinc-900 p-4 rounded-md border border-red-200 dark:border-red-700">
            <p className="text-red-700 dark:text-red-300">{error}</p>
          </div>
        )}
        {/* Render logs in the order of SpanLogs, using span depth for indentation */}
        {!loading && !error && orderedLogEntries.length > 0 && (
          <div className="text-sm bg-zinc-50 dark:bg-zinc-900 rounded-md pt-2 overflow-y-auto overflow-x-visible transition-all duration-100 ease-in-out">
            {/* Log Level Statistics and Show Code Toggle Button */}
            <div className="flex justify-between items-center mb-2">
              <div>
                <div className="font-mono flex flex-wrap items-center gap-2 px-3 py-1 text-xs my-0.5 text-gray-700 dark:text-gray-200">
                  {logStats.DEBUG > 0 && (
                    <div className="flex items-center">
                      <Badge
                        variant="secondary"
                        className="h-6 px-2 py-1.5 font-normal text-white"
                        style={{ backgroundColor: "#a855f7" }}
                      >
                        DEBUG: {logStats.DEBUG}
                      </Badge>
                    </div>
                  )}
                  {logStats.INFO > 0 && (
                    <div className="flex items-center">
                      <Badge
                        variant="secondary"
                        className="h-6 px-2 py-1.5 font-normal text-white"
                        style={{ backgroundColor: "#64748b" }}
                      >
                        INFO: {logStats.INFO}
                      </Badge>
                    </div>
                  )}
                  {logStats.WARNING > 0 && (
                    <div className="flex items-center">
                      <Badge
                        variant="secondary"
                        className="h-6 px-2 py-1.5 font-normal text-white"
                        style={{ backgroundColor: "#fb923c" }}
                      >
                        WARNING: {logStats.WARNING}
                      </Badge>
                    </div>
                  )}
                  {logStats.ERROR > 0 && (
                    <div className="flex items-center">
                      <Badge
                        variant="secondary"
                        className="h-6 px-2 py-1.5 font-normal text-white"
                        style={{ backgroundColor: "#dc2626" }}
                      >
                        ERROR: {logStats.ERROR}
                      </Badge>
                    </div>
                  )}
                  {logStats.CRITICAL > 0 && (
                    <div className="flex items-center">
                      <Badge
                        variant="secondary"
                        className="h-6 px-2 py-1.5 font-normal text-white"
                        style={{ backgroundColor: "#7f1d1d" }}
                      >
                        CRITICAL: {logStats.CRITICAL}
                      </Badge>
                    </div>
                  )}
                </div>
              </div>
              <div className="flex-shrink-0">
                <ShowCodeToggle
                  logEntries={orderedLogEntries}
                  onLogEntriesUpdate={handleForceUpdate}
                  showCode={showCode}
                  onShowCodeChange={setShowCode}
                />
              </div>
            </div>
            <div
              className={`space-y-1 overflow-y-auto ${showCode ? "pb-20" : "pb-25"}`}
            >
              {orderedLogEntries.map(({ entry, spanId }, idx) => {
                const githubLink = getGitHubLink(entry);
                const entryKey = `${spanId}-${idx}`;
                const isExpanded = expandedEntries.has(entryKey);
                const formattedMessage = formatMessage(entry.message);
                const messageExpandable = isMessageExpandable(formattedMessage);
                const displayMessage =
                  messageExpandable && !isExpanded
                    ? truncateMessage(formattedMessage)
                    : formattedMessage;
                return (
                  <div
                    key={entryKey}
                    className={`relative p-1.5 rounded bg-white dark:bg-zinc-900 border border-gray-200 dark:border-gray-700 transform transition-all duration-100 ease-in-out hover:shadow animate-fadeIn`}
                    style={{
                      ...getLogStyle(spanDepthMap[spanId] ?? 0),
                      animationDelay: `${idx * 3}ms`,
                    }}
                  >
                    <div className="flex items-start min-w-0">
                      <div className="flex-1 min-w-0">
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
                          <span className="text-neutral-600 dark:text-neutral-300 italic">
                            {entry.function_name}
                          </span>
                          {githubLink && (
                            <a
                              href={githubLink}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-neutral-500 dark:text-neutral-300 hover:text-neutral-600 dark:hover:text-neutral-400 transition-colors"
                              title="View on GitHub"
                            >
                              <FaGithub className="inline-block" />
                            </a>
                          )}
                          <div className="relative font-mono p-1 bg-zinc-50 dark:bg-zinc-900 rounded text-neutral-800 dark:text-neutral-300 text-xs min-w-0 max-w-full overflow-hidden min-h-[1.5rem]">
                            <Button
                              onClick={() => copyToClipboard(entry.message)}
                              variant="ghost"
                              size="icon"
                              className="absolute top-0.5 right-0.5 h-5 w-5 opacity-70 hover:opacity-100 transition-opacity z-10"
                              title="Copy message"
                            >
                              <IoCopyOutline className="w-3 h-3" />
                            </Button>
                            <span className="whitespace-pre-wrap break-all word-break-break-all overflow-wrap-anywhere m-0 max-w-full pr-7 block">
                              {displayMessage}
                            </span>
                          </div>
                        </div>
                        {/* Show code context if available */}
                        <CodeContext entry={entry} showCode={showCode} />
                      </div>
                      {/* Expand/Collapse Icon - Only show if message is expandable */}
                      {messageExpandable && (
                        <div className="ml-2 flex-shrink-0 bg-zinc-100 dark:bg-zinc-800 rounded-md">
                          <Button
                            onClick={() => toggleExpandEntry(entryKey)}
                            variant="ghost"
                            size="icon"
                            title={isExpanded ? "Collapse" : "Expand"}
                            className="h-8 w-8"
                          >
                            {isExpanded ? (
                              <Minus className="w-3 h-3 transition-transform duration-200 ease-in-out" />
                            ) : (
                              <Plus className="w-3 h-3 transition-transform duration-200 ease-in-out" />
                            )}
                          </Button>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
        {!loading && !error && traceId && orderedLogEntries.length === 0 && (
          <div className="p-4 rounded-lg border border-gray-200 dark:border-gray-700">
            <p className="text-gray-600 dark:text-gray-300">
              No logs found for this trace or span
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
