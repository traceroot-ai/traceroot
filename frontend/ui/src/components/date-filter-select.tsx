"use client";

import { useState } from "react";
import { Calendar, ChevronDown, Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { DateRangePicker } from "@/components/ui/date-time-picker";
import { cn } from "@/lib/utils";
import {
  DATE_FILTER_OPTIONS,
  formatDateRange,
  isOptionLocked,
  type DateFilterOption,
} from "@/lib/date-filter";

// The one date-filter control: preset list + custom range picker in a popover.
// Extracted from SearchFilterBar so every windowed surface (trace list,
// dashboards) offers the identical presets and custom-range behavior.
export function DateFilterSelect({
  dateFilter,
  customStartDate,
  customEndDate,
  onDateFilterChange,
  onCustomRangeChange,
  retentionDays,
  onUpgradeClick,
  className,
}: {
  dateFilter: DateFilterOption;
  customStartDate: Date | null;
  customEndDate: Date | null;
  onDateFilterChange: (option: DateFilterOption) => void;
  onCustomRangeChange: (startDate: Date, endDate: Date) => void;
  retentionDays?: number | null;
  onUpgradeClick?: () => void;
  className?: string;
}) {
  const [dateFilterOpen, setDateFilterOpen] = useState(false);
  const [showCustomPicker, setShowCustomPicker] = useState(false);

  const getDateFilterLabel = () => {
    if (dateFilter.isCustom && customStartDate && customEndDate) {
      return formatDateRange(customStartDate, customEndDate);
    }
    return dateFilter.label;
  };

  const handleCustomDateApply = (startDate: Date | null, endDate: Date | null) => {
    if (startDate && endDate) {
      const customOption = DATE_FILTER_OPTIONS.find((o) => o.isCustom)!;
      onDateFilterChange(customOption);
      onCustomRangeChange(startDate, endDate);
    }
    setDateFilterOpen(false);
    setShowCustomPicker(false);
  };

  return (
    <Popover
      open={dateFilterOpen}
      onOpenChange={(open) => {
        setDateFilterOpen(open);
        if (!open) setShowCustomPicker(false);
      }}
    >
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className={cn(
            "h-8 min-w-[140px] justify-between gap-2 text-[13px] font-normal",
            className,
          )}
        >
          <span>{getDateFilterLabel()}</span>
          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className={cn("p-0", showCustomPicker ? "w-auto" : "w-auto min-w-[130px]")}
      >
        {!showCustomPicker ? (
          <TooltipProvider delayDuration={150}>
            <div className="py-1">
              {DATE_FILTER_OPTIONS.map((option) => {
                const locked = isOptionLocked(option, retentionDays);
                const row = (
                  <button
                    key={option.id}
                    className={cn(
                      "flex w-full items-center gap-1.5 px-2.5 py-1 text-left text-[13px] transition-colors",
                      locked
                        ? "text-muted-foreground hover:bg-muted/50"
                        : dateFilter.id === option.id && !option.isCustom
                          ? "bg-muted/70"
                          : "hover:bg-muted/50",
                    )}
                    onClick={() => {
                      if (locked) {
                        // A locked preset is beyond the plan's retention window.
                        // Rather than a lengthy inline notice, clicking routes
                        // straight to the upgrade flow.
                        setDateFilterOpen(false);
                        onUpgradeClick?.();
                        return;
                      }
                      if (option.isCustom) {
                        setShowCustomPicker(true);
                      } else {
                        onDateFilterChange(option);
                        setDateFilterOpen(false);
                      }
                    }}
                  >
                    {option.isCustom && !locked && (
                      <Calendar className="h-3 w-3 text-muted-foreground" />
                    )}
                    <span className="flex-1">{option.label}</span>
                    {locked && <Lock className="h-3 w-3 text-muted-foreground" />}
                  </button>
                );

                if (!locked) return row;

                // Explain the lock on hover (short) and let the click upgrade —
                // keeps the list thin instead of a footer paragraph.
                return (
                  <Tooltip key={option.id}>
                    <TooltipTrigger asChild>{row}</TooltipTrigger>
                    <TooltipContent side="left" sideOffset={8}>
                      {retentionDays}-day retention limit · click to upgrade
                    </TooltipContent>
                  </Tooltip>
                );
              })}
            </div>
          </TooltipProvider>
        ) : (
          <DateRangePicker
            startDate={customStartDate}
            endDate={customEndDate}
            onApply={handleCustomDateApply}
            minDate={
              retentionDays != null ? new Date(Date.now() - retentionDays * 86_400_000) : undefined
            }
          />
        )}
      </PopoverContent>
    </Popover>
  );
}
