/**
 * Composed hook for list page state with URL-synced date filter.
 * Combines pagination, URL-based date filtering, and search with coordinated page resets.
 *
 * Use this for pages that need shared date filter state (traces, users, sessions).
 */
import { useMemo } from 'react';
import { usePagination } from './use-pagination';
import { useUrlDateFilter } from './use-url-date-filter';
import { useKeywordSearch } from './use-keyword-search';

interface QueryOptions {
  page: number;
  limit: number;
  search_query?: string;
  start_after?: string;
  end_before?: string;
}

interface UseListPageStateReturn {
  // Pagination
  page: number;
  limit: number;
  goToPage: (page: number) => void;
  updateLimit: (limit: number) => void;
  // Date filter (URL-synced)
  dateFilter: ReturnType<typeof useUrlDateFilter>['dateFilter'];
  customStartDate: Date | null;
  customEndDate: Date | null;
  updateDateFilter: ReturnType<typeof useUrlDateFilter>['setDateFilter'];
  updateCustomRange: ReturnType<typeof useUrlDateFilter>['setCustomRange'];
  // Search
  keyword: string;
  updateKeyword: ReturnType<typeof useKeywordSearch>['setKeyword'];
  // Combined state for convenience
  state: {
    page: number;
    limit: number;
    dateFilter: ReturnType<typeof useUrlDateFilter>['dateFilter'];
    customStartDate: Date | null;
    customEndDate: Date | null;
    keyword: string;
  };
  // Ready-to-use query options for API
  queryOptions: QueryOptions;
}

export function useListPageState(defaultLimit = 50): UseListPageStateReturn {
  // Pagination hook
  const pagination = usePagination(defaultLimit);

  // URL-synced date filter hook - resets page on change
  const {
    dateFilter,
    customStartDate,
    customEndDate,
    setDateFilter,
    setCustomRange,
    timestamps,
  } = useUrlDateFilter(pagination.resetPage);

  // Search hook - resets page on change
  const { keyword, setKeyword, searchQuery } = useKeywordSearch(pagination.resetPage);

  // Build query options for API call
  const queryOptions = useMemo<QueryOptions>(() => ({
    page: pagination.page,
    limit: pagination.limit,
    search_query: searchQuery,
    start_after: timestamps.startAfter,
    end_before: timestamps.endBefore,
  }), [pagination.page, pagination.limit, searchQuery, timestamps.startAfter, timestamps.endBefore]);

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
    // Combined state
    state: {
      page: pagination.page,
      limit: pagination.limit,
      dateFilter,
      customStartDate,
      customEndDate,
      keyword,
    },
    // API options
    queryOptions,
  };
}
