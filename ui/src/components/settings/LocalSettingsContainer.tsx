"use client";

import React from "react";
import { LocalCurrentPlanCard } from "./CurrentPlanCard";
import { LocalTokenUsageCard } from "./TokenUsageCard";
import { LocalTracesLogsCard } from "./TracesLogsCard";
import { LocalAccountActionsCard } from "./AccountActionsCard";

export function LocalSettingsContainer() {
  const formatNumber = (n: number) => new Intl.NumberFormat("en-US").format(n);

  // Example mock stats; adjust as desired for local dev
  const tokenUsage = {
    limit: 1_000_000,
    usage: 120_000,
    remaining: 880_000,
    percentage: 12,
  };
  const tracesUsage = {
    limit: 100_000,
    usage: 8_500,
    remaining: 91_500,
    percentage: 8.5,
  };

  const getUsageColor = (p: number) =>
    p >= 100 ? "text-red-600" : "text-green-600";

  return (
    <div className="min-h-full flex flex-col p-4">
      <div className="w-3/4 max-w-6xl mx-auto bg-white m-5 p-10 rounded-lg font-mono bg-zinc-50">
        <h2 className="scroll-m-20 mb-5 text-3xl font-semibold first:mt-0">
          Settings
        </h2>

        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5 p-3">
          <LocalCurrentPlanCard planName="Free" status="N/A" />

          <LocalTokenUsageCard
            tokenUsage={tokenUsage}
            formatNumber={formatNumber}
            getUsageColor={getUsageColor}
          />

          <LocalTracesLogsCard
            tracesUsage={tracesUsage}
            formatNumber={formatNumber}
            getUsageColor={getUsageColor}
          />

          <LocalAccountActionsCard />
        </div>
      </div>
    </div>
  );
}
