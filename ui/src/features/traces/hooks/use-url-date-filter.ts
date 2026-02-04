/**
 * Hook for managing date filter state synchronized with URL parameters.
 * This allows date filter state to persist across page navigation.
 */
import { useState, useCallback, useMemo, useEffect } from 'react';
import { useSearchParams, useRouter, usePathname } from 'next/navigation';
import {
  DEFAULT_DATE_FILTER,
  DATE_FILTER_OPTIONS,
  toTimestampBounds,
  findDateFilterOption,
  type DateFilterOption,
} from '@/lib/date-filter';

interface UseUrlDateFilterReturn {
  dateFilter: DateFilterOption;
  customStartDate: Date | null;
  customEndDate: Date | null;
  setDateFilter: (option: DateFilterOption) => void;
  setCustomRange: (start: Date, end: Date) => void;
  timestamps: {
    startAfter?: string;
    endBefore?: string;
  };
}

export function useUrlDateFilter(onFilterChange?: () => void): UseUrlDateFilterReturn {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  // Read initial state from URL
  const urlDateFilterId = searchParams.get('date_filter');
  const urlStartDate = searchParams.get('start');
  const urlEndDate = searchParams.get('end');

  // Parse URL values into state
  const initialDateFilter = urlDateFilterId ? findDateFilterOption(urlDateFilterId) : DEFAULT_DATE_FILTER;
  const initialCustomStart = urlStartDate ? new Date(urlStartDate) : null;
  const initialCustomEnd = urlEndDate ? new Date(urlEndDate) : null;

  const [dateFilter, setDateFilterState] = useState<DateFilterOption>(initialDateFilter);
  const [customStartDate, setCustomStartDateState] = useState<Date | null>(initialCustomStart);
  const [customEndDate, setCustomEndDateState] = useState<Date | null>(initialCustomEnd);
  const [filterVersion, setFilterVersion] = useState(0);

  // Sync state from URL when it changes (e.g., navigating from another page)
  useEffect(() => {
    const newDateFilterId = searchParams.get('date_filter');
    const newStartDate = searchParams.get('start');
    const newEndDate = searchParams.get('end');

    if (newDateFilterId) {
      const newFilter = findDateFilterOption(newDateFilterId);
      if (newFilter.id !== dateFilter.id) {
        setDateFilterState(newFilter);
        setFilterVersion(v => v + 1);
      }
    }

    if (newStartDate) {
      const parsed = new Date(newStartDate);
      if (!customStartDate || parsed.getTime() !== customStartDate.getTime()) {
        setCustomStartDateState(parsed);
      }
    }

    if (newEndDate) {
      const parsed = new Date(newEndDate);
      if (!customEndDate || parsed.getTime() !== customEndDate.getTime()) {
        setCustomEndDateState(parsed);
      }
    }
  }, [searchParams]);

  // Update URL when state changes
  const updateUrl = useCallback((filterId: string, start: Date | null, end: Date | null) => {
    const params = new URLSearchParams(searchParams.toString());

    // Always set the date filter
    params.set('date_filter', filterId);

    // Set custom dates if using custom filter
    if (filterId === 'custom' && start && end) {
      params.set('start', start.toISOString());
      params.set('end', end.toISOString());
    } else {
      // Remove custom date params for preset filters
      params.delete('start');
      params.delete('end');
    }

    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  }, [searchParams, router, pathname]);

  const setDateFilter = useCallback((option: DateFilterOption) => {
    setDateFilterState(option);
    setFilterVersion(v => v + 1);

    if (!option.isCustom) {
      updateUrl(option.id, null, null);
    }

    onFilterChange?.();
  }, [onFilterChange, updateUrl]);

  const setCustomRange = useCallback((start: Date, end: Date) => {
    setCustomStartDateState(start);
    setCustomEndDateState(end);

    const customOption = DATE_FILTER_OPTIONS.find(o => o.isCustom)!;
    setDateFilterState(customOption);
    updateUrl('custom', start, end);

    onFilterChange?.();
  }, [onFilterChange, updateUrl]);

  // Calculate timestamps
  const timestamps = useMemo(() => {
    return toTimestampBounds(dateFilter.id, customStartDate ?? undefined, customEndDate ?? undefined);
  }, [dateFilter.id, customStartDate, customEndDate, filterVersion]);

  return {
    dateFilter,
    customStartDate,
    customEndDate,
    setDateFilter,
    setCustomRange,
    timestamps,
  };
}
