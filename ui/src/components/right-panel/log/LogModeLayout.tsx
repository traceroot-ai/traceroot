"use client";

import React, { useState, useEffect } from "react";
import LogModeTopBar from "./LogModeTopBar";
import LogModeDetail from "./LogModeDetail";
import { Spinner } from "@/components/ui/shadcn-io/spinner";

interface LogModeLayoutProps {
  traceQueryStartTime?: Date;
  traceQueryEndTime?: Date;
  logSearchValue?: string;
  metadataSearchTerms?: { category: string; value: string }[];
}

export default function LogModeLayout({
  traceQueryStartTime: initialTraceQueryStartTime,
  traceQueryEndTime: initialTraceQueryEndTime,
  logSearchValue: externalLogSearchValue = "",
  metadataSearchTerms = [],
}: LogModeLayoutProps) {
  const [traceQueryStartTime, setTraceQueryStartTime] = useState<
    Date | undefined
  >(initialTraceQueryStartTime);
  const [traceQueryEndTime, setTraceQueryEndTime] = useState<Date | undefined>(
    initialTraceQueryEndTime,
  );
  const [logSearchValue, setLogSearchValue] = useState<string>(
    externalLogSearchValue,
  );
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    // Initialize with default time range if not provided
    if (!traceQueryStartTime || !traceQueryEndTime) {
      const endTime = new Date();
      const startTime = new Date(endTime);
      startTime.setMinutes(endTime.getMinutes() - 60);
      setTraceQueryStartTime(startTime);
      setTraceQueryEndTime(endTime);
    }
  }, [traceQueryStartTime, traceQueryEndTime]);

  const handleTimeRangeChange = (startTime: Date, endTime: Date) => {
    setTraceQueryStartTime(startTime);
    setTraceQueryEndTime(endTime);
  };

  const handleRefresh = () => {
    // Increment refresh key to trigger re-fetch in LogModeDetail
    setRefreshKey((prev) => prev + 1);
  };

  const handleLogSearchValueChange = (value: string) => {
    setLogSearchValue(value);
  };

  return (
    <div className="h-screen flex flex-col dark:bg-zinc-950">
      <LogModeTopBar
        onTimeRangeChange={handleTimeRangeChange}
        onRefresh={handleRefresh}
        onLogSearchValueChange={handleLogSearchValueChange}
      />

      <LogModeDetail
        startTime={traceQueryStartTime}
        endTime={traceQueryEndTime}
        logSearchValue={logSearchValue}
        refreshKey={refreshKey}
      />
    </div>
  );
}
