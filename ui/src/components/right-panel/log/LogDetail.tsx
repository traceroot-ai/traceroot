'use client';

import React, { useEffect, useState, useRef } from 'react';
import { TraceLog, LogEntry } from '@/models/log';
import { Span } from '@/models/trace';
import { FaGithub, FaPlus, FaMinus } from "react-icons/fa";
import { fadeInAnimationStyles } from '@/constants/animations';
import ShowCodeToggle from './ShowCodeToggle';
import CodeContext from './CodeContext';
import { ViewType } from '../ModeToggle';
import { useUser } from '@/hooks/useUser';

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
  viewType
}: LogDetailProps) {
  const [allLogs, setAllLogs] = useState<TraceLog | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showCode, setShowCode] = useState(false);
  const [, forceUpdate] = useState({});
  const [expandedEntries, setExpandedEntries] = useState<Set<string>>(new Set());
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
    if (viewType && viewType !== 'log') {
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
        const url = new URL('/api/get_trace_log', window.location.origin);
        url.searchParams.append('traceId', traceId);

        const endTime = traceQueryEndTime || new Date();
        const startTime = traceQueryStartTime || new Date(endTime.getTime() - 10 * 60 * 1000); // 10 minutes before endTime

        url.searchParams.append('start_time', startTime.toISOString());
        url.searchParams.append('end_time', endTime.toISOString());

        const response = await fetch(url.toString(), {
          headers: {
            'Authorization': `Bearer ${getAuthState()}`,
          },
        });
        const result = await response.json();
        if (!result.success) {
          throw new Error(result.error || 'Failed to fetch logs');
        }
        // Always store the full logs data
        setAllLogs(result.data);
      } catch (err) {
        console.error('LogDetail fetchLogs - error:', err);
        setError(err instanceof Error ? err.message : 'An error occurred while fetching logs');
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
      Object.keys(spanLog).forEach(spanId => existingSpanIds.add(spanId));
    });

    // Check if any of the selected spanIds exist in the current trace
    const hasValidSpanIds = spanIds.some(spanId => existingSpanIds.has(spanId));
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
    return new Date(timestamp * 1000).toLocaleString();
  };

  const getLogLevelColor = (level: string) => {
    switch (level) {
      case 'CRITICAL':
        return 'text-red-700 dark:text-red-300 font-medium';
      case 'ERROR':
        return 'text-red-500 dark:text-red-400 font-medium';
      case 'WARNING':
        return 'text-yellow-600 dark:text-yellow-400 font-medium';
      case 'INFO':
        return 'text-blue-600 dark:text-blue-400 font-medium';
      case 'DEBUG':
        return 'text-purple-600 dark:text-purple-400 font-medium';
      default:
        return 'text-gray-600 dark:text-gray-400 font-medium';
    }
  };

  const getLogLevelBgColorForStats = (level: string) => {
    switch (level) {
      case 'CRITICAL':
        return 'bg-red-500 dark:bg-red-300';
      case 'ERROR':
        return 'bg-red-400 dark:bg-red-200';
      case 'WARNING':
        return 'bg-yellow-400 dark:bg-yellow-200';
      case 'INFO':
        return 'bg-blue-400 dark:bg-blue-200';
      case 'DEBUG':
        return 'bg-purple-400 dark:bg-purple-200';
      default:
        return 'bg-gray-600 dark:bg-gray-400';
    }
  };

  const getLogLevelBgColor = (level: string) => {
    switch (level) {
      case 'CRITICAL':
        return 'bg-red-200 dark:bg-red-800/40';
      case 'ERROR':
        return 'bg-red-100 dark:bg-red-900/30';
      case 'WARNING':
        return 'bg-yellow-100 dark:bg-yellow-900/30';
      case 'INFO':
        return 'bg-sky-200 dark:bg-sky-900/30';
      case 'DEBUG':
        return 'bg-purple-50 dark:bg-purple-900/30';
      default:
        return 'bg-gray-50 dark:bg-gray-900';
    }
  };

  const getLogWidth = (level: number) => {
    return `${Math.max(100 - (level * 3), 60)}%`;
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
  const buildOrderedLogEntries = (logs: TraceLog | null, traceId: string | undefined) => {
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
  const calculateLogStats = (logEntries: { entry: LogEntry; spanId: string }[]) => {
    const stats = {
      DEBUG: 0,
      INFO: 0,
      WARNING: 0,
      ERROR: 0,
      CRITICAL: 0
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
    setExpandedEntries(prev => {
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
    return message.substring(0, maxLength) + '......';
  };

  const isMessageExpandable = (message: string, maxLength: number = 500) => {
    return message.length > maxLength;
  };

  // Format message with smart line breaks for long content
  const formatMessage = (message: string, maxLineLength: number = 80) => {
    // Split message into existing lines first
    const existingLines = message.split('\n');
    const processedLines: string[] = [];

    // Process each line individually
    for (const line of existingLines) {
      // If line is shorter than max length, keep as is
      if (line.length <= maxLineLength) {
        processedLines.push(line);
        continue;
      }

      // For long lines, add smart breaks while preserving leading whitespace
      const leadingWhitespace = line.match(/^\s*/)?.[0] || '';
      const trimmedLine = line.trimStart();
      const words = trimmedLine.split(' ');
      const wrappedLines: string[] = [];
      let currentLine = '';

      for (const word of words) {
        const wordWithSpace = (currentLine ? ' ' : '') + word;
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

    return processedLines.join('\n');
  };

  return (
    <div className="h-screen flex flex-col text-xs">
      <div className="bg-white dark:bg-gray-800 pt-0 px-4 pb-4 overflow-y-auto overflow-x-visible">
        {loading && (
          <div className="p-4 rounded-lg border border-gray-200 dark:border-gray-700">
            <p className="text-gray-600 dark:text-gray-300">Loading logs...</p>
          </div>
        )}
        {error && (
          <div className="p-4 rounded-lg border border-red-200 dark:border-red-700">
            <p className="text-red-600 dark:text-red-400">{error}</p>
          </div>
        )}
        {/* Render logs in the order of SpanLogs, using span depth for indentation */}
        {!loading && !error && orderedLogEntries.length > 0 && (
          <div className="text-sm bg-white rounded-lg border border-gray-200 dark:border-gray-700 dark:bg-gray-800 p-3 overflow-y-auto overflow-x-visible transition-all duration-300 ease-in-out">
            {/* Log Level Statistics and Show Code Toggle Button */}
            <div className="flex justify-between items-center mb-4 gap-4">
              <div className="flex-1 inline-flex rounded-md bg-gray-10 dark:bg-gray-300 ring-1 ring-gray-200 dark:ring-gray-600 border-gray-200 dark:border-gray-600">
                <div className="font-mono flex flex-wrap items-center gap-4 px-4 py-1 text-xs rounded my-0.5 text-gray-700 dark:text-gray-200">
                  {logStats.DEBUG > 0 && (
                    <div className="flex items-center">
                      <span className={`${getLogLevelBgColor('DEBUG')} ${getLogLevelColor('DEBUG')} px-2 py-1.5 rounded-md`}>DEBUG: {logStats.DEBUG}</span>
                    </div>
                  )}
                  {logStats.INFO > 0 && (
                    <div className="flex items-center">
                      <span className={`${getLogLevelBgColor('INFO')} ${getLogLevelColor('INFO')} px-2 py-1.5 rounded-md`}>INFO: {logStats.INFO}</span>
                    </div>
                  )}
                  {logStats.WARNING > 0 && (
                    <div className="flex items-center">
                      <span className={`${getLogLevelBgColor('WARNING')} ${getLogLevelColor('WARNING')} px-2 py-1.5 rounded-md`}>WARNING: {logStats.WARNING}</span>
                    </div>
                  )}
                  {logStats.ERROR > 0 && (
                    <div className="flex items-center">
                      <span className={`${getLogLevelBgColor('ERROR')} ${getLogLevelColor('ERROR')} px-2 py-1.5 rounded-md`}>ERROR: {logStats.ERROR}</span>
                    </div>
                  )}
                  {logStats.CRITICAL > 0 && (
                    <div className="flex items-center">
                      <span className={`${getLogLevelBgColor('CRITICAL')} ${getLogLevelColor('CRITICAL')} px-2 py-1.5 rounded-md`}>CRITICAL: {logStats.CRITICAL}</span>
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
            <div className={`space-y-2 overflow-y-auto overflow-x-visible ${showCode ? "pb-20" : "pb-25"}`}>
              {orderedLogEntries.map(({ entry, spanId }, idx) => {
              const githubLink = getGitHubLink(entry);
              const entryKey = `${spanId}-${idx}`;
              const isExpanded = expandedEntries.has(entryKey);
              const formattedMessage = formatMessage(entry.message);
              const messageExpandable = isMessageExpandable(formattedMessage);
              const displayMessage = messageExpandable && !isExpanded ? truncateMessage(formattedMessage) : formattedMessage;
              return (
                <div
                  key={entryKey}
                  className={`relative p-2 rounded ${getLogLevelBgColor(entry.level)} ml-auto transform transition-all duration-300 ease-in-out hover:shadow animate-fadeIn`}
                  style={{
                    width: getLogWidth(spanDepthMap[spanId] ?? 0),
                    animationDelay: `${idx * 10}ms`
                  }}
                >
                  <div className="flex items-start">
                    <div className="flex-1">
                      <div className="flex font-mono items-center space-x-2 text-xs flex-wrap">
                        <span className={`font-medium ${getLogLevelColor(entry.level)}`}>{entry.level}</span>
                        <span className="text-gray-500 dark:text-gray-400">
                          {formatTimestamp(entry.time)}
                        </span>
                        <span className="text-gray-400 dark:text-gray-500 font-mono">
                          {entry.file_name}:{entry.line_number}
                        </span>
                        {githubLink && (
                          <a
                            href={githubLink}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-gray-400 dark:text-gray-500 hover:text-blue-500 dark:hover:text-blue-400 transition-colors"
                            title="View on GitHub"
                          >
                            <FaGithub className="inline-block" />
                          </a>
                        )}
                        <span className="text-gray-500 dark:text-gray-400 italic">
                          {entry.function_name}
                        </span>
                        <span className="whitespace-pre text-gray-700 font-mono dark:text-gray-300 break-words text-xs">
                          {displayMessage}
                        </span>
                      </div>
                      {/* Show code context if available */}
                      <CodeContext entry={entry} showCode={showCode} />
                    </div>
                    {/* Expand/Collapse Icon - Only show if message is expandable */}
                    {messageExpandable && (
                      <div className="ml-2 flex-shrink-0">
                        <button
                          onClick={() => toggleExpandEntry(entryKey)}
                          className="p-2 rounded bg-white/70 dark:bg-gray-800/70 border border-gray-200/50 dark:border-gray-600/50 text-gray-600 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200 hover:bg-white dark:hover:bg-gray-700/30 hover:border-gray-300/70 dark:hover:border-gray-500/70 transition-all duration-100 transform hover:scale-105 shadow-lg hover:shadow"
                          title={isExpanded ? "Collapse" : "Expand"}
                        >
                          {isExpanded ? (
                            <FaMinus className="w-3 h-3 transition-transform duration-200 ease-in-out" />
                          ) : (
                            <FaPlus className="w-3 h-3 transition-transform duration-200 ease-in-out" />
                          )}
                        </button>
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
            <p className="text-gray-600 dark:text-gray-300">No logs found for this trace</p>
          </div>
        )}
      </div>
    </div>
  );
}
