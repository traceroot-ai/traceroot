import React from "react";
import { FaRobot } from "react-icons/fa";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";

interface TokenUsageInfo {
  limit: number;
  usage: number;
  remaining: number;
  percentage: number;
}

interface TokenUsageCardProps {
  tokenInfo: TokenUsageInfo;
  formatNumber: (num: number) => string;
  getUsageColor: (percentage: number) => string;
}

export function TokenUsageCard({
  tokenInfo,
  formatNumber,
  getUsageColor,
}: TokenUsageCardProps) {
  if (tokenInfo.limit === 0 && tokenInfo.remaining === 0) {
    return (
      <Card>
        <CardHeader>
          <div className="flex items-center space-x-2.5">
            <FaRobot className="text-foreground" size={20} />
            <CardTitle className="font-semibold text-sm">
              LLM TOKEN USAGE
            </CardTitle>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="text-center py-4">
            <div className="text-sm text-muted-foreground">
              No LLM token quota configured
            </div>
            <div className="text-xs text-muted-foreground mt-1">
              Contact support to set up LLM token tracking
            </div>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center space-x-2.5">
          <FaRobot className="text-foreground" size={20} />
          <CardTitle className="font-semibold text-sm">
            LLM TOKEN USAGE
          </CardTitle>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-3">
          {tokenInfo.limit > 0 && (
            <div>
              <div className="flex justify-between items-center mb-2">
                <span className="text-xs text-muted-foreground uppercase tracking-wide">
                  This Month
                </span>
                <span
                  className={`text-xs font-medium ${getUsageColor(tokenInfo.percentage)}`}
                >
                  {tokenInfo.percentage.toFixed(1)}% used
                </span>
              </div>
              <div className="w-full bg-muted rounded-full h-2">
                <div
                  className={`h-2 rounded-full transition-all duration-300 ${
                    tokenInfo.percentage >= 90
                      ? "bg-destructive"
                      : tokenInfo.percentage >= 75
                        ? "bg-yellow-500 dark:bg-yellow-600"
                        : "bg-green-500 dark:bg-green-600"
                  }`}
                  style={{
                    width: `${Math.min(100, tokenInfo.percentage)}%`,
                  }}
                ></div>
              </div>
            </div>
          )}
          <div className="text-center">
            <div className="text-sm font-medium">
              {formatNumber(tokenInfo.usage)} / {formatNumber(tokenInfo.limit)}
            </div>
          </div>
          {tokenInfo.percentage >= 80 && (
            <div
              className={`text-xs p-2 rounded border ${
                tokenInfo.percentage >= 90
                  ? "bg-destructive/10 text-destructive border-destructive/20 dark:bg-destructive/5 dark:text-destructive dark:border-destructive/10"
                  : "bg-yellow-50 text-yellow-700 border-yellow-200 dark:bg-yellow-500/10 dark:text-yellow-300 dark:border-yellow-500/20"
              }`}
            >
              {tokenInfo.percentage >= 90
                ? "⚠️ You're running low on LLM tokens. Consider upgrading your plan."
                : "💡 You've used most of your LLM tokens this month."}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

// Local version for mock data
interface LocalTokenUsageCardProps {
  tokenUsage: TokenUsageInfo;
  formatNumber: (num: number) => string;
  getUsageColor: (percentage: number) => string;
}

export function LocalTokenUsageCard({
  tokenUsage,
  formatNumber,
  getUsageColor,
}: LocalTokenUsageCardProps) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center space-x-2.5">
          <FaRobot className="text-foreground" size={20} />
          <CardTitle className="text-base font-semibold">
            LLM TOKEN USAGE
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
                className={`text-xs font-medium ${getUsageColor(tokenUsage.percentage)}`}
              >
                {tokenUsage.percentage.toFixed(1)}% used
              </span>
            </div>
            <div className="w-full bg-gray-200 rounded-full h-2">
              <div
                className={`h-2 rounded-full transition-all duration-300 ${
                  tokenUsage.percentage >= 90
                    ? "bg-red-500"
                    : tokenUsage.percentage >= 75
                      ? "bg-yellow-500"
                      : "bg-green-500"
                }`}
                style={{
                  width: `${Math.min(100, tokenUsage.percentage)}%`,
                }}
              />
            </div>
          </div>
          <div className="text-center">
            <div className="text-sm font-medium">
              {formatNumber(tokenUsage.usage)} /{" "}
              {formatNumber(tokenUsage.limit)}
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
