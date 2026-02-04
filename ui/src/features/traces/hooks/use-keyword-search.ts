/**
 * Hook for managing keyword search state.
 * Single responsibility: search query with page reset callback.
 */
import { useState, useCallback } from 'react';

interface UseKeywordSearchReturn {
  keyword: string;
  setKeyword: (value: string) => void;
  searchQuery: string | undefined; // Ready for API (undefined if empty)
}

export function useKeywordSearch(onSearchChange?: () => void): UseKeywordSearchReturn {
  const [keyword, setKeywordState] = useState('');

  const setKeyword = useCallback((value: string) => {
    setKeywordState(value);
    onSearchChange?.();
  }, [onSearchChange]);

  return {
    keyword,
    setKeyword,
    searchQuery: keyword || undefined,
  };
}
