"use client";

import React from "react";
import LogOverview from "./LogOverview";
import LogDetail from "./LogDetail";
import { Span, Trace as TraceModel } from "@/models/trace";
import { ViewType } from "../ModeToggle";

interface LogPanelSwitchProps {
  traceIds?: string[];
  spanIds?: string[];
  traceQueryStartTime?: Date;
  traceQueryEndTime?: Date;
  segments?: Span[];
  allTraces?: TraceModel[];
  traceDurations?: number[];
  traceStartTimes?: Date[];
  traceEndTimes?: Date[];
  traceIDs?: string[];
  tracePercentiles?: string[];
  logSearchValue?: string;
  metadataSearchTerms?: { category: string; value: string }[];
  onTraceSelect?: (traceIds: string[]) => void;
  viewType?: ViewType;
}

export default function LogPanelSwitch({
  traceIds = [],
  spanIds = [],
  traceQueryStartTime,
  traceQueryEndTime,
  segments,
  allTraces = [],
  traceDurations = [],
  traceStartTimes = [],
  traceEndTimes = [],
  traceIDs = [],
  tracePercentiles = [],
  logSearchValue = "",
  metadataSearchTerms = [],
  onTraceSelect,
  viewType,
}: LogPanelSwitchProps) {
  return (
    <div className="h-screen flex flex-col dark:bg-zinc-950">
      {traceIds.length > 0 ? (
        <LogDetail
          traceIds={traceIds}
          spanIds={spanIds}
          traceQueryStartTime={traceQueryStartTime}
          traceQueryEndTime={traceQueryEndTime}
          segments={segments}
          allTraces={allTraces}
          logSearchValue={logSearchValue}
          metadataSearchTerms={metadataSearchTerms}
          viewType={viewType}
        />
      ) : (
        <LogOverview
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
