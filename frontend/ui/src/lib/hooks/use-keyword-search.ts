/**
 * Hook for managing keyword search state with debouncing.
 * Provides immediate input feedback while debouncing API queries.
 *
 * Local state only — for a list page whose search should survive refresh and
 * back/forward like its page and filters, use useUrlKeywordSearch instead.
 */
import { useState, useCallback, useEffect, useRef } from "react";

export const DEBOUNCE_DELAY_MS = 300;

export interface UseKeywordSearchReturn {
  keyword: string;
  setKeyword: (value: string) => void;
  searchQuery: string | undefined; // Ready for API (undefined if empty), debounced
}

export function useKeywordSearch(onSearchChange?: () => void): UseKeywordSearchReturn {
  const [keyword, setKeywordState] = useState("");
  const [debouncedKeyword, setDebouncedKeyword] = useState("");
  // The debounced value last reported, so only a real change fires onSearchChange.
  const reportedKeyword = useRef(debouncedKeyword);
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

  // Call onSearchChange when the debounced value changes. Compared against the last
  // reported value rather than a first-render flag: StrictMode re-runs mount effects,
  // and a flag would let that second run count as a change (resetting the page).
  // Use ref to avoid re-running effect when callback changes
  useEffect(() => {
    if (debouncedKeyword === reportedKeyword.current) return;
    reportedKeyword.current = debouncedKeyword;
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
