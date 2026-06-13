/**
 * Hook for managing date filter state synchronized with URL parameters.
 * This allows date filter state to persist across page navigation.
 */
import { useState, useCallback, useMemo, useEffect, useRef } from "react";
import { useSearchParams, useRouter, usePathname } from "next/navigation";
import {
  DEFAULT_DATE_FILTER,
  DATE_FILTER_OPTIONS,
  toTimestampBounds,
  findDateFilterOption,
  type DateFilterOption,
} from "@/lib/date-filter";
import { persistDateFilter, readPersistedDateFilter } from "@/lib/date-filter-persistence";

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

export function useUrlDateFilter(
  onFilterChange?: () => void,
  defaultId?: string,
  persistKey?: string,
): UseUrlDateFilterReturn {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  // Read initial state from URL
  const urlDateFilterId = searchParams.get("date_filter");
  const urlStartDate = searchParams.get("start");
  const urlEndDate = searchParams.get("end");

  // Parse URL values into state
  const initialDateFilter = urlDateFilterId
    ? findDateFilterOption(urlDateFilterId)
    : defaultId
      ? findDateFilterOption(defaultId)
      : DEFAULT_DATE_FILTER;
  const initialCustomStart = urlStartDate ? new Date(urlStartDate) : null;
  const initialCustomEnd = urlEndDate ? new Date(urlEndDate) : null;

  const [dateFilter, setDateFilterState] = useState<DateFilterOption>(initialDateFilter);
  const [customStartDate, setCustomStartDateState] = useState<Date | null>(initialCustomStart);
  const [customEndDate, setCustomEndDateState] = useState<Date | null>(initialCustomEnd);
  const [filterVersion, setFilterVersion] = useState(0);

  // Use ref for callback to avoid dependency issues
  const onFilterChangeRef = useRef(onFilterChange);
  onFilterChangeRef.current = onFilterChange;

  // Sync state from URL when it changes (e.g., navigating from another page)
  useEffect(() => {
    const newDateFilterId = searchParams.get("date_filter");
    const newStartDate = searchParams.get("start");
    const newEndDate = searchParams.get("end");

    if (newDateFilterId) {
      const newFilter = findDateFilterOption(newDateFilterId);
      if (newFilter.id !== dateFilter.id) {
        setDateFilterState(newFilter);
        setFilterVersion((v) => v + 1);
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
  }, [searchParams, dateFilter, customStartDate, customEndDate]);

  // Update URL when state changes
  const updateUrl = useCallback(
    (filterId: string, start: Date | null, end: Date | null) => {
      const params = new URLSearchParams(searchParams.toString());

      // Always set the date filter
      params.set("date_filter", filterId);

      // Set custom dates if using custom filter
      if (filterId === "custom" && start && end) {
        params.set("start", start.toISOString());
        params.set("end", end.toISOString());
      } else {
        // Remove custom date params for preset filters
        params.delete("start");
        params.delete("end");
      }

      router.replace(`${pathname}?${params.toString()}`, { scroll: false });
    },
    [searchParams, router, pathname],
  );

  const setDateFilter = useCallback(
    (option: DateFilterOption) => {
      setDateFilterState(option);
      setFilterVersion((v) => v + 1);

      if (!option.isCustom) {
        updateUrl(option.id, null, null);
        if (persistKey) persistDateFilter(persistKey, option, null, null);
      }

      onFilterChangeRef.current?.();
    },
    [updateUrl, persistKey],
  );

  const setCustomRange = useCallback(
    (start: Date, end: Date) => {
      setCustomStartDateState(start);
      setCustomEndDateState(end);

      const customOption = DATE_FILTER_OPTIONS.find((o) => o.isCustom)!;
      setDateFilterState(customOption);
      updateUrl("custom", start, end);
      if (persistKey) persistDateFilter(persistKey, customOption, start, end);

      onFilterChangeRef.current?.();
    },
    [updateUrl, persistKey],
  );

  // Restore a persisted date filter (opt-in via persistKey) into state. Runs
  // once per persistKey, and only when the URL carries no explicit date_filter
  // so a shared or bookmarked link always wins. State (not the URL) drives the
  // query, so this never mutates a clean URL or adds a history entry. Re-runs
  // when persistKey changes — e.g. switching projects, where the page component
  // is reused rather than remounted — falling back to the page default so the
  // previous project's filter never lingers. See issue #951.
  const restoredKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!persistKey || restoredKeyRef.current === persistKey) return;
    // An explicit date_filter in the URL wins — and must NOT consume the
    // restore latch for this key, so that a later clean URL (e.g. navigating to
    // the bare list, or clearing the param) still restores the saved
    // preference rather than keeping a stale shared-link value.
    if (searchParams.get("date_filter")) return;
    restoredKeyRef.current = persistKey;

    const restored = readPersistedDateFilter(persistKey);
    if (restored) {
      setDateFilterState(restored.option);
      setCustomStartDateState(restored.customStart);
      setCustomEndDateState(restored.customEnd);
    } else {
      // No stored preference for this key — reset to the page default so a
      // project switch doesn't carry over the previous project's filter.
      setDateFilterState(defaultId ? findDateFilterOption(defaultId) : DEFAULT_DATE_FILTER);
      setCustomStartDateState(null);
      setCustomEndDateState(null);
    }
    setFilterVersion((v) => v + 1);
    // Reset pagination: a narrower restored window may make the current page
    // index out of range, otherwise stranding the user on an empty page.
    onFilterChangeRef.current?.();
  }, [persistKey, searchParams, defaultId]);

  // Calculate timestamps
  const timestamps = useMemo(() => {
    return toTimestampBounds(
      dateFilter.id,
      customStartDate ?? undefined,
      customEndDate ?? undefined,
    );
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
