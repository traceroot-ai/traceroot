/**
 * Composed hook for list page state with URL-synced date filter and pagination.
 * Combines pagination, URL-based date filtering, and search with coordinated page resets.
 *
 * URL params: page_index, page_limit, date_filter, start, end, filters, search, sort, order
 * Use this for pages that need shared filter state (traces, users, sessions, detector page).
 */
import { useCallback, useMemo, useRef } from "react";
import { useUrlPagination } from "./use-url-pagination";
import { useUrlDateFilter } from "./use-url-date-filter";
import { useUrlKeywordSearch } from "./use-url-keyword-search";
import { useUrlFilters } from "./use-url-filters";
import { useUrlSort } from "./use-url-sort";
import type { ListSort, Predicate, SortOrder } from "@/types/api";

interface QueryOptions<K extends string> {
  page: number;
  limit: number;
  search_query?: string;
  start_after?: string;
  end_before?: string;
  filters?: Predicate[];
  sort?: K;
  order?: SortOrder;
}

interface UseListPageStateReturn<K extends string> {
  // Pagination
  page: number;
  limit: number;
  goToPage: (page: number) => void;
  updateLimit: (limit: number) => void;
  clampToTotal: (total: number) => void;
  // Date filter (URL-synced)
  dateFilter: ReturnType<typeof useUrlDateFilter>["dateFilter"];
  customStartDate: Date | null;
  customEndDate: Date | null;
  updateDateFilter: ReturnType<typeof useUrlDateFilter>["setDateFilter"];
  updateCustomRange: ReturnType<typeof useUrlDateFilter>["setCustomRange"];
  // Search
  keyword: string;
  updateKeyword: ReturnType<typeof useUrlKeywordSearch>["setKeyword"];
  // Structured attribute filters (URL-synced)
  filters: Predicate[];
  updateFilters: ReturnType<typeof useUrlFilters>["setFilters"];
  // Column sort (URL-synced); undefined is the list's default order
  sort: ListSort<K> | undefined;
  toggleSort: (key: K) => void;
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
  queryOptions: QueryOptions<K>;
}

export function useListPageState<K extends string = never>(
  options: {
    defaultLimit?: number;
    defaultDateFilterId?: string;
    retentionDays?: number | null;
    // Must be a stable reference (a module-level constant) -- see useUrlFilters.
    defaultFilters?: Predicate[];
    // Columns the list can sort by, and the one its default order already follows.
    sortKeys?: readonly K[];
    defaultSort?: ListSort<K>;
  } = {},
): UseListPageStateReturn<K> {
  const {
    defaultLimit = 50,
    defaultDateFilterId,
    retentionDays,
    defaultFilters,
    sortKeys,
    defaultSort,
  } = options;

  // URL-synced pagination hook - persists page/limit in URL
  const pagination = useUrlPagination(defaultLimit);

  const isSettingFilter = useRef(false);

  // setDateFilter/setCustomRange reset page_index inside their own atomic URL write,
  // so they need only a state reset to avoid a racing second router.replace.
  // When a stored date filter is restored or retention clamps the effective range,
  // no atomic URL write occurred, so we call pagination.resetPage to clear page_index
  // from the URL as well.
  const { resetPage, resetPageState } = pagination;
  const handleDateFilterChange = useCallback(() => {
    if (isSettingFilter.current) {
      resetPageState();
    } else {
      resetPage();
    }
  }, [resetPage, resetPageState]);

  // URL-synced date filter hook
  const { dateFilter, customStartDate, customEndDate, setDateFilter, setCustomRange, timestamps } =
    useUrlDateFilter(handleDateFilterChange, defaultDateFilterId, retentionDays);

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

  // Search (URL-synced). Like setFilters, the debounced write drops page_index inside
  // its own URL mutation, so it takes the state-only page reset too.
  const { keyword, setKeyword, searchQuery } = useUrlKeywordSearch(pagination.resetPageState);

  // Structured filters (URL-synced). setFilters resets page_index inside its own URL
  // write, so it takes the state-only page reset (a second URL write would clobber the
  // just-set filter from stale params).
  const { filters, setFilters } = useUrlFilters(pagination.resetPageState, defaultFilters);

  // Column sort (URL-synced), resetting the page the same way filters do.
  const { sort, toggleSort } = useUrlSort(sortKeys, pagination.resetPageState, defaultSort);

  // Build query options for API call
  const queryOptions = useMemo<QueryOptions<K>>(
    () => ({
      page: pagination.page,
      limit: pagination.limit,
      search_query: searchQuery,
      start_after: timestamps.startAfter,
      end_before: timestamps.endBefore,
      filters,
      ...(sort && { sort: sort.key, order: sort.order }),
    }),
    [
      pagination.page,
      pagination.limit,
      searchQuery,
      timestamps.startAfter,
      timestamps.endBefore,
      filters,
      sort,
    ],
  );

  return {
    // Pagination
    page: pagination.page,
    limit: pagination.limit,
    goToPage: pagination.goToPage,
    updateLimit: pagination.setLimit,
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
    // Sort
    sort,
    toggleSort,
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
