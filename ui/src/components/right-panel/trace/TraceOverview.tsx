"use client";

import React from "react";
import { format, formatDistanceToNow } from "date-fns";
import {
  IoTimeOutline,
  IoStatsChartOutline,
  IoPlayOutline,
  IoStopOutline,
} from "react-icons/io5";
import { Badge } from "@/components/ui/badge";
import ScatterPlot from "../../plot/Scatter";

interface TraceOverviewProps {
  // Single trace props
  traceQueryStartTime?: Date;
  traceQueryEndTime?: Date;
  // Multiple trace props
  traceIDs?: string[]; // Array of trace IDs
  traceStartTimes?: Date[]; // Array of trace start times
  traceEndTimes?: Date[]; // Array of trace end times
  traceDurations?: number[]; // Array of durations in milliseconds
  tracePercentiles?: string[]; // Array of percentiles for each trace (e.g. 'P90', 'P50', ...)
  // Callback props
  onTraceSelect?: (traceId: string) => void; // Add callback for trace selection
}

export default function TraceOverview({
  // Single trace props
  traceQueryStartTime,
  traceQueryEndTime,
  // Multiple trace props
  traceIDs = [],
  traceStartTimes = [],
  traceEndTimes = [],
  traceDurations = [],
  tracePercentiles = [],
  // Callback props
  onTraceSelect,
}: TraceOverviewProps) {
  // Debug log

  const formatTimeRange = () => {
    // Handle single trace case
    if (traceQueryStartTime && traceQueryEndTime) {
      const startFormatted = format(
        traceQueryStartTime,
        "MMM d, yyyy hh:mm:ss a",
      );
      const endFormatted = format(traceQueryEndTime, "MMM d, yyyy hh:mm:ss a");
      const timeAgo = formatDistanceToNow(traceQueryEndTime, {
        addSuffix: true,
      });
      const duration = formatDistanceToNow(traceQueryStartTime, {
        addSuffix: false,
      });

      return (
        <div className="space-y-4">
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            {/* Start Time */}
            <div className="bg-zinc-50 dark:bg-zinc-900 rounded-lg p-4 group">
              <div className="flex items-center space-x-3 mb-2">
                <div className="p-2 bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-lg">
                  <IoPlayOutline
                    className="text-zinc-800 dark:text-zinc-300"
                    size={18}
                  />
                </div>
                <div className="text-sm font-mono font-semibold text-zinc-700 dark:text-zinc-300">
                  Start Time
                </div>
              </div>
              <div className="text-sm font-mono font-medium text-zinc-700 dark:text-zinc-100 leading-relaxed">
                {startFormatted}
              </div>
            </div>

            {/* Duration */}
            <div className="bg-zinc-50 dark:bg-zinc-900 rounded-lg p-4 group">
              <div className="flex items-center space-x-3 mb-2">
                <div className="p-2 bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-lg">
                  <IoTimeOutline
                    className="text-zinc-800 dark:text-zinc-300"
                    size={18}
                  />
                </div>
                <div className="text-sm font-mono font-semibold text-zinc-700 dark:text-zinc-300">
                  Duration
                </div>
              </div>
              <div className="text-sm font-mono font-medium text-zinc-700 dark:text-zinc-100 leading-relaxed">
                {duration}
              </div>
            </div>

            {/* End Time */}
            <div className="bg-zinc-50 dark:bg-zinc-900 rounded-lg p-4 group">
              <div className="flex items-center space-x-3 mb-2">
                <div className="p-2 bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-lg">
                  <IoStopOutline
                    className="text-zinc-800 dark:text-zinc-300"
                    size={18}
                  />
                </div>
                <div className="text-sm font-mono font-semibold text-zinc-700 dark:text-zinc-300">
                  End Time
                </div>
              </div>
              <div className="text-sm font-mono font-medium text-zinc-700 dark:text-zinc-100 leading-relaxed">
                {endFormatted}
              </div>
            </div>
          </div>

          {/* Last Updated */}
          <div className="text-center">
            <Badge variant="secondary" className="space-x-2">
              <IoTimeOutline size={12} />
              <span>Last updated {timeAgo}</span>
            </Badge>
          </div>
        </div>
      );
    }

    // Handle multiple traces case
    if (traceStartTimes.length > 0 && traceEndTimes.length > 0) {
      const earliestStart = new Date(
        Math.min(...traceStartTimes.map((t) => t.getTime())),
      );
      const latestEnd = new Date(
        Math.max(...traceEndTimes.map((t) => t.getTime())),
      );

      const startFormatted = format(earliestStart, "MMM d, yyyy hh:mm:ss a");
      const endFormatted = format(latestEnd, "MMM d, yyyy hh:mm:ss a");
      const timeAgo = formatDistanceToNow(latestEnd, { addSuffix: true });
      const duration = formatDistanceToNow(earliestStart, { addSuffix: false });

      return (
        <div className="space-y-4">
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            {/* Earliest Start */}
            <div className="bg-zinc-50 dark:bg-zinc-900 rounded-lg p-4 group">
              <div className="flex items-center space-x-3 mb-2">
                <div className="p-2 bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-lg">
                  <IoPlayOutline
                    className="text-zinc-800 dark:text-zinc-300"
                    size={18}
                  />
                </div>
                <div className="text-sm font-mono font-semibold text-zinc-700 dark:text-zinc-300">
                  Earliest Start
                </div>
              </div>
              <div className="text-sm font-mono font-medium text-zinc-700 dark:text-zinc-100 leading-relaxed">
                {startFormatted}
              </div>
            </div>

            {/* Total Duration */}
            <div className="bg-zinc-50 dark:bg-zinc-900 rounded-lg p-4 group">
              <div className="flex items-center space-x-3 mb-2">
                <div className="p-2 bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-lg">
                  <IoTimeOutline
                    className="text-zinc-800 dark:text-zinc-300"
                    size={18}
                  />
                </div>
                <div className="text-sm font-mono font-semibold text-zinc-700 dark:text-zinc-300">
                  Total Duration
                </div>
              </div>
              <div className="text-sm font-mono font-medium text-zinc-700 dark:text-zinc-100 leading-relaxed">
                {duration}
              </div>
            </div>

            {/* Latest End */}
            <div className="bg-zinc-50 dark:bg-zinc-900 rounded-lg p-4 group">
              <div className="flex items-center space-x-3 mb-2">
                <div className="p-2 bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-lg">
                  <IoStopOutline
                    className="text-zinc-800 dark:text-zinc-300"
                    size={18}
                  />
                </div>
                <div className="text-sm font-mono font-semibold text-zinc-700 dark:text-zinc-300">
                  Latest End
                </div>
              </div>
              <div className="text-sm font-mono font-medium text-zinc-700 dark:text-zinc-100 leading-relaxed">
                {endFormatted}
              </div>
            </div>
          </div>

          {/* Stats and Last Updated */}
          <div className="flex flex-col sm:flex-row items-center justify-center space-y-2 sm:space-y-0 sm:space-x-4">
            <Badge variant="outline" className="space-x-2">
              <IoStatsChartOutline size={12} />
              <span>{traceIDs.length} traces</span>
            </Badge>
            <Badge variant="secondary" className="space-x-2">
              <IoTimeOutline size={12} />
              <span>Last updated {timeAgo}</span>
            </Badge>
          </div>
        </div>
      );
    }

    return (
      <div className="text-center py-8">
        <Badge variant="secondary" className="space-x-2 text-sm">
          <IoTimeOutline size={16} />
          <span>No time range data available</span>
        </Badge>
      </div>
    );
  };

  const renderScatterPlot = () => {
    if (traceStartTimes.length === 0 || traceDurations.length === 0) {
      return null;
    }

    const scatterData = traceStartTimes.map((startTime, index) => ({
      x: startTime,
      y: traceDurations[index],
      label: tracePercentiles[index] || "default",
      traceId: traceIDs[index], // Include traceId for click handling
    }));

    const isPercentilePlot = tracePercentiles.length > 0;

    return (
      <div className="max-w-full bg-white dark:bg-zinc-900 rounded-xl border border-zinc-200 dark:border-zinc-700">
        {/* Content */}
        <div className="p-8">
          <ScatterPlot
            data={scatterData}
            height={300}
            xAxisLabel="Start Time"
            yAxisLabel="Latency (s)"
            isPercentilePlot={isPercentilePlot}
            onPointClick={onTraceSelect} // Pass the trace selection callback
          />
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-4 p-4 bg-zinc-50 dark:bg-zinc-900 mx-4 mb-4 mt-1 rounded-lg">
      {/* Query Time Range Card */}
      <div className="bg-white dark:bg-zinc-900 rounded-lg border border-zinc-200 dark:border-zinc-700">
        {/* Content */}
        <div className="p-6">{formatTimeRange()}</div>
      </div>

      {/* Latency Chart */}
      {renderScatterPlot()}
    </div>
  );
}
