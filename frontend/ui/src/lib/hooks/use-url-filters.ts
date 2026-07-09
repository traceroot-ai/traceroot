/**
 * Hook for managing the structured trace filters synchronized with URL parameters,
 * so a filtered list is shareable and survives refresh / back-forward.
 *
 * URL param: filters (one URL-encoded JSON predicate array)
 */
import { useState, useCallback, useEffect, useRef } from "react";
import { useSearchParams, useRouter, usePathname } from "next/navigation";
import type { Predicate } from "@/types/api";
import { parseFiltersParam, serializeFiltersParam } from "@/features/filters/predicate";

interface UseUrlFiltersReturn {
  filters: Predicate[];
  setFilters: (filters: Predicate[]) => void;
}

export function useUrlFilters(onFiltersChange?: () => void): UseUrlFiltersReturn {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  const [filters, setFiltersState] = useState<Predicate[]>(() =>
    parseFiltersParam(searchParams.get("filters")),
  );

  // Skip the URL→state sync for our own writes (mirrors the pagination hook).
  const isProgrammaticUpdate = useRef(false);
  const onFiltersChangeRef = useRef(onFiltersChange);
  onFiltersChangeRef.current = onFiltersChange;

  // Sync state from the URL on external changes (e.g. browser back/forward).
  useEffect(() => {
    if (isProgrammaticUpdate.current) {
      isProgrammaticUpdate.current = false;
      return;
    }
    setFiltersState(parseFiltersParam(searchParams.get("filters")));
  }, [searchParams]);

  const setFilters = useCallback(
    (next: Predicate[]) => {
      setFiltersState(next);

      const params = new URLSearchParams(searchParams.toString());
      const serialized = serializeFiltersParam(next);
      if (serialized) {
        params.set("filters", serialized);
      } else {
        params.delete("filters");
      }
      // Reset to the first page in the SAME mutation, so a filter applied while on page
      // >1 lands in the URL. A separate page-reset write would rebuild from this stale
      // searchParams and drop the filter we just set (refresh/share/back would lose it).
      params.delete("page_index");

      // If the URL wouldn't actually change (re-applying an identical filter set),
      // router.replace is a no-op, so the sync effect never runs and the guard would
      // stay armed — silently swallowing the NEXT real back/forward. Only arm the
      // guard and write when the query string actually changes.
      if (params.toString() === searchParams.toString()) return;

      isProgrammaticUpdate.current = true;
      router.replace(`${pathname}?${params.toString()}`, { scroll: false });

      // State-only page reset — the URL page reset already happened in the write above.
      onFiltersChangeRef.current?.();
    },
    [searchParams, router, pathname],
  );

  return { filters, setFilters };
}
