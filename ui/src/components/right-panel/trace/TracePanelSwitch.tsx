"use client";

import React from "react";
import TraceOverview from "./TraceOverview";
import TraceDetail from "./TraceDetail";
import { Span } from "@/models/trace";

interface TracePanelSwitchProps {
  traceId?: string;
  spanIds?: string[];
  traceQueryStartTime?: Date;
  traceQueryEndTime?: Date;
  segments?: Span[];
  traceDurations?: number[];
  traceStartTimes?: Date[];
  traceEndTimes?: Date[];
  traceIDs?: string[];
  tracePercentiles?: string[];
  onTraceSelect?: (traceId: string) => void;
}

export default function TracePanelSwitch({
  traceId,
  spanIds = [],
  traceQueryStartTime,
  traceQueryEndTime,
  segments = [],
  traceDurations = [],
  traceStartTimes = [],
  traceEndTimes = [],
  traceIDs = [],
  tracePercentiles = [],
  onTraceSelect,
}: TracePanelSwitchProps) {
  // Find the percentile for the selected trace
  const getTracePercentile = (
    selectedTraceId: string | undefined,
  ): string | undefined => {
    if (
      !selectedTraceId ||
      traceIDs.length === 0 ||
      tracePercentiles.length === 0
    ) {
      return undefined;
    }
    const traceIndex = traceIDs.findIndex((id) => id === selectedTraceId);
    return traceIndex !== -1 ? tracePercentiles[traceIndex] : undefined;
  };

  return (
    <div className="h-screen flex flex-col">
      {traceId ? (
        <TraceDetail
          traceId={traceId}
          spanIds={spanIds}
          spans={segments}
          percentile={getTracePercentile(traceId)}
        />
      ) : (
        <TraceOverview
          traceQueryStartTime={traceQueryStartTime}
          traceQueryEndTime={traceQueryEndTime}
          traceDurations={traceDurations}
          traceStartTimes={traceStartTimes}
          traceEndTimes={traceEndTimes}
          traceIDs={traceIDs}
          tracePercentiles={tracePercentiles}
          onTraceSelect={onTraceSelect}
        />
      )}
    </div>
  );
}
