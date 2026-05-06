/**
 * Hook for managing pagination state synchronized with URL parameters.
 * This allows pagination state to persist across page refresh and be shareable.
 *
 * URL params: page_index (0-indexed), page_limit (items per page)
 */
import { useState, useCallback, useEffect, useRef } from "react";
import { useSearchParams, useRouter, usePathname } from "next/navigation";

interface UseUrlPaginationReturn {
  page: number;
  limit: number;
  goToPage: (page: number) => void;
  setLimit: (limit: number) => void;
  resetPage: () => void;
}

const DEFAULT_PAGE = 0;
const DEFAULT_LIMIT = 50;

// Reject NaN, Infinity, and out-of-range values so a hand-edited URL like
// `?page_limit=0` or `?page_index=-2` falls back to defaults instead of
// propagating to the API request and the pagination component.
function parseUrlInt(raw: string | null, fallback: number, min: number): number {
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= min ? n : fallback;
}

export function useUrlPagination(defaultLimit = DEFAULT_LIMIT): UseUrlPaginationReturn {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  const initialPage = parseUrlInt(searchParams.get("page_index"), DEFAULT_PAGE, 0);
  const initialLimit = parseUrlInt(searchParams.get("page_limit"), defaultLimit, 1);

  const [page, setPageState] = useState(initialPage);
  const [limit, setLimitState] = useState(initialLimit);

  // Track if we're doing a programmatic update (to avoid re-syncing from URL)
  const isProgrammaticUpdate = useRef(false);

  // Sync state from URL when URL changes (e.g., browser back/forward)
  useEffect(() => {
    // Skip if this is our own programmatic update
    if (isProgrammaticUpdate.current) {
      isProgrammaticUpdate.current = false;
      return;
    }

    setPageState(parseUrlInt(searchParams.get("page_index"), DEFAULT_PAGE, 0));
    setLimitState(parseUrlInt(searchParams.get("page_limit"), defaultLimit, 1));
  }, [searchParams, defaultLimit]);

  // Update URL with current pagination state
  const updateUrl = useCallback(
    (newPage: number, newLimit: number) => {
      const params = new URLSearchParams(searchParams.toString());

      // Only add to URL if not default values (keeps URL cleaner)
      if (newPage !== DEFAULT_PAGE) {
        params.set("page_index", String(newPage));
      } else {
        params.delete("page_index");
      }

      if (newLimit !== DEFAULT_LIMIT) {
        params.set("page_limit", String(newLimit));
      } else {
        params.delete("page_limit");
      }

      // Mark as programmatic update to skip re-sync in useEffect
      isProgrammaticUpdate.current = true;
      router.replace(`${pathname}?${params.toString()}`, { scroll: false });
    },
    [searchParams, router, pathname],
  );

  const goToPage = useCallback(
    (newPage: number) => {
      setPageState(newPage);
      updateUrl(newPage, limit);
    },
    [limit, updateUrl],
  );

  const setLimit = useCallback(
    (newLimit: number) => {
      setLimitState(newLimit);
      setPageState(DEFAULT_PAGE); // Reset to first page when changing limit
      updateUrl(DEFAULT_PAGE, newLimit);
    },
    [updateUrl],
  );

  const resetPage = useCallback(() => {
    setPageState((currentPage) => {
      if (currentPage !== DEFAULT_PAGE) {
        updateUrl(DEFAULT_PAGE, limit);
        return DEFAULT_PAGE;
      }
      return currentPage;
    });
  }, [limit, updateUrl]);

  return {
    page,
    limit,
    goToPage,
    setLimit,
    resetPage,
  };
}
