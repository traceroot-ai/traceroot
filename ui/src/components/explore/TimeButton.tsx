import React, { useState } from "react";
import { ChevronDownIcon, CalendarDays } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  CustomTimeRangeDialog,
  CustomTimeRange,
  TimezoneMode,
} from "./CustomTimeRangeDialog";

export type TimeRange = {
  label: string;
  minutes?: number;
  isCustom?: boolean;
  customRange?: CustomTimeRange;
};

export const TIME_RANGES: TimeRange[] = [
  { label: "Last 1 Minute", minutes: 1 },
  { label: "Last 10 Minutes", minutes: 10 },
  { label: "Last 30 Minutes", minutes: 30 },
  { label: "Last 1 Hour", minutes: 60 },
  { label: "Last 3 Hours", minutes: 3 * 60 },
  { label: "Last 6 Hours", minutes: 6 * 60 },
  { label: "Last 12 Hours", minutes: 12 * 60 },
  { label: "Last 1 Day", minutes: 24 * 60 },
  { label: "Last 3 Days", minutes: 3 * 24 * 60 },
  { label: "Last 7 Days", minutes: 7 * 24 * 60 },
  { label: "Last 14 Days", minutes: 14 * 24 * 60 },
  { label: "Last 30 Days", minutes: 30 * 24 * 60 },
];

interface TimeButtonProps {
  selectedTimeRange: TimeRange;
  onTimeRangeSelect: (range: TimeRange) => void;
  onCustomTimeRangeSelect?: (
    range: CustomTimeRange,
    timezone: TimezoneMode,
  ) => void;
  currentTimezone?: TimezoneMode;
  disabled?: boolean;
}

export const TimeButton: React.FC<TimeButtonProps> = ({
  selectedTimeRange,
  onTimeRangeSelect,
  onCustomTimeRangeSelect,
  currentTimezone = "utc",
  disabled = false,
}) => {
  const [customDialogOpen, setCustomDialogOpen] = useState(false);
  const [dropdownOpen, setDropdownOpen] = useState(false);

  const handleTimeRangeSelect = (value: string) => {
    if (disabled) return;
    if (value === "custom") {
      setDropdownOpen(false);
      setCustomDialogOpen(true);
      return;
    }
    const range = TIME_RANGES.find((r) => r.label === value);
    if (range && range.label !== selectedTimeRange.label) {
      onTimeRangeSelect(range);
    }
  };

  const handleCustomApply = (
    customRange: CustomTimeRange,
    timezone: TimezoneMode,
  ) => {
    if (onCustomTimeRangeSelect) {
      onCustomTimeRangeSelect(customRange, timezone);
    }
  };

  return (
    <>
      <DropdownMenu open={dropdownOpen} onOpenChange={setDropdownOpen}>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            className="min-h-[2.5rem] text-xs font-medium"
            disabled={disabled}
          >
            <span className="hidden lg:inline">{selectedTimeRange.label}</span>
            <span className="hidden md:inline lg:hidden">
              {selectedTimeRange.label.replace("Last ", "")}
            </span>
            <span className="md:hidden">
              {selectedTimeRange.label
                .replace("Last ", "")
                .replace(" minutes", "m")
                .replace(" hours", "h")
                .replace(" days", "d")}
            </span>
            <ChevronDownIcon className="ml-2 size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-48">
          <DropdownMenuRadioGroup
            value={selectedTimeRange.label}
            onValueChange={handleTimeRangeSelect}
          >
            {TIME_RANGES.map((range) => (
              <DropdownMenuRadioItem
                key={range.label}
                value={range.label}
                className="text-xs"
              >
                {range.label}
              </DropdownMenuRadioItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuRadioItem value="custom" className="text-xs">
              <CalendarDays className="mr-2 size-4" />
              Custom
            </DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>

      <CustomTimeRangeDialog
        open={customDialogOpen}
        onOpenChange={setCustomDialogOpen}
        onApply={handleCustomApply}
        currentTimezone={currentTimezone}
      />
    </>
  );
};

export default TimeButton;
