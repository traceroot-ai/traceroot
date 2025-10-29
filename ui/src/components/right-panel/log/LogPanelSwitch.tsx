"use client";

import React, { useRef, useEffect } from "react";
import LogOverview from "./LogOverview";
import LogDetail from "./LogDetail";
import { Span, Trace as TraceModel } from "@/models/trace";
import { ViewType } from "../ModeToggle";
import { Badge } from "@/components/ui/badge";
import { FaPython, FaJava } from "react-icons/fa";
import { SiTypescript } from "react-icons/si";
import { IoLogoJavascript, IoWarningOutline } from "react-icons/io5";
import { MdErrorOutline } from "react-icons/md";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip";

interface LogPanelSwitchProps {
  traceId?: string;
  selectedTraceIds?: string[];
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
  onTraceSelect?: (traceId: string) => void;
  viewType?: ViewType;
}

// Format date/time helper (copied from Trace.tsx)
const formatDateTime = (timestamp: number) => {
  const date = new Date(timestamp * 1000);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = String(date.getSeconds()).padStart(2, "0");
  return `${year} ${month === "01" ? "Jan" : month === "02" ? "Feb" : month === "03" ? "Mar" : month === "04" ? "Apr" : month === "05" ? "May" : month === "06" ? "Jun" : month === "07" ? "Jul" : month === "08" ? "Aug" : month === "09" ? "Sep" : month === "10" ? "Oct" : month === "11" ? "Nov" : "Dec"} ${day}th ${hours}:${minutes}:${seconds}`;
};

export default function LogPanelSwitch({
  traceId,
  selectedTraceIds = [],
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
  // Create refs for each trace header to enable auto-scrolling
  const headerRefs = useRef<{ [key: string]: HTMLDivElement | null }>({});

  // Auto-scroll to active trace header when traceId changes
  useEffect(() => {
    if (traceId && selectedTraceIds.includes(traceId)) {
      // Use setTimeout to ensure the DOM has been updated after trace selection
      const timer = setTimeout(() => {
        if (headerRefs.current[traceId]) {
          headerRefs.current[traceId]?.scrollIntoView({
            behavior: "smooth",
            block: "start",
          });
        }
      }, 100);

      return () => clearTimeout(timer);
    }
  }, [traceId, selectedTraceIds]);

  return (
    <div className="h-screen flex flex-col dark:bg-zinc-950 overflow-hidden">
      {selectedTraceIds.length > 0 ? (
        <div className="h-full overflow-y-auto">
          {allTraces
            .filter((trace) => selectedTraceIds.includes(trace.id))
            .map((trace, index) => {
              const tid = trace.id;
              const traceSpans = trace.spans;

              // Only apply span filtering for the active trace
              const isActiveTrace = tid === traceId;
              const filteredSpanIds = isActiveTrace ? spanIds : [];

              return (
                <div key={tid}>
                  {/* Trace header - matching left-hand trace row exactly */}
                  <div
                    ref={(el) => {
                      headerRefs.current[tid] = el;
                    }}
                    className={`relative h-[43px] p-2 rounded border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-zinc-950 mx-4 mt-2 mb-2 ${
                      isActiveTrace
                        ? "border-l-4 border-l-zinc-600 dark:border-l-zinc-400"
                        : ""
                    }`}
                  >
                    <div className="flex justify-between items-center h-full">
                      <div className="flex items-center text-sm min-w-0 flex-1 pr-4">
                        {/* Telemetry SDK Language Icons */}
                        {trace?.telemetry_sdk_language &&
                          trace.telemetry_sdk_language.length > 0 && (
                            <div className="flex items-center flex-shrink-0">
                              {trace.telemetry_sdk_language.includes(
                                "python",
                              ) && (
                                <FaPython
                                  className="text-neutral-800 dark:text-neutral-200 mr-2"
                                  size={14}
                                />
                              )}
                              {trace.telemetry_sdk_language.includes("ts") && (
                                <SiTypescript
                                  className="text-neutral-800 dark:text-neutral-200 mr-2"
                                  size={14}
                                />
                              )}
                              {trace.telemetry_sdk_language.includes("js") && (
                                <IoLogoJavascript
                                  className="text-neutral-800 dark:text-neutral-200 mr-2"
                                  size={14}
                                />
                              )}
                              {trace.telemetry_sdk_language.includes(
                                "java",
                              ) && (
                                <FaJava
                                  className="text-neutral-800 dark:text-neutral-200 mr-2"
                                  size={14}
                                />
                              )}
                            </div>
                          )}

                        {/* Service Name Badge */}
                        {(() => {
                          const fullServiceName =
                            trace?.service_name || "Unknown Service";
                          const isLimitExceeded =
                            fullServiceName === "LimitExceeded";
                          const shouldShowTooltip =
                            fullServiceName.length > 25 || isLimitExceeded;

                          const badge = (
                            <Badge
                              variant="default"
                              className={`min-w-16 h-6 mr-2 justify-start font-mono font-normal max-w-full overflow-hidden text-ellipsis flex-shrink text-left ${
                                isLimitExceeded
                                  ? "bg-red-600 hover:bg-red-700 text-white"
                                  : ""
                              }`}
                              title={
                                shouldShowTooltip && !isLimitExceeded
                                  ? fullServiceName
                                  : undefined
                              }
                            >
                              {fullServiceName}
                            </Badge>
                          );

                          return shouldShowTooltip ? (
                            <Tooltip>
                              <TooltipTrigger asChild>{badge}</TooltipTrigger>
                              <TooltipContent>
                                <p>
                                  {isLimitExceeded
                                    ? "The trace is too large or took too long to complete."
                                    : fullServiceName}
                                </p>
                              </TooltipContent>
                            </Tooltip>
                          ) : (
                            badge
                          );
                        })()}

                        {/* Environment */}
                        <Badge
                          variant="outline"
                          className="h-6 mr-2 justify-center font-mono font-normal flex-shrink-0"
                        >
                          {trace?.service_environment || "Unknown Environment"}
                        </Badge>

                        {/* Trace ID */}
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span className="text-xs font-mono text-neutral-500 dark:text-neutral-400 mr-2 flex-shrink-0">
                              {tid.substring(0, 8)}
                            </span>
                          </TooltipTrigger>
                          <TooltipContent>
                            <p className="font-mono text-xs">{tid}</p>
                          </TooltipContent>
                        </Tooltip>
                      </div>

                      {/* Timestamp */}
                      <div className="flex items-center gap-2 flex-shrink-0">
                        <span className="text-xs text-neutral-600 dark:text-neutral-300 flex-shrink-0 whitespace-nowrap">
                          {trace?.start_time === 0
                            ? "N/A"
                            : formatDateTime(trace?.start_time || 0)}
                        </span>
                      </div>
                    </div>
                  </div>

                  <LogDetail
                    traceId={tid}
                    spanIds={filteredSpanIds}
                    traceQueryStartTime={traceQueryStartTime}
                    traceQueryEndTime={traceQueryEndTime}
                    segments={traceSpans}
                    logSearchValue={logSearchValue}
                    metadataSearchTerms={metadataSearchTerms}
                    viewType={viewType}
                  />
                </div>
              );
            })}
        </div>
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
