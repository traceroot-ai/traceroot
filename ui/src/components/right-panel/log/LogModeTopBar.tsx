"use client";

import React, { useState, useRef, useCallback } from "react";
import TimeButton, {
  TimeRange,
  TIME_RANGES,
} from "@/components/explore/TimeButton";
import {
  CustomTimeRange,
  TimezoneMode,
} from "@/components/explore/CustomTimeRangeDialog";
import RefreshButton from "@/components/explore/RefreshButton";
import SearchBar, { SearchCriterion } from "@/components/explore/SearchBar";

interface LogModeTopBarProps {
  onTimeRangeChange?: (startTime: Date, endTime: Date) => void;
  onRefresh?: () => void;
  onLogSearchValueChange?: (value: string) => void;
  disabled?: boolean;
}

export default function LogModeTopBar({
  onTimeRangeChange,
  onRefresh,
  onLogSearchValueChange,
  disabled = false,
}: LogModeTopBarProps) {
  const [selectedTimeRange, setSelectedTimeRange] = useState<TimeRange>(
    TIME_RANGES[0],
  );
  const [timezone, setTimezone] = useState<TimezoneMode>("utc");
  const [searchCriteria, setSearchCriteria] = useState<SearchCriterion[]>([]);
  const timeRangeRef = useRef<{ start: Date; end: Date } | null>(null);

  const handleTimeRangeSelect = (range: TimeRange) => {
    setSelectedTimeRange(range);
    calculateAndNotifyTimeRange(range, timezone);
  };

  const handleCustomTimeRangeSelect = (
    customRange: CustomTimeRange,
    selectedTimezone: TimezoneMode,
  ) => {
    setTimezone(selectedTimezone);

    const customTimeRange: TimeRange = {
      label: customRange.label,
      isCustom: true,
      customRange: customRange,
    };

    if (customRange.type === "relative") {
      customTimeRange.minutes = customRange.minutes;
    }

    setSelectedTimeRange(customTimeRange);
    calculateAndNotifyTimeRange(customTimeRange, selectedTimezone);
  };

  const calculateAndNotifyTimeRange = useCallback(
    (range: TimeRange, tz: TimezoneMode) => {
      let startTime: Date;
      let endTime: Date;

      const convertToUTC = (date: Date): Date => {
        if (tz === "utc") {
          return date;
        }
        return new Date(date.toISOString());
      };

      if (range.isCustom && range.customRange) {
        const customRange = range.customRange;
        if (customRange.type === "absolute") {
          startTime = customRange.startDate;
          endTime = customRange.endDate;
        } else {
          endTime = new Date();
          startTime = new Date(endTime);
          startTime.setMinutes(endTime.getMinutes() - customRange.minutes);
        }
      } else if (range.minutes) {
        endTime = new Date();
        startTime = new Date(endTime);
        startTime.setMinutes(endTime.getMinutes() - range.minutes);
      } else {
        endTime = new Date();
        startTime = new Date(endTime);
        startTime.setMinutes(endTime.getMinutes() - 60);
      }

      timeRangeRef.current = {
        start: new Date(startTime),
        end: new Date(endTime),
      };

      const utcStartTime = convertToUTC(startTime);
      const utcEndTime = convertToUTC(endTime);

      onTimeRangeChange?.(utcStartTime, utcEndTime);
    },
    [onTimeRangeChange],
  );

  const handleSearch = (criteria: SearchCriterion[]) => {
    setSearchCriteria(criteria);
    // Extract log search value from criteria
    const logCriterion = criteria.find((c) => c.category === "log");
    if (logCriterion) {
      onLogSearchValueChange?.(logCriterion.value);
    } else {
      onLogSearchValueChange?.("");
    }
  };

  const handleClearSearch = () => {
    setSearchCriteria([]);
    onLogSearchValueChange?.("");
  };

  const handleLogSearchValueChange = (value: string) => {
    onLogSearchValueChange?.(value);
  };

  const handleRefresh = () => {
    onRefresh?.();
    // Recalculate time range on refresh
    if (timeRangeRef.current) {
      calculateAndNotifyTimeRange(selectedTimeRange, timezone);
    }
  };

  return (
    <div className="bg-white dark:bg-zinc-950 p-4">
      <div className="flex flex-col lg:flex-row lg:justify-between lg:items-center gap-2">
        <div className="flex-1 min-w-0">
          <SearchBar
            onSearch={handleSearch}
            onClear={handleClearSearch}
            onLogSearchValueChange={handleLogSearchValueChange}
            disabled={disabled}
            allowedCategories={["log"]}
          />
        </div>
        <div className="flex space-x-2 flex-shrink-0 justify-end">
          <RefreshButton onRefresh={handleRefresh} disabled={disabled} />
          <TimeButton
            selectedTimeRange={selectedTimeRange}
            onTimeRangeSelect={handleTimeRangeSelect}
            onCustomTimeRangeSelect={handleCustomTimeRangeSelect}
            currentTimezone={timezone}
            disabled={disabled}
          />
        </div>
      </div>
    </div>
  );
}
