/**
 * Hook for managing date filter state.
 * Single responsibility: date range selection with page reset callback.
 */
import { useState, useCallback, useMemo } from "react";
import { DEFAULT_DATE_FILTER, toTimestampBounds, type DateFilterOption } from "@/lib/date-filter";

interface UseDateFilterReturn {
  dateFilter: DateFilterOption;
  customStartDate: Date | null;
  customEndDate: Date | null;
  setDateFilter: (option: DateFilterOption) => void;
  setCustomStartDate: (date: Date) => void;
  setCustomEndDate: (date: Date) => void;
  setCustomRange: (start: Date, end: Date) => void;
  timestamps: {
    startAfter?: string;
    endBefore?: string;
  };
}

export function useDateFilter(onFilterChange?: () => void): UseDateFilterReturn {
  const [dateFilter, setDateFilterState] = useState<DateFilterOption>(DEFAULT_DATE_FILTER);
  const [customStartDate, setCustomStartDateState] = useState<Date | null>(null);
  const [customEndDate, setCustomEndDateState] = useState<Date | null>(null);
  // Version counter to force timestamp recalculation when filter changes
  const [filterVersion, setFilterVersion] = useState(0);

  const setDateFilter = useCallback(
    (option: DateFilterOption) => {
      setDateFilterState(option);
      setFilterVersion((v) => v + 1); // Force timestamp recalculation
      onFilterChange?.();
    },
    [onFilterChange],
  );

  const setCustomStartDate = useCallback(
    (date: Date) => {
      setCustomStartDateState(date);
      onFilterChange?.();
    },
    [onFilterChange],
  );

  const setCustomEndDate = useCallback(
    (date: Date) => {
      setCustomEndDateState(date);
      onFilterChange?.();
    },
    [onFilterChange],
  );

  const setCustomRange = useCallback(
    (start: Date, end: Date) => {
      setCustomStartDateState(start);
      setCustomEndDateState(end);
      onFilterChange?.();
    },
    [onFilterChange],
  );

  // Calculate timestamps - include version counter to force recalculation on filter change
  const timestamps = useMemo(() => {
    // toTimestampBounds calculates "now" internally for preset filters
    return toTimestampBounds(
      dateFilter.id,
      customStartDate ?? undefined,
      customEndDate ?? undefined,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dateFilter.id, customStartDate, customEndDate, filterVersion]);

  return {
    dateFilter,
    customStartDate,
    customEndDate,
    setDateFilter,
    setCustomStartDate,
    setCustomEndDate,
    setCustomRange,
    timestamps,
  };
}
