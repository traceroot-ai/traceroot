"use client";

import React from "react";
import SearchBar, { SearchCriterion } from "./SearchBar";
import RefreshButton from "./RefreshButton";
import TimeButton, { TimeRange } from "./TimeButton";
import { CustomTimeRange, TimezoneMode } from "./CustomTimeRangeDialog";
import ModeToggle, { ViewType } from "../right-panel/ModeToggle";

interface ExploreHeaderProps {
  // Search props
  onSearch: (criteria: SearchCriterion[]) => void;
  onClearSearch: () => void;
  onLogSearchValueChange?: (value: string) => void;
  onMetadataSearchTermsChange?: (
    terms: { category: string; value: string }[],
  ) => void;
  searchDisabled?: boolean;

  // Time range props
  selectedTimeRange: TimeRange;
  onTimeRangeSelect: (range: TimeRange) => void;
  onCustomTimeRangeSelect: (
    customRange: CustomTimeRange,
    timezone: TimezoneMode,
  ) => void;
  currentTimezone: TimezoneMode;
  timeDisabled?: boolean;

  // Refresh props
  onRefresh: () => void;
  refreshDisabled?: boolean;

  // Mode toggle props
  viewType: ViewType;
  onViewTypeChange: (type: ViewType) => void;

  // Agent panel props
  agentOpen?: boolean;
  onAgentToggle?: () => void;
}

export default function ExploreHeader({
  onSearch,
  onClearSearch,
  onLogSearchValueChange,
  onMetadataSearchTermsChange,
  searchDisabled = false,
  selectedTimeRange,
  onTimeRangeSelect,
  onCustomTimeRangeSelect,
  currentTimezone,
  timeDisabled = false,
  onRefresh,
  refreshDisabled = false,
  viewType,
  onViewTypeChange,
  agentOpen,
  onAgentToggle,
}: ExploreHeaderProps) {
  return (
    <div className="sticky top-0 z-10 bg-white dark:bg-zinc-950 pt-1 pl-6 pr-2 pb-1 border-b border-zinc-200 dark:border-zinc-700">
      <div className="flex flex-row justify-between items-center gap-2">
        <div className="flex-1 min-w-0">
          <SearchBar
            onSearch={onSearch}
            onClear={onClearSearch}
            onLogSearchValueChange={onLogSearchValueChange}
            onMetadataSearchTermsChange={onMetadataSearchTermsChange}
            disabled={searchDisabled}
          />
        </div>
        <div className="flex items-center space-x-2 flex-shrink-0 justify-end">
          <RefreshButton onRefresh={onRefresh} disabled={refreshDisabled} />
          <TimeButton
            selectedTimeRange={selectedTimeRange}
            onTimeRangeSelect={onTimeRangeSelect}
            onCustomTimeRangeSelect={onCustomTimeRangeSelect}
            currentTimezone={currentTimezone}
            disabled={timeDisabled}
          />
          <ModeToggle
            viewType={viewType}
            onViewTypeChange={onViewTypeChange}
            agentOpen={agentOpen}
            onAgentToggle={onAgentToggle}
          />
        </div>
      </div>
    </div>
  );
}
