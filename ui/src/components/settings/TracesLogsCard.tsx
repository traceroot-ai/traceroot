import React from "react";
import { FaChartLine } from "react-icons/fa";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";

interface TracesLogsInfo {
  limit: number;
  usage: number;
  remaining: number;
  percentage: number;
  isLoading?: boolean;
}

interface TracesLogsCardProps {
  tracesLogsInfo: TracesLogsInfo | null;
  formatNumber: (num: number) => string;
  getUsageColor: (percentage: number) => string;
}

export function TracesLogsCard({
  tracesLogsInfo,
  formatNumber,
  getUsageColor,
}: TracesLogsCardProps) {
  const renderContent = () => {
    if (tracesLogsInfo === null) {
      return (
        <div className="text-center py-4">
          <div className="text-sm text-muted-foreground">
            No traces & logs quota configured
          </div>
          <div className="text-xs text-muted-foreground mt-1">
            Contact support to set up traces & logs tracking
          </div>
        </div>
      );
    }

    if (tracesLogsInfo.isLoading) {
      return (
        <div className="text-center py-4">
          <div className="text-sm text-muted-foreground">
            Loading traces & logs usage...
          </div>
        </div>
      );
    }

    if (tracesLogsInfo.limit === 0 && tracesLogsInfo.remaining === 0) {
      return (
        <div className="text-center py-4">
          <div className="text-sm text-muted-foreground">
            No traces & logs quota configured
          </div>
          <div className="text-xs text-muted-foreground mt-1">
            Contact support to set up traces & logs tracking
          </div>
        </div>
      );
    }

    return (
      <div className="space-y-3">
        {tracesLogsInfo.limit > 0 && (
          <div>
            <div className="flex justify-between items-center mb-2">
              <span className="text-xs text-muted-foreground uppercase tracking-wide">
                This Month
              </span>
              <span
                className={`text-xs font-medium ${getUsageColor(tracesLogsInfo.percentage)}`}
              >
                {tracesLogsInfo.percentage.toFixed(1)}% used
              </span>
            </div>
            <div className="w-full bg-muted rounded-full h-2">
              <div
                className={`h-2 rounded-full transition-all duration-300 ${
                  tracesLogsInfo.percentage >= 90
                    ? "bg-destructive"
                    : tracesLogsInfo.percentage >= 75
                      ? "bg-yellow-500 dark:bg-yellow-600"
                      : "bg-green-500 dark:bg-green-600"
                }`}
                style={{
                  width: `${Math.min(100, tracesLogsInfo.percentage)}%`,
                }}
              ></div>
            </div>
          </div>
        )}
        <div className="text-center">
          <div className="text-sm font-medium">
            {formatNumber(tracesLogsInfo.usage)} /{" "}
            {formatNumber(tracesLogsInfo.limit)}
          </div>
        </div>
        {tracesLogsInfo.percentage >= 80 && (
          <div
            className={`text-xs p-2 rounded border ${
              tracesLogsInfo.percentage >= 90
                ? "bg-destructive/10 text-destructive border-destructive/20 dark:bg-destructive/5 dark:text-destructive dark:border-destructive/10"
                : "bg-yellow-50 text-yellow-700 border-yellow-200 dark:bg-yellow-500/10 dark:text-yellow-300 dark:border-yellow-500/20"
            }`}
          >
            {tracesLogsInfo.percentage >= 90
              ? "⚠️ You're running low on traces & logs quota. Consider upgrading your plan."
              : "💡 You've used most of your traces & logs quota this month."}
          </div>
        )}
      </div>
    );
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center space-x-2.5">
          <FaChartLine className="text-foreground" size={20} />
          <CardTitle className="font-semibold text-sm">
            TRACES & LOGS USAGE
          </CardTitle>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">{renderContent()}</CardContent>
    </Card>
  );
}

// Local version for mock data
interface LocalTracesLogsCardProps {
  tracesUsage: TracesLogsInfo;
  formatNumber: (num: number) => string;
  getUsageColor: (percentage: number) => string;
}

export function LocalTracesLogsCard({
  tracesUsage,
  formatNumber,
  getUsageColor,
}: LocalTracesLogsCardProps) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center space-x-2.5">
          <FaChartLine className="text-foreground" size={20} />
          <CardTitle className="text-base font-semibold">
            TRACES & LOGS USAGE
          </CardTitle>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-3">
          <div>
            <div className="flex justify-between items-center mb-2">
              <span className="text-xs text-muted-foreground uppercase tracking-wide">
                This Month
              </span>
              <span
                className={`text-xs font-medium ${getUsageColor(tracesUsage.percentage)}`}
              >
                {tracesUsage.percentage.toFixed(1)}% used
              </span>
            </div>
            <div className="w-full bg-gray-200 rounded-full h-2">
              <div
                className={`h-2 rounded-full transition-all duration-300 ${
                  tracesUsage.percentage >= 90
                    ? "bg-red-500"
                    : tracesUsage.percentage >= 75
                      ? "bg-yellow-500"
                      : "bg-green-500"
                }`}
                style={{
                  width: `${Math.min(100, tracesUsage.percentage)}%`,
                }}
              />
            </div>
          </div>
          <div className="text-center">
            <div className="text-sm font-medium">
              {formatNumber(tracesUsage.usage)} /{" "}
              {formatNumber(tracesUsage.limit)}
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
