/**
 * Hook for managing pagination state.
 * Single responsibility: page index and page size management.
 */
import { useState, useCallback } from 'react';

interface UsePaginationReturn {
  page: number;
  limit: number;
  goToPage: (page: number) => void;
  setLimit: (limit: number) => void;
  resetPage: () => void;
}

export function usePagination(defaultLimit = 50): UsePaginationReturn {
  const [page, setPage] = useState(0);
  const [limit, setLimitState] = useState(defaultLimit);

  const goToPage = useCallback((newPage: number) => {
    setPage(newPage);
  }, []);

  const setLimit = useCallback((newLimit: number) => {
    setLimitState(newLimit);
    setPage(0); // Reset to first page when limit changes
  }, []);

  const resetPage = useCallback(() => {
    setPage(0);
  }, []);

  return {
    page,
    limit,
    goToPage,
    setLimit,
    resetPage,
  };
}
