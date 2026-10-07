/**
 * Hook for managing keyword search state synchronized with URL parameters, so a
 * searched list survives refresh / back-forward and lands on the same filtered
 * result set as its (also URL-synced) page.
 *
 * URL param: search (omitted when empty)
 *
 * The input stays immediate (local state); only the debounced value is written to
 * the URL, with router.replace so typing never adds history entries.
 */
import { useState, useCallback, useEffect, useRef } from "react";
import { useSearchParams, useRouter, usePathname } from "next/navigation";
import { DEBOUNCE_DELAY_MS, type UseKeywordSearchReturn } from "./use-keyword-search";

const SEARCH_PARAM = "search";

/**
 * @param onSearchChange Called after the debounced keyword changes. The URL page reset
 * already happens inside this hook's own write (`page_index` is dropped in the same
 * mutation), so pass a state-only page reset — a second URL write would rebuild from
 * stale params and drop the search just written.
 */
export function useUrlKeywordSearch(onSearchChange?: () => void): UseKeywordSearchReturn {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  // Start from the URL so a restored page lands on the same filtered set.
  const initialKeyword = searchParams.get(SEARCH_PARAM) ?? "";
  const [keyword, setKeywordState] = useState(initialKeyword);
  const [debouncedKeyword, setDebouncedKeyword] = useState(initialKeyword);

  // The keyword the URL holds, as far as this hook knows. A debounced value equal to
  // it is not a change — that covers the debounce timer firing on mount with the
  // initial value, and a value adopted from the URL on back/forward — so neither
  // writes the URL nor resets the page.
  const committedKeyword = useRef(initialKeyword);
  // Skip the URL→state sync for our own writes (mirrors the pagination hook).
  const isProgrammaticUpdate = useRef(false);
  const onSearchChangeRef = useRef(onSearchChange);
  onSearchChangeRef.current = onSearchChange;
  // The write below runs from an effect keyed only on the debounced value; read the
  // latest params through a ref so it never rebuilds from a stale query (and an
  // unrelated URL change doesn't re-run it).
  const latest = useRef({ searchParams, router, pathname });
  latest.current = { searchParams, router, pathname };

  // Sync state from the URL on external changes (e.g. browser back/forward).
  useEffect(() => {
    if (isProgrammaticUpdate.current) {
      isProgrammaticUpdate.current = false;
      return;
    }
    const next = searchParams.get(SEARCH_PARAM) ?? "";
    // Another param changed (page, date, filters): keep any in-flight typing.
    if (next === committedKeyword.current) return;
    committedKeyword.current = next;
    setKeywordState(next);
    setDebouncedKeyword(next);
  }, [searchParams]);

  // Debounce the keyword for API queries and the URL.
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedKeyword(keyword);
    }, DEBOUNCE_DELAY_MS);

    return () => clearTimeout(timer);
  }, [keyword]);

  // Write a changed debounced keyword to the URL.
  useEffect(() => {
    if (debouncedKeyword === committedKeyword.current) return;
    committedKeyword.current = debouncedKeyword;

    const { searchParams: current, router: r, pathname: path } = latest.current;
    const params = new URLSearchParams(current.toString());
    if (debouncedKeyword) {
      params.set(SEARCH_PARAM, debouncedKeyword);
    } else {
      params.delete(SEARCH_PARAM);
    }
    // Reset to the first page in the SAME mutation: the old page belongs to the old
    // result set, and a separate page-reset write would rebuild from stale params and
    // drop the search we just set.
    params.delete("page_index");

    // Don't arm the guard for a write that wouldn't change the URL: router.replace
    // would be a no-op, the sync effect would never run, and the armed guard would
    // swallow the NEXT real back/forward.
    if (params.toString() !== current.toString()) {
      isProgrammaticUpdate.current = true;
      const qs = params.toString();
      r.replace(qs ? `${path}?${qs}` : path, { scroll: false });
    }

    // State-only page reset — the URL page reset already happened in the write above.
    onSearchChangeRef.current?.();
  }, [debouncedKeyword]);

  const setKeyword = useCallback((value: string) => {
    setKeywordState(value);
  }, []);

  return {
    keyword,
    setKeyword,
    searchQuery: debouncedKeyword || undefined,
  };
}
