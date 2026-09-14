/**
 * Composed hook for list page state with URL-synced date filter and pagination.
 * Combines pagination, URL-based date filtering, and search with coordinated page resets.
 *
 * URL params: page_index, page_limit, date_filter, start, end
 * Use this for pages that need shared filter state (traces, users, sessions, detector page).
 */
import { useMemo, useRef, useCallback } from "react";
import { useUrlPagination } from "./use-url-pagination";
import { useUrlDateFilter } from "./use-url-date-filter";
import { useKeywordSearch } from "./use-keyword-search";
import { useUrlFilters } from "./use-url-filters";
import type { Predicate } from "@/types/api";

interface QueryOptions {
  page: number;
  limit: number;
  search_query?: string;
  start_after?: string;
  end_before?: string;
  filters?: Predicate[];
}

interface UseListPageStateReturn {
  // Pagination
  page: number;
  limit: number;
  goToPage: (page: number) => void;
  updateLimit: (limit: number) => void;
  resetPageState: () => void;
  clampToTotal: (total: number) => void;
  // Date filter (URL-synced)
  dateFilter: ReturnType<typeof useUrlDateFilter>["dateFilter"];
  customStartDate: Date | null;
  customEndDate: Date | null;
  updateDateFilter: ReturnType<typeof useUrlDateFilter>["setDateFilter"];
  updateCustomRange: ReturnType<typeof useUrlDateFilter>["setCustomRange"];
  // Search
  keyword: string;
  updateKeyword: ReturnType<typeof useKeywordSearch>["setKeyword"];
  // Structured attribute filters (URL-synced)
  filters: Predicate[];
  updateFilters: ReturnType<typeof useUrlFilters>["setFilters"];
  // Combined state for convenience
  state: {
    page: number;
    limit: number;
    dateFilter: ReturnType<typeof useUrlDateFilter>["dateFilter"];
    customStartDate: Date | null;
    customEndDate: Date | null;
    keyword: string;
    filters: Predicate[];
  };
  // Ready-to-use query options for API
  queryOptions: QueryOptions;
}

export function useListPageState(
  options: {
    defaultLimit?: number;
    defaultDateFilterId?: string;
    retentionDays?: number | null;
    syncStorage?: boolean;
  } = {},
): UseListPageStateReturn {
  const { defaultLimit = 50, defaultDateFilterId, retentionDays, syncStorage = true } = options;

  // URL-synced pagination hook - persists page/limit in URL
  const pagination = useUrlPagination(defaultLimit);

  const isSettingFilter = useRef(false);

  // setDateFilter/setCustomRange reset page_index inside their own atomic URL write,
  // so they need only a state reset to avoid a racing second router.replace.
  // When a stored date filter is restored or retention clamps the effective range,
  // no atomic URL write occurred, so we call pagination.resetPage to clear page_index
  // from the URL as well.
  const handleDateFilterChange = useCallback(() => {
    if (isSettingFilter.current) {
      pagination.resetPageState();
    } else {
      pagination.resetPage();
    }
  }, [pagination]);

  // URL-synced date filter hook
  const { dateFilter, customStartDate, customEndDate, setDateFilter, setCustomRange, timestamps } =
    useUrlDateFilter(handleDateFilterChange, defaultDateFilterId, retentionDays, syncStorage);

  const updateDateFilter = useCallback(
    (option: Parameters<typeof setDateFilter>[0]) => {
      isSettingFilter.current = true;
      try {
        setDateFilter(option);
      } finally {
        isSettingFilter.current = false;
      }
    },
    [setDateFilter],
  );

  const updateCustomRange = useCallback(
    (start: Date, end: Date) => {
      isSettingFilter.current = true;
      try {
        setCustomRange(start, end);
      } finally {
        isSettingFilter.current = false;
      }
    },
    [setCustomRange],
  );

  // Search hook - resets page on change
  const { keyword, setKeyword, searchQuery } = useKeywordSearch(pagination.resetPage);

  // Structured filters (URL-synced). setFilters resets page_index inside its own URL
  // write, so it takes the state-only page reset (a second URL write would clobber the
  // just-set filter from stale params).
  const { filters, setFilters } = useUrlFilters(pagination.resetPageState);

  // Build query options for API call
  const queryOptions = useMemo<QueryOptions>(
    () => ({
      page: pagination.page,
      limit: pagination.limit,
      search_query: searchQuery,
      start_after: timestamps.startAfter,
      end_before: timestamps.endBefore,
      filters,
    }),
    [
      pagination.page,
      pagination.limit,
      searchQuery,
      timestamps.startAfter,
      timestamps.endBefore,
      filters,
    ],
  );

  return {
    // Pagination
    page: pagination.page,
    limit: pagination.limit,
    goToPage: pagination.goToPage,
    updateLimit: pagination.setLimit,
    resetPageState: pagination.resetPageState,
    clampToTotal: pagination.clampToTotal,
    // Date filter
    dateFilter,
    customStartDate,
    customEndDate,
    updateDateFilter,
    updateCustomRange,
    // Search
    keyword,
    updateKeyword: setKeyword,
    // Filters
    filters,
    updateFilters: setFilters,
    // Combined state
    state: {
      page: pagination.page,
      limit: pagination.limit,
      dateFilter,
      customStartDate,
      customEndDate,
      keyword,
      filters,
    },
    // API options
    queryOptions,
  };
}
