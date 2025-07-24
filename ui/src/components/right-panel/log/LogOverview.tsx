'use client';

import React from 'react';
import { format, formatDistanceToNow } from 'date-fns';
import { IoWarningOutline, IoTimeOutline, IoPlayOutline, IoStopOutline, IoStatsChartOutline } from "react-icons/io5";

interface LogOverviewProps {
  // Single trace props
  traceQueryStartTime?: Date;
  traceQueryEndTime?: Date;
  // Multiple trace props
  traceIDs?: string[];  // Array of trace IDs
  traceStartTimes?: Date[];  // Array of trace start times
  traceEndTimes?: Date[];    // Array of trace end times
  traceDurations?: number[];  // Array of durations in milliseconds
  tracePercentiles?: string[]; // Array of percentiles for each trace (e.g. 'P90', 'P50', ...)
  // Callback props
  onTraceSelect?: (traceId: string) => void; // Add callback for trace selection
}

export default function LogOverview({
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
  onTraceSelect
}: LogOverviewProps) {
  const formatTimeRange = () => {
    // Handle single trace case
    if (traceQueryStartTime && traceQueryEndTime) {
      const startFormatted = format(traceQueryStartTime, 'MMM d, yyyy hh:mm:ss a');
      const endFormatted = format(traceQueryEndTime, 'MMM d, yyyy hh:mm:ss a');
      const timeAgo = formatDistanceToNow(traceQueryEndTime, { addSuffix: true });
      const duration = formatDistanceToNow(traceQueryStartTime, { addSuffix: false });

      return (
        <div className="space-y-4">
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            {/* Start Time */}
            <div className="bg-gradient-to-br from-gray-50 to-gray-100 dark:from-gray-800/50 dark:to-gray-700/50 border border-gray-200 dark:border-gray-600 rounded-xl p-4 group hover:shadow-md transition-all duration-200">
              <div className="flex items-center space-x-3 mb-2">
                <div className="p-2 bg-gray-200 dark:bg-gray-700 rounded-lg">
                  <IoPlayOutline className="text-gray-800 dark:text-gray-300" size={18} />
                </div>
                <div className="text-md font-mono font-semibold text-gray-700 dark:text-gray-300">
                  Start Time
                </div>
              </div>
              <div className="text-sm font-mono font-medium text-gray-700 dark:text-gray-100 leading-relaxed">
                {startFormatted}
              </div>
            </div>

            {/* Duration */}
            <div className="bg-gradient-to-br from-gray-50 to-gray-100 dark:from-gray-800/50 dark:to-gray-700/50 border border-gray-200 dark:border-gray-600 rounded-xl p-4 group hover:shadow-md transition-all duration-200">
              <div className="flex items-center space-x-3 mb-2">
                <div className="p-2 bg-gray-200 dark:bg-gray-700 rounded-lg">
                  <IoTimeOutline className="text-gray-800 dark:text-gray-300" size={18} />
                </div>
                <div className="text-md font-mono font-semibold text-gray-700 dark:text-gray-300">
                  Duration
                </div>
              </div>
              <div className="text-sm font-mono font-medium text-gray-700 dark:text-gray-100 leading-relaxed">
                {duration}
              </div>
            </div>

            {/* End Time */}
            <div className="bg-gradient-to-br from-gray-50 to-gray-100 dark:from-gray-800/50 dark:to-gray-700/50 border border-gray-200 dark:border-gray-600 rounded-xl p-4 group hover:shadow-md transition-all duration-200">
              <div className="flex items-center space-x-3 mb-2">
                <div className="p-2 bg-gray-200 dark:bg-gray-700 rounded-lg">
                  <IoStopOutline className="text-gray-800 dark:text-gray-300" size={18} />
                </div>
                <div className="text-md font-mono font-semibold text-gray-700 dark:text-gray-300">
                  End Time
                </div>
              </div>
              <div className="text-sm font-mono font-medium text-gray-700 dark:text-gray-100 leading-relaxed">
                {endFormatted}
              </div>
            </div>
          </div>

          {/* Last Updated */}
          <div className="text-center">
            <div className="inline-flex items-center space-x-2 px-3 py-1.5 bg-gray-100 dark:bg-gray-800 rounded-full text-xs text-gray-700 dark:text-gray-300">
              <IoTimeOutline size={12} />
              <span>Last updated {timeAgo}</span>
            </div>
          </div>
        </div>
      );
    }

    // Handle multiple traces case
    if (traceStartTimes.length > 0 && traceEndTimes.length > 0) {
      const earliestStart = new Date(Math.min(...traceStartTimes.map(t => t.getTime())));
      const latestEnd = new Date(Math.max(...traceEndTimes.map(t => t.getTime())));

      const startFormatted = format(earliestStart, 'MMM d, yyyy hh:mm:ss a');
      const endFormatted = format(latestEnd, 'MMM d, yyyy hh:mm:ss a');
      const timeAgo = formatDistanceToNow(latestEnd, { addSuffix: true });
      const duration = formatDistanceToNow(earliestStart, { addSuffix: false });

      return (
        <div className="space-y-4">
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            {/* Earliest Start */}
            <div className="bg-gradient-to-br from-gray-50 to-gray-100 dark:from-gray-800/50 dark:to-gray-700/50 border border-gray-200 dark:border-gray-600 rounded-xl p-4 group hover:shadow-md transition-all duration-200">
              <div className="flex items-center space-x-3 mb-2">
                <div className="p-2 bg-gray-100 dark:bg-gray-700 rounded-lg">
                  <IoPlayOutline className="text-gray-700 dark:text-gray-300" size={18} />
                </div>
                <div className="text-md font-mono font-semibold text-gray-700 dark:text-gray-300">
                  Earliest Start
                </div>
              </div>
              <div className="text-base font-mono font-medium text-gray-900 dark:text-gray-100 leading-relaxed">
                {startFormatted}
              </div>
            </div>

            {/* Total Duration */}
            <div className="bg-gradient-to-br from-gray-50 to-gray-100 dark:from-gray-800/50 dark:to-gray-700/50 border border-gray-200 dark:border-gray-600 rounded-xl p-4 group hover:shadow-md transition-all duration-200">
              <div className="flex items-center space-x-3 mb-2">
                <div className="p-2 bg-gray-100 dark:bg-gray-700 rounded-lg">
                  <IoTimeOutline className="text-gray-700 dark:text-gray-300" size={18} />
                </div>
                <div className="text-md font-mono font-semibold text-gray-700 dark:text-gray-300">
                  Total Duration
                </div>
              </div>
              <div className="text-base font-mono font-medium text-gray-900 dark:text-gray-100 leading-relaxed">
                {duration}
              </div>
            </div>

            {/* Latest End */}
            <div className="bg-gradient-to-br from-gray-50 to-gray-100 dark:from-gray-800/50 dark:to-gray-700/50 border border-gray-200 dark:border-gray-600 rounded-xl p-4 group hover:shadow-md transition-all duration-200">
              <div className="flex items-center space-x-3 mb-2">
                <div className="p-2 bg-gray-100 dark:bg-gray-700 rounded-lg">
                  <IoStopOutline className="text-gray-700 dark:text-gray-300" size={18} />
                </div>
                <div className="text-md font-mono font-semibold text-gray-700 dark:text-gray-300">
                  Latest End
                </div>
              </div>
              <div className="text-base font-mono font-medium text-gray-900 dark:text-gray-100 leading-relaxed">
                {endFormatted}
              </div>
            </div>
          </div>

          {/* Stats and Last Updated */}
                     <div className="flex flex-col sm:flex-row items-center justify-center space-y-2 sm:space-y-0 sm:space-x-4">
             <div className="inline-flex items-center space-x-2 px-3 py-1.5 bg-gray-200 dark:bg-gray-700 rounded-full text-xs text-gray-700 dark:text-gray-300">
               <IoStatsChartOutline size={12} />
               <span>{traceIDs.length} traces</span>
             </div>
            <div className="inline-flex items-center space-x-2 px-3 py-1.5 bg-gray-100 dark:bg-gray-800 rounded-full text-xs text-gray-700 dark:text-gray-300">
              <IoTimeOutline size={12} />
              <span>Last updated {timeAgo}</span>
            </div>
          </div>
        </div>
      );
    }

    return (
      <div className="text-center py-8">
        <div className="inline-flex items-center justify-center space-x-2 px-4 py-2 bg-gray-100 dark:bg-gray-800 rounded-full text-sm text-gray-700 dark:text-gray-300">
          <IoTimeOutline size={16} />
          <span>No time range data available</span>
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-6 w-full p-4">
      {/* Query Time Range Card */}
      <div className="bg-white dark:bg-gray-800 rounded-2xl border border-gray-200 dark:border-gray-700 shadow-sm hover:shadow-md transition-all duration-200 overflow-hidden">
        {/* Header */}
          <div className="bg-gradient-to-r from-gray-50 to-gray-100 dark:from-gray-800/50 dark:to-gray-700/50 border-b border-gray-200 dark:border-gray-700 px-6 py-2">
           <div className="flex items-center justify-center space-x-3">
             <div className="p-2 bg-gray-200 dark:bg-gray-700 rounded-lg">
               <IoTimeOutline className="text-gray-800 dark:text-gray-300" size={22} />
             </div>
             <h2 className="text-lg font-mono font-semibold tracking-wide text-gray-800 dark:text-gray-100">
               Query Time Range
             </h2>
           </div>
         </div>

        {/* Content */}
        <div className="p-6">
          {formatTimeRange()}
        </div>
      </div>

      {/* Instructions Card */}
      <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700/50 rounded-xl p-4">
        <div className="flex items-center justify-center space-x-3 text-amber-700 dark:text-amber-300">
          <IoWarningOutline size={20} />
          <p className="text-sm font-medium">
            Select a log from the list to view its details
          </p>
        </div>
      </div>
    </div>
  );
}
