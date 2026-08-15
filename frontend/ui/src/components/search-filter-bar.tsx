"use client";

import { Search } from "lucide-react";
import { DateFilterSelect } from "@/components/date-filter-select";
import { Input } from "@/components/ui/input";
import type { DateFilterOption } from "@/lib/date-filter";

interface SearchFilterBarProps {
  // Search
  searchValue?: string;
  onSearchChange?: (value: string) => void;
  searchPlaceholder?: string;
  // Optional replacement for the default search input (e.g. a combined
  // search-and-filter input). When provided, the plain input is not rendered.
  searchInput?: React.ReactNode;
  // Date filter — omit all five when the list has no date predicate to apply
  // one to; a rendered-but-inert filter would falsely read as an applied
  // constraint. The control simply doesn't render when `dateFilter` is unset.
  dateFilter?: DateFilterOption;
  customStartDate?: Date | null;
  customEndDate?: Date | null;
  onDateFilterChange?: (option: DateFilterOption) => void;
  onCustomRangeChange?: (startDate: Date, endDate: Date) => void;
  // Retention gating — options exceeding the window show a lock icon
  retentionDays?: number | null;
  onUpgradeClick?: () => void;
  // Optional additional content (e.g., filter badges)
  children?: React.ReactNode;
}

export function SearchFilterBar({
  searchValue,
  onSearchChange,
  searchPlaceholder = "Search...",
  searchInput,
  dateFilter,
  customStartDate,
  customEndDate,
  onDateFilterChange,
  onCustomRangeChange,
  retentionDays,
  onUpgradeClick,
  children,
}: SearchFilterBarProps) {
  return (
    <div className="border-b border-border bg-background px-3 py-1.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        {searchInput ?? (
          <div className="relative min-w-[12rem] max-w-md flex-1">
            <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder={searchPlaceholder}
              value={searchValue ?? ""}
              onChange={(e) => onSearchChange?.(e.target.value)}
              className="h-8 pl-8 text-[13px]"
            />
          </div>
        )}
        {children}
        {dateFilter && onDateFilterChange && onCustomRangeChange && (
          <DateFilterSelect
            className="ml-auto"
            dateFilter={dateFilter}
            customStartDate={customStartDate ?? null}
            customEndDate={customEndDate ?? null}
            onDateFilterChange={onDateFilterChange}
            onCustomRangeChange={onCustomRangeChange}
            retentionDays={retentionDays}
            onUpgradeClick={onUpgradeClick}
          />
        )}
      </div>
    </div>
  );
}
