/**
 * Hook for managing keyword search state with debouncing.
 * Provides immediate input feedback while debouncing API queries.
 */
import { useState, useCallback, useEffect, useRef } from 'react';

const DEBOUNCE_DELAY_MS = 300;

interface UseKeywordSearchReturn {
  keyword: string;
  setKeyword: (value: string) => void;
  searchQuery: string | undefined; // Ready for API (undefined if empty), debounced
}

export function useKeywordSearch(onSearchChange?: () => void): UseKeywordSearchReturn {
  const [keyword, setKeywordState] = useState('');
  const [debouncedKeyword, setDebouncedKeyword] = useState('');
  const isFirstRender = useRef(true);
  const onSearchChangeRef = useRef(onSearchChange);

  // Keep ref updated
  onSearchChangeRef.current = onSearchChange;

  // Debounce the keyword for API queries
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedKeyword(keyword);
    }, DEBOUNCE_DELAY_MS);

    return () => clearTimeout(timer);
  }, [keyword]);

  // Call onSearchChange when debounced value changes (skip initial render)
  // Use ref to avoid re-running effect when callback changes
  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }
    onSearchChangeRef.current?.();
  }, [debouncedKeyword]); // Only depend on debouncedKeyword, not the callback

  const setKeyword = useCallback((value: string) => {
    setKeywordState(value);
  }, []);

  return {
    keyword,
    setKeyword,
    searchQuery: debouncedKeyword || undefined,
  };
}
