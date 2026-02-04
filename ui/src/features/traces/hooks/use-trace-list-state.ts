/**
 * Composed hook for trace list query state.
 * Combines pagination, date filtering, and search with coordinated page resets.
 *
 * For finer control, use the individual hooks directly:
 * - usePagination
 * - useDateFilter
 * - useKeywordSearch
 */
import { useMemo } from 'react';
import { usePagination } from './use-pagination';
import { useDateFilter } from './use-date-filter';
import { useKeywordSearch } from './use-keyword-search';
import type { TraceQueryOptions } from '@/types/api';

interface UseTraceListStateReturn {
  // Pagination
  page: number;
  limit: number;
  goToPage: (page: number) => void;
  updateLimit: (limit: number) => void;
  // Date filter
  dateFilter: ReturnType<typeof useDateFilter>['dateFilter'];
  customStartDate: Date | null;
  customEndDate: Date | null;
  updateDateFilter: ReturnType<typeof useDateFilter>['setDateFilter'];
  updateCustomStartDate: ReturnType<typeof useDateFilter>['setCustomStartDate'];
  updateCustomEndDate: ReturnType<typeof useDateFilter>['setCustomEndDate'];
  updateCustomRange: ReturnType<typeof useDateFilter>['setCustomRange'];
  // Search
  keyword: string;
  updateKeyword: ReturnType<typeof useKeywordSearch>['setKeyword'];
  // Combined state for convenience
  state: {
    page: number;
    limit: number;
    dateFilter: ReturnType<typeof useDateFilter>['dateFilter'];
    customStartDate: Date | null;
    customEndDate: Date | null;
    keyword: string;
  };
  // Ready-to-use query options for API
  queryOptions: TraceQueryOptions;
}

export function useTraceListState(defaultLimit = 50): UseTraceListStateReturn {
  // Pagination hook
  const pagination = usePagination(defaultLimit);

  // Date filter hook - resets page on change
  const { dateFilter, customStartDate, customEndDate, setDateFilter, setCustomStartDate, setCustomEndDate, setCustomRange, timestamps } = useDateFilter(pagination.resetPage);

  // Search hook - resets page on change
  const { keyword, setKeyword, searchQuery } = useKeywordSearch(pagination.resetPage);

  // Build query options for API call
  const queryOptions = useMemo<TraceQueryOptions>(() => ({
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
    updateCustomStartDate: setCustomStartDate,
    updateCustomEndDate: setCustomEndDate,
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
