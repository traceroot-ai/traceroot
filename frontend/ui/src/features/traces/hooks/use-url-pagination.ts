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

export function useUrlPagination(defaultLimit = DEFAULT_LIMIT): UseUrlPaginationReturn {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  // Read initial state from URL
  const urlPage = searchParams.get("page_index");
  const urlLimit = searchParams.get("page_limit");

  const initialPage = urlPage ? parseInt(urlPage, 10) : DEFAULT_PAGE;
  const initialLimit = urlLimit ? parseInt(urlLimit, 10) : defaultLimit;

  const [page, setPageState] = useState(isNaN(initialPage) ? DEFAULT_PAGE : initialPage);
  const [limit, setLimitState] = useState(isNaN(initialLimit) ? defaultLimit : initialLimit);

  // Track if we're doing a programmatic update (to avoid re-syncing from URL)
  const isProgrammaticUpdate = useRef(false);

  // Sync state from URL when URL changes (e.g., browser back/forward)
  useEffect(() => {
    // Skip if this is our own programmatic update
    if (isProgrammaticUpdate.current) {
      isProgrammaticUpdate.current = false;
      return;
    }

    const urlPageStr = searchParams.get("page_index");
    const urlLimitStr = searchParams.get("page_limit");

    // Parse URL values, defaulting to 0 and defaultLimit if not present
    const newPage = urlPageStr ? parseInt(urlPageStr, 10) : DEFAULT_PAGE;
    const newLimit = urlLimitStr ? parseInt(urlLimitStr, 10) : defaultLimit;

    if (!isNaN(newPage)) {
      setPageState(newPage);
    }

    if (!isNaN(newLimit)) {
      setLimitState(newLimit);
    }
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
