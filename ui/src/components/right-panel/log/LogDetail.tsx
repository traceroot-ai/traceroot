"use client";

import React, { useEffect, useState, useRef } from "react";
import { TraceLog, LogEntry } from "@/models/log";
import { Span, Trace as TraceModel } from "@/models/trace";
import { FaGithub, FaPython, FaJava } from "react-icons/fa";
import { IoCopyOutline, IoLogoJavascript } from "react-icons/io5";
import { SiTypescript } from "react-icons/si";
import {
  Plus,
  Minus,
  Download,
  Group,
  Ungroup,
  ArrowDownUp,
} from "lucide-react";
import { fadeInAnimationStyles } from "@/constants/animations";
import ShowCodeToggle from "./ShowCodeToggle";
import CodeContext from "./CodeContext";
import { ViewType } from "../ModeToggle";
import { useAuth } from "@clerk/nextjs";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/shadcn-io/spinner";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { getProviderInfo, appendProviderParams } from "@/utils/provider";

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
  const [loadingTraces, setLoadingTraces] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [showCode, setShowCode] = useState(false);
  const [, forceUpdate] = useState({});
  const [expandedEntries, setExpandedEntries] = useState<Set<string>>(
    new Set(),
  );
  const [isGrouped, setIsGrouped] = useState(false);
  const [expandedTraceBlocks, setExpandedTraceBlocks] = useState<Set<string>>(
    new Set(),
  );
  const [isSortDescending, setIsSortDescending] = useState(false);
  const { getToken } = useAuth();

  // When switching to grouped mode, expand all trace blocks by default
  useEffect(() => {
    if (isGrouped && traceIds.length > 1) {
      setExpandedTraceBlocks(new Set(traceIds));
    }
  }, [isGrouped, traceIds]);

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

  // Reset showCode and clear code data when traceIds or spanIds changes
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
  }, [traceIds, spanIds, allLogs]);

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
      if (!traceIds || traceIds.length === 0) {
        setAllLogs(null);
        setLoadingTraces(new Set());
        return;
      }

      setLoading(true);
      setError(null);
      setLoadingTraces(new Set(traceIds));

      try {
        const { traceProvider, logProvider, traceRegion, logRegion } =
          getProviderInfo();
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

          // Remove from loading set as we process each result
          setLoadingTraces((prev) => {
            const newSet = new Set(prev);
            newSet.delete(result.traceId);
            return newSet;
          });
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
        setLoadingTraces(new Set());
      } finally {
        setLoading(false);
      }
    };
    fetchLogs();
  }, [traceIds, traceQueryStartTime, traceQueryEndTime]);

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
        spanDepthMap: { [spanId: string]: number };
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
          spanDepthMap: { [spanId: string]: number };
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

      // Build span depth map for this trace
      const spanDepthMap = buildSpanDepthMap(trace?.spans);

      if (traceLogs.length > 0) {
        entries.push([
          traceId,
          {
            trace,
            logs: traceLogs,
            spanDepthMap,
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

  // Compute spanId->depth map (for single trace or ungrouped multi-trace)
  const spanDepthMap = buildSpanDepthMap(segments);
  // Compute ordered log entries (for ungrouped view)
  const orderedLogEntries = buildOrderedLogEntries(
    logs,
    traceIds,
    isSortDescending,
  );
  // Compute grouped log entries (for grouped view) - reuses same entry references from orderedLogEntries
  const groupedLogEntries = buildGroupedLogEntries(
    orderedLogEntries,
    traceIds,
    allTraces,
    isSortDescending,
  );

  // Get all log entries for ShowCodeToggle (flattened from grouped view or ungrouped view)
  const allLogEntriesForCodeToggle = React.useMemo(() => {
    if (traceIds.length > 1 && isGrouped) {
      // Flatten all logs from grouped entries
      const flattened: { entry: LogEntry; spanId: string }[] = [];
      groupedLogEntries.forEach(({ logs }) => {
        flattened.push(...logs);
      });
      return flattened;
    }
    // For ungrouped view, remove traceId property to match expected format
    return orderedLogEntries.map(({ entry, spanId }) => ({ entry, spanId }));
  }, [traceIds, isGrouped, groupedLogEntries, orderedLogEntries]);

  // Calculate log level statistics
  const calculateLogStats = (
    logEntries: { entry: LogEntry; spanId: string; traceId: string }[],
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

  // Calculate log level statistics for grouped traces
  const calculateGroupedLogStats = (
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

  // Download logs as CSV
  const downloadLogsAsCSV = () => {
    if (!orderedLogEntries || orderedLogEntries.length === 0) {
      return;
    }

    // Sort by timestamp (latest to most recent, i.e., descending order)
    const sortedEntries = [...orderedLogEntries].sort(
      (a, b) => b.entry.time - a.entry.time,
    );

    // CSV header - include Trace ID if multiple traces
    const headers =
      traceIds.length > 1
        ? [
            "Trace ID",
            "Log Level",
            "Timestamp (UTC)",
            "Log Line",
            "Method Name",
            "Message",
          ]
        : [
            "Log Level",
            "Timestamp (UTC)",
            "Log Line",
            "Method Name",
            "Message",
          ];
    const csvRows = [headers.join(",")];

    // Add data rows
    sortedEntries.forEach(({ entry, traceId }) => {
      // Convert timestamp to UTC
      const utcDate = new Date(entry.time * 1000).toISOString();

      // Log line (file_name:line_number)
      const logLine = `${entry.file_name}:${entry.line_number}`;

      // Escape CSV fields (handle quotes and commas)
      const escapeCSV = (field: string) => {
        if (
          field.includes('"') ||
          field.includes(",") ||
          field.includes("\n")
        ) {
          return `"${field.replace(/"/g, '""')}"`;
        }
        return field;
      };

      const row =
        traceIds.length > 1
          ? [
              escapeCSV(traceId),
              escapeCSV(entry.level),
              escapeCSV(utcDate),
              escapeCSV(logLine),
              escapeCSV(entry.function_name || ""),
              escapeCSV(entry.message || ""),
            ]
          : [
              escapeCSV(entry.level),
              escapeCSV(utcDate),
              escapeCSV(logLine),
              escapeCSV(entry.function_name || ""),
              escapeCSV(entry.message || ""),
            ];

      csvRows.push(row.join(","));
    });

    // Create CSV content
    const csvContent = csvRows.join("\n");

    // Create blob and download
    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const link = document.createElement("a");
    const url = URL.createObjectURL(blob);

    link.setAttribute("href", url);
    const filename =
      traceIds.length === 1
        ? `${traceIds[0]}.csv`
        : `traces_${traceIds.length}.csv`;
    link.setAttribute("download", filename);
    link.style.visibility = "hidden";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
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
      <div className="bg-white dark:bg-zinc-950 pt-0 px-4 pb-6 overflow-y-auto overflow-x-visible">
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
          <div className="text-sm bg-zinc-50 dark:bg-zinc-900 rounded-md pt-2 overflow-y-auto overflow-x-visible transition-all duration-100 ease-in-out">
            {/* Log Level Statistics and Action Buttons */}
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
              <div className="flex items-center gap-2 flex-shrink-0">
                {traceIds.length > 1 && (
                  <>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          onClick={() => setIsSortDescending(!isSortDescending)}
                          variant="outline"
                          size="sm"
                          className="h-8 gap-1.5"
                        >
                          <ArrowDownUp className="w-3.5 h-3.5" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>
                        <p>
                          {isGrouped
                            ? "Reverse group order by trace timestamp"
                            : "Reverse log order by logging timestamp"}
                        </p>
                      </TooltipContent>
                    </Tooltip>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          onClick={() => setIsGrouped(!isGrouped)}
                          variant="outline"
                          size="sm"
                          className="h-8 gap-1.5"
                        >
                          {isGrouped ? (
                            <Ungroup className="w-3.5 h-3.5" />
                          ) : (
                            <Group className="w-3.5 h-3.5" />
                          )}
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>
                        <p>
                          {isGrouped
                            ? "Flatten loggings"
                            : "Group loggings according to traces"}
                        </p>
                      </TooltipContent>
                    </Tooltip>
                  </>
                )}
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      onClick={downloadLogsAsCSV}
                      variant="outline"
                      size="sm"
                      className="h-8 gap-1.5"
                    >
                      <Download className="w-3.5 h-3.5" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    <p>
                      {traceIds.length === 1
                        ? `Download logs for ${traceIds[0].substring(0, 12)}...`
                        : `Download logs for ${traceIds.length} traces`}
                    </p>
                  </TooltipContent>
                </Tooltip>
                <ShowCodeToggle
                  logEntries={allLogEntriesForCodeToggle}
                  onLogEntriesUpdate={handleForceUpdate}
                  showCode={showCode}
                  onShowCodeChange={setShowCode}
                />
              </div>{" "}
            </div>
            <div
              className={`space-y-1 overflow-y-auto ${showCode ? "pb-20" : "pb-25"}`}
            >
              {/* Grouped View: Show logs grouped by trace */}
              {traceIds.length > 1 && isGrouped
                ? Array.from(groupedLogEntries.entries()).map(
                    ([traceId, { trace, logs, spanDepthMap }]) => {
                      const isTraceExpanded = expandedTraceBlocks.has(traceId);

                      return (
                        <div
                          key={traceId}
                          className="border border-neutral-300 dark:border-neutral-700 rounded-lg bg-white dark:bg-zinc-950 overflow-hidden mb-2 mr-3 ml-3"
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
                                <Badge
                                  variant="default"
                                  className="min-w-16 h-6 mr-2 justify-start font-mono font-normal max-w-full overflow-hidden text-ellipsis flex-shrink text-left"
                                  title={traceId}
                                >
                                  {traceId.substring(0, 12)}...
                                </Badge>
                                {trace?.service_name && (
                                  <Badge
                                    variant="default"
                                    className="min-w-16 h-6 mr-2 justify-start font-mono font-normal max-w-full overflow-hidden text-ellipsis flex-shrink text-left"
                                    title={
                                      trace.service_name.length > 25
                                        ? trace.service_name
                                        : undefined
                                    }
                                  >
                                    {trace.service_name}
                                  </Badge>
                                )}
                                {trace?.service_environment && (
                                  <Badge
                                    variant="outline"
                                    className="h-6 mr-2 justify-center font-mono font-normal flex-shrink-0"
                                  >
                                    {trace.service_environment}
                                  </Badge>
                                )}
                              </div>
                              {trace?.start_time && (
                                <span className="text-xs text-gray-500 dark:text-gray-400 font-mono mr-2">
                                  {formatTimestamp(trace.start_time)}
                                </span>
                              )}
                              <Button
                                variant="ghost"
                                size="sm"
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
                                className="h-8 w-8 p-0"
                              >
                                {isTraceExpanded ? (
                                  <Minus className="w-4 h-4" />
                                ) : (
                                  <Plus className="w-4 h-4" />
                                )}
                              </Button>
                            </div>
                          </div>

                          {/* Trace Logs */}
                          {isTraceExpanded && (
                            <div className="p-2 space-y-1 bg-zinc-50 dark:bg-zinc-950">
                              {logs.map(({ entry, spanId }, idx) => {
                                const githubLink = getGitHubLink(entry);
                                const entryKey = `${traceId}-${spanId}-${idx}`;
                                const isExpanded =
                                  expandedEntries.has(entryKey);
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
                                    className={`relative p-1.5 rounded bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 transform transition-all duration-100 ease-in-out hover:shadow`}
                                    style={getLogStyle(
                                      spanDepthMap[spanId] ?? 0,
                                    )}
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
                                            {entry.file_name}:
                                            {entry.line_number}
                                          </span>
                                          <span className="text-neutral-600 dark:text-neutral-300 italic break-all">
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
                                        </div>
                                        <div className="relative font-mono p-1 bg-zinc-50 dark:bg-zinc-900 rounded text-neutral-800 dark:text-neutral-300 text-xs min-w-0 max-w-full overflow-hidden min-h-[1.5rem]">
                                          <Button
                                            onClick={() =>
                                              copyToClipboard(entry.message)
                                            }
                                            variant="ghost"
                                            size="icon"
                                            className="absolute top-0.5 right-0.5 h-5 w-5 opacity-70 hover:opacity-100 transition-opacity z-10"
                                            title="Copy message"
                                          >
                                            <IoCopyOutline className="w-3 h-3" />
                                          </Button>
                                          <span className="whitespace-pre-wrap break-all word-break-break-all overflow-wrap-anywhere m-0 max-w-full pr-7 block">
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
                                        {/* Show code context if available */}
                                        <CodeContext
                                          entry={entry}
                                          showCode={showCode}
                                        />
                                      </div>
                                      {messageExpandable && (
                                        <div className="ml-2 flex-shrink-0">
                                          <Button
                                            variant="ghost"
                                            size="sm"
                                            onClick={() => {
                                              setExpandedEntries((prev) => {
                                                const newSet = new Set(prev);
                                                if (newSet.has(entryKey)) {
                                                  newSet.delete(entryKey);
                                                } else {
                                                  newSet.add(entryKey);
                                                }
                                                return newSet;
                                              });
                                            }}
                                            className="h-6 w-6 p-0"
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
                          )}
                        </div>
                      );
                    },
                  )
                : /* Ungrouped View: Show all logs merged chronologically */
                  orderedLogEntries.map(({ entry, spanId, traceId }, idx) => {
                    const githubLink = getGitHubLink(entry);
                    const entryKey = `${traceId}-${spanId}-${idx}`;
                    const isExpanded = expandedEntries.has(entryKey);
                    const formattedMessage = formatMessage(entry.message);
                    const messageExpandable =
                      isMessageExpandable(formattedMessage);
                    const displayMessage =
                      messageExpandable && !isExpanded
                        ? truncateMessage(formattedMessage)
                        : formattedMessage;

                    // For multiple traces, use flat layout (no indentation)
                    // For single trace, use tree structure with indentation
                    const logStyle =
                      traceIds.length > 1
                        ? { animationDelay: `${idx * 3}ms` }
                        : {
                            ...getLogStyle(spanDepthMap[spanId] ?? 0),
                            animationDelay: `${idx * 3}ms`,
                          };

                    return (
                      <div
                        key={entryKey}
                        className={`relative p-1.5 rounded bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 transform transition-all duration-100 ease-in-out hover:shadow animate-fadeIn ${traceIds.length > 1 ? "mx-3" : ""}`}
                        style={logStyle}
                      >
                        <div className="flex items-start min-w-0">
                          <div className="flex-1 min-w-0">
                            <div className="flex font-mono items-center space-x-2 text-xs flex-wrap min-w-0">
                              {traceIds.length > 1 && (
                                <Badge
                                  variant="default"
                                  className="h-5 px-1.5 text-xs font-mono font-normal max-w-full overflow-hidden text-ellipsis flex-shrink text-left"
                                  title={traceId}
                                >
                                  {traceId.substring(0, 8)}...
                                </Badge>
                              )}
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
                              <span className="text-neutral-600 dark:text-neutral-300 italic break-all">
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
