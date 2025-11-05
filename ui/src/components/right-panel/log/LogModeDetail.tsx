"use client";

import React, { useEffect, useState, useMemo } from "react";
import { LogEntry, TraceLogs, TraceLog } from "@/models/log";
import { useAuth } from "@clerk/nextjs";
import { Spinner } from "@/components/ui/shadcn-io/spinner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { initializeProviders, appendProviderParams } from "@/utils/provider";
import { IoCopyOutline } from "react-icons/io5";
import { FaGithub } from "react-icons/fa";
import {
  Download,
  ArrowDownUp,
  Group,
  Ungroup,
  Plus,
  Minus,
} from "lucide-react";

interface LogModeDetailProps {
  startTime?: Date;
  endTime?: Date;
  logSearchValue?: string;
  refreshKey?: number;
}

export default function LogModeDetail({
  startTime,
  endTime,
  logSearchValue = "",
  refreshKey = 0,
}: LogModeDetailProps) {
  const [allLogs, setAllLogs] = useState<TraceLogs | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isSortDescending, setIsSortDescending] = useState(true);
  const [isGrouped, setIsGrouped] = useState(false);
  const [expandedTraceBlocks, setExpandedTraceBlocks] = useState<Set<string>>(
    new Set(),
  );
  const [traceBlockSortOrder, setTraceBlockSortOrder] = useState<
    Map<string, boolean>
  >(new Map());
  const [nextPaginationToken, setNextPaginationToken] = useState<string | null>(
    null,
  );
  const [hasMore, setHasMore] = useState<boolean>(false);
  const [loadingMore, setLoadingMore] = useState<boolean>(false);
  const { getToken } = useAuth();

  // Clear logs when component mounts or when time range is cleared
  useEffect(() => {
    if (!startTime || !endTime) {
      setAllLogs(null);
      setError(null);
      setNextPaginationToken(null);
      setHasMore(false);
    }
  }, [startTime, endTime]);

  const fetchLogs = async (paginationToken?: string | null) => {
    if (!startTime || !endTime) {
      return;
    }

    const isLoadingMore = !!paginationToken;

    if (isLoadingMore) {
      setLoadingMore(true);
    } else {
      setLoading(true);
    }

    setError(null);

    try {
      const { logProvider, logRegion } = initializeProviders();
      const token = await getToken();

      const url = new URL(
        "/api/get_logs_by_time_range",
        window.location.origin,
      );

      // Convert dates to ISO 8601 UTC strings
      url.searchParams.append("start_time", startTime.toISOString());
      url.searchParams.append("end_time", endTime.toISOString());

      if (logSearchValue) {
        url.searchParams.append("log_search_term", logSearchValue);
      }

      if (paginationToken) {
        url.searchParams.append("pagination_token", paginationToken);
      }

      appendProviderParams(
        url,
        undefined, // no trace provider needed
        undefined, // no trace region needed
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

      // Store pagination info
      setNextPaginationToken(result.next_pagination_token || null);
      setHasMore(result.has_more || false);

      // If loading more, append to existing logs; otherwise replace
      if (isLoadingMore && allLogs) {
        const combinedLogs = {
          logs: [...(allLogs.logs || []), ...(result.logs.logs || [])],
        };
        setAllLogs(combinedLogs);
      } else {
        setAllLogs(result.logs);

        // Auto-expand all trace blocks when grouped
        if (result.logs && result.logs.logs) {
          const traceIds = new Set<string>();
          result.logs.logs.forEach((logDict: TraceLog) => {
            Object.keys(logDict).forEach((traceId) => {
              // Extract trace ID from the first log entry if available
              Object.values(logDict).forEach((spanLogs: any) => {
                if (Array.isArray(spanLogs) && spanLogs.length > 0) {
                  // The trace ID is embedded in the log structure
                  traceIds.add(traceId);
                }
              });
            });
          });
          setExpandedTraceBlocks(traceIds);
        }
      }
    } catch (err) {
      console.error("LogModeDetail fetchLogs - error:", err);
      setError(
        err instanceof Error
          ? err.message
          : "An error occurred while fetching logs",
      );
      if (!isLoadingMore) {
        setAllLogs(null);
      }
    } finally {
      if (isLoadingMore) {
        setLoadingMore(false);
      } else {
        setLoading(false);
      }
    }
  };

  useEffect(() => {
    // Reset pagination when search or time range changes
    setNextPaginationToken(null);
    setHasMore(false);
    fetchLogs();
  }, [startTime, endTime, logSearchValue, refreshKey]);

  // Build ordered log entries from TraceLogs
  const orderedLogEntries = useMemo(() => {
    if (!allLogs || !allLogs.logs) return [];

    const entries: {
      entry: LogEntry;
      traceId: string;
      spanId: string;
    }[] = [];

    try {
      // The structure from get_logs_by_time_range is:
      // logs: [{ spanId: [LogEntry, ...] }, { spanId: [LogEntry, ...] }, ...]
      // Note: There's no trace ID grouping when querying by time range

      allLogs.logs.forEach((spanLog: any) => {
        // Each spanLog is an object with one key (the spanId)
        Object.entries(spanLog).forEach(([spanId, logEntries]) => {
          // Ensure logEntries is an array
          if (!Array.isArray(logEntries)) {
            console.warn(
              `logEntries for spanId ${spanId} is not an array:`,
              logEntries,
            );
            return;
          }

          logEntries.forEach((entry: LogEntry) => {
            // Use trace_id from the log entry if available, otherwise use spanId
            const traceId = entry.trace_id || spanId || "unknown";
            entries.push({ entry, traceId, spanId });
          });
        });
      });
    } catch (err) {
      console.error("Error parsing log entries:", err);
    }

    // Sort by timestamp
    entries.sort((a, b) => {
      const diff = a.entry.time - b.entry.time;
      return isSortDescending ? -diff : diff;
    });

    return entries;
  }, [allLogs, isSortDescending]);

  // Group logs by trace ID
  const groupedLogEntries = useMemo(() => {
    const grouped = new Map<
      string,
      { logs: { entry: LogEntry; spanId: string }[]; firstTime: number }
    >();

    // Filter out entries without valid trace IDs (no-trace, unknown, etc.)
    orderedLogEntries.forEach(({ entry, traceId, spanId }) => {
      // Skip entries without a valid trace ID
      if (!traceId || traceId === "unknown" || traceId.startsWith("no-trace")) {
        return;
      }

      if (!grouped.has(traceId)) {
        grouped.set(traceId, { logs: [], firstTime: entry.time });
      }
      grouped.get(traceId)!.logs.push({ entry, spanId });
    });

    // Sort groups by first log timestamp
    const sortedEntries = Array.from(grouped.entries()).sort((a, b) => {
      const diff = a[1].firstTime - b[1].firstTime;
      return isSortDescending ? -diff : diff;
    });

    return new Map(sortedEntries);
  }, [orderedLogEntries, isSortDescending]);

  // Calculate log level statistics
  const logStats = useMemo(() => {
    const stats = {
      TRACE: 0,
      DEBUG: 0,
      INFO: 0,
      WARNING: 0,
      ERROR: 0,
      CRITICAL: 0,
    };

    orderedLogEntries.forEach(({ entry }) => {
      if (entry.level in stats) {
        stats[entry.level as keyof typeof stats]++;
      }
    });

    return stats;
  }, [orderedLogEntries]);

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

    return `${m} ${d}${getOrdinalSuffix(d)}, ${y} ${h}:${min}:${s}`;
  };

  const getLevelColor = (level: string) => {
    switch (level) {
      case "TRACE":
        return "#6366f1";
      case "DEBUG":
        return "#a855f7";
      case "INFO":
        return "#64748b";
      case "WARNING":
        return "#fb923c";
      case "ERROR":
        return "#dc2626";
      case "CRITICAL":
        return "#7f1d1d";
      default:
        return "#64748b";
    }
  };

  const copyToClipboard = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch (err) {
      const textArea = document.createElement("textarea");
      textArea.value = text;
      document.body.appendChild(textArea);
      textArea.select();
      document.execCommand("copy");
      document.body.removeChild(textArea);
    }
  };

  const getGitHubLink = (entry: LogEntry) => {
    if (entry.git_url && entry.commit_id) {
      return entry.git_url;
    }
    return null;
  };

  const handleDownloadCSV = () => {
    const csvRows: string[] = [];

    // Add headers
    const headers = isGrouped
      ? [
          "Trace ID",
          "Level",
          "Timestamp (UTC)",
          "File:Line",
          "Function",
          "Message",
        ]
      : ["Level", "Timestamp (UTC)", "File:Line", "Function", "Message"];
    csvRows.push(headers.join(","));

    // Add data rows
    const sortedEntries = isGrouped
      ? Array.from(groupedLogEntries.entries()).flatMap(([traceId, { logs }]) =>
          logs.map(({ entry }) => ({ entry, traceId })),
        )
      : orderedLogEntries.map(({ entry, traceId }) => ({ entry, traceId }));

    sortedEntries.forEach(({ entry, traceId }) => {
      const utcDate = new Date(entry.time * 1000).toISOString();
      const logLine = `${entry.file_name}:${entry.line_number}`;

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

      const row = isGrouped
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

    const csvContent = csvRows.join("\n");
    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const link = document.createElement("a");
    const url = URL.createObjectURL(blob);

    link.setAttribute("href", url);
    const filename = `logs_${new Date().toISOString().split("T")[0]}.csv`;
    link.setAttribute("download", filename);
    link.style.visibility = "hidden";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const toggleTraceBlock = (traceId: string) => {
    setExpandedTraceBlocks((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(traceId)) {
        newSet.delete(traceId);
      } else {
        newSet.add(traceId);
      }
      return newSet;
    });
  };

  const toggleTraceBlockSort = (traceId: string) => {
    setTraceBlockSortOrder((prev) => {
      const newMap = new Map(prev);
      const currentOrder = newMap.get(traceId) ?? true; // default to descending
      newMap.set(traceId, !currentOrder);
      return newMap;
    });
  };

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center bg-white dark:bg-zinc-950">
        <Spinner
          variant="infinite"
          className="w-8 h-8 text-gray-500 dark:text-gray-300"
        />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex-1 flex items-center justify-center bg-white dark:bg-zinc-950">
        <div className="text-sm text-red-500 dark:text-red-400">{error}</div>
      </div>
    );
  }

  if (!allLogs || !allLogs.logs || orderedLogEntries.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center bg-white dark:bg-zinc-950">
        <div className="text-center space-y-2">
          <div className="text-sm text-muted-foreground">
            No logs found for the selected time range
          </div>
          {logSearchValue && (
            <Badge variant="secondary" className="text-xs">
              Search: {logSearchValue}
            </Badge>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="text-sm bg-zinc-50 dark:bg-zinc-900 rounded-md pt-2 mx-8 overflow-y-auto overflow-x-visible transition-all duration-100 ease-in-out pb-25">
      {/* Log Level Statistics and Action Buttons */}
      <div className="flex justify-between items-center mb-2 mx-2">
        <div>
          <div className="font-mono flex flex-wrap items-center gap-2 px-3 py-1 text-xs my-0.5 text-gray-700 dark:text-gray-200">
            {logStats.TRACE > 0 && (
              <Badge
                variant="secondary"
                className="h-6 px-2 py-1.5 font-normal text-white rounded-sm"
                style={{ backgroundColor: "#6366f1" }}
              >
                TRACE: {logStats.TRACE}
              </Badge>
            )}
            {logStats.DEBUG > 0 && (
              <Badge
                variant="secondary"
                className="h-6 px-2 py-1.5 font-normal text-white rounded-sm"
                style={{ backgroundColor: "#a855f7" }}
              >
                DEBUG: {logStats.DEBUG}
              </Badge>
            )}
            {logStats.INFO > 0 && (
              <Badge
                variant="secondary"
                className="h-6 px-2 py-1.5 font-normal text-white rounded-sm"
                style={{ backgroundColor: "#64748b" }}
              >
                INFO: {logStats.INFO}
              </Badge>
            )}
            {logStats.WARNING > 0 && (
              <Badge
                variant="secondary"
                className="h-6 px-2 py-1.5 font-normal text-white rounded-sm"
                style={{ backgroundColor: "#fb923c" }}
              >
                WARNING: {logStats.WARNING}
              </Badge>
            )}
            {logStats.ERROR > 0 && (
              <Badge
                variant="secondary"
                className="h-6 px-2 py-1.5 font-normal text-white rounded-sm"
                style={{ backgroundColor: "#dc2626" }}
              >
                ERROR: {logStats.ERROR}
              </Badge>
            )}
            {logStats.CRITICAL > 0 && (
              <Badge
                variant="secondary"
                className="h-6 px-2 py-1.5 font-normal text-white rounded-sm"
                style={{ backgroundColor: "#7f1d1d" }}
              >
                CRITICAL: {logStats.CRITICAL}
              </Badge>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0 mx-3">
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
              <p>{isGrouped ? "Ungroup by trace" : "Group by trace"}</p>
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                onClick={handleDownloadCSV}
                variant="outline"
                size="sm"
                className="h-8 gap-1.5"
              >
                <Download className="w-3.5 h-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              <p>Download as CSV</p>
            </TooltipContent>
          </Tooltip>
        </div>
      </div>

      {/* Render logs */}
      <div className="space-y-1 mx-5">
        {isGrouped ? (
          // Grouped view - group by trace ID
          Array.from(groupedLogEntries.entries()).map(([traceId, { logs }]) => {
            const isExpanded = expandedTraceBlocks.has(traceId);
            const isDescending = traceBlockSortOrder.get(traceId) ?? true;
            const groupStats = {
              DEBUG: 0,
              INFO: 0,
              WARNING: 0,
              ERROR: 0,
              CRITICAL: 0,
            };

            logs.forEach(({ entry }) => {
              if (entry.level in groupStats) {
                groupStats[entry.level as keyof typeof groupStats]++;
              }
            });

            // Sort logs within this group based on the group's sort order
            const sortedLogs = [...logs].sort((a, b) => {
              const diff = a.entry.time - b.entry.time;
              return isDescending ? -diff : diff;
            });

            return (
              <div
                key={traceId}
                className="border border-neutral-300 dark:border-neutral-700 rounded-lg bg-white dark:bg-zinc-950 overflow-hidden mb-2"
              >
                {/* Trace Block Header */}
                <div className="bg-white dark:bg-black p-1 border-b border-neutral-300 dark:border-neutral-700">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-0.5 flex-1 min-w-0">
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Badge
                            variant="default"
                            className="h-6 mr-2 justify-start font-mono font-normal overflow-hidden text-ellipsis flex-shrink text-left cursor-default"
                            style={{ maxWidth: "fit-content" }}
                          >
                            {traceId}
                          </Badge>
                        </TooltipTrigger>
                        <TooltipContent>
                          <p className="font-mono text-xs">{traceId}</p>
                        </TooltipContent>
                      </Tooltip>
                      <span className="text-xs text-gray-500 dark:text-gray-400 mr-2 flex-shrink-0">
                        {logs.length} logs
                      </span>
                      {groupStats.ERROR > 0 && (
                        <Badge
                          variant="secondary"
                          className="h-5 px-1.5 py-0.5 text-[10px] font-normal text-white mr-1 flex-shrink-0"
                          style={{ backgroundColor: "#dc2626" }}
                        >
                          ERROR: {groupStats.ERROR}
                        </Badge>
                      )}
                      {groupStats.WARNING > 0 && (
                        <Badge
                          variant="secondary"
                          className="h-5 px-1.5 py-0.5 text-[10px] font-normal text-white flex-shrink-0"
                          style={{ backgroundColor: "#fb923c" }}
                        >
                          WARNING: {groupStats.WARNING}
                        </Badge>
                      )}
                    </div>
                    <div className="flex items-center gap-1 flex-shrink-0">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-8 w-8 p-0"
                        onClick={() => toggleTraceBlockSort(traceId)}
                      >
                        <ArrowDownUp className="w-3.5 h-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-8 w-8 p-0"
                        onClick={() => toggleTraceBlock(traceId)}
                      >
                        {isExpanded ? (
                          <Minus className="w-4 h-4" />
                        ) : (
                          <Plus className="w-4 h-4" />
                        )}
                      </Button>
                    </div>
                  </div>
                </div>

                {/* Trace logs */}
                {isExpanded && (
                  <div className="p-2 space-y-1 bg-zinc-50 dark:bg-zinc-950">
                    {sortedLogs.map(({ entry, spanId }, idx) => {
                      const entryKey = `${traceId}-${spanId}-${idx}`;
                      const githubLink = getGitHubLink(entry);
                      return (
                        <div
                          key={entryKey}
                          className="relative p-1.5 rounded bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 transform transition-all duration-100 ease-in-out hover:shadow"
                        >
                          <div className="flex items-start min-w-0">
                            <div className="flex-1 min-w-0">
                              <div className="flex font-mono items-center space-x-2 text-xs flex-wrap min-w-0">
                                <span
                                  className="font-medium"
                                  style={{ color: getLevelColor(entry.level) }}
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
                              </div>
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
                                  {entry.message}
                                </span>
                              </div>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })
        ) : (
          // Ungrouped view - show all logs in order
          <div className="p-2 space-y-1 bg-zinc-50 dark:bg-zinc-950">
            {orderedLogEntries.map(({ entry, traceId, spanId }, idx) => {
              const githubLink = getGitHubLink(entry);
              return (
                <div
                  key={`${traceId}-${spanId}-${idx}`}
                  className="relative p-1.5 rounded bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 transform transition-all duration-100 ease-in-out hover:shadow"
                >
                  <div className="flex items-start min-w-0">
                    <div className="flex-1 min-w-0">
                      <div className="flex font-mono items-center space-x-2 text-xs flex-wrap min-w-0">
                        {/* Trace ID Badge */}
                        {traceId &&
                          traceId !== "unknown" &&
                          !traceId.startsWith("no-trace") && (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Badge
                                  variant="default"
                                  className="h-5 px-1.5 py-0.5 font-mono font-normal text-[10px] cursor-default"
                                >
                                  {traceId.length > 12
                                    ? `${traceId.substring(0, 12)}...`
                                    : traceId}
                                </Badge>
                              </TooltipTrigger>
                              <TooltipContent>
                                <p className="font-mono text-xs">{traceId}</p>
                              </TooltipContent>
                            </Tooltip>
                          )}
                        <span
                          className="font-medium"
                          style={{ color: getLevelColor(entry.level) }}
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
                      </div>
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
                          {entry.message}
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Load More Button / Summary */}
        {!loadingMore && orderedLogEntries.length > 0 && (
          <div className="mt-3">
            <button
              onClick={
                hasMore ? () => fetchLogs(nextPaginationToken) : undefined
              }
              disabled={!hasMore}
              className={`w-full h-[40px] p-2 rounded border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-zinc-950 transition-colors flex items-center justify-center text-sm text-neutral-600 dark:text-neutral-300 ${
                hasMore
                  ? "hover:bg-zinc-50 dark:hover:bg-zinc-900 cursor-pointer"
                  : "cursor-default opacity-75"
              }`}
            >
              <span className="text-xs">
                {hasMore
                  ? "Load more logs..."
                  : `Showing all ${orderedLogEntries.length} log${orderedLogEntries.length !== 1 ? "s" : ""}`}
              </span>
            </button>
          </div>
        )}

        {/* Loading More Indicator */}
        {loadingMore && (
          <div className="mt-3 flex justify-center py-3">
            <Spinner
              variant="infinite"
              className="w-6 h-6 text-gray-500 dark:text-gray-300"
            />
          </div>
        )}
      </div>
    </div>
  );
}
