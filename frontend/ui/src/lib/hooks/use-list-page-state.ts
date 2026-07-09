/**
 * Composed hook for list page state with URL-synced date filter and pagination.
 * Combines pagination, URL-based date filtering, and search with coordinated page resets.
 *
 * URL params: page_index, page_limit, date_filter, start, end
 * Use this for pages that need shared filter state (traces, users, sessions, detector page).
 */
import { useMemo } from "react";
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
  options: { defaultLimit?: number; defaultDateFilterId?: string } = {},
): UseListPageStateReturn {
  const { defaultLimit = 50, defaultDateFilterId } = options;

  // URL-synced pagination hook - persists page/limit in URL
  const pagination = useUrlPagination(defaultLimit);

  // URL-synced date filter hook - resets page on change
  const { dateFilter, customStartDate, customEndDate, setDateFilter, setCustomRange, timestamps } =
    useUrlDateFilter(pagination.resetPage, defaultDateFilterId);

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
    // Date filter
    dateFilter,
    customStartDate,
    customEndDate,
    updateDateFilter: setDateFilter,
    updateCustomRange: setCustomRange,
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
