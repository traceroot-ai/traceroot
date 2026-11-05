/**
 * Hook for managing the structured trace filters synchronized with URL parameters,
 * so a filtered list is shareable and survives refresh / back-forward.
 *
 * URL param: filters (one URL-encoded JSON predicate array)
 *
 * `defaultFilters`, when given, is applied only while the `filters` key is absent from
 * the URL. Clearing filters back to empty on a page with a non-empty default writes the
 * explicit marker `filters=[]` instead of deleting the key, so the removed default stays
 * removed on reload and back/forward (an absent key would otherwise re-resolve to the
 * default). `defaultFilters` must be a stable reference (a module-level constant) — it's
 * read directly in the initial state and the URL-resync effect below, so a new array
 * identity on every render would re-run that effect on every render too.
 */
import { useState, useCallback, useEffect, useRef } from "react";
import { useSearchParams, useRouter, usePathname } from "next/navigation";
import type { Predicate } from "@/types/api";
import { parseFiltersParam, serializeFiltersParam } from "@/features/filters/predicate";

interface UseUrlFiltersReturn {
  filters: Predicate[];
  setFilters: (filters: Predicate[]) => void;
}

// Absent key (`raw === null`) resolves to the configured default (or `[]` when none is
// configured); a present key, including the literal "[]" marker, is parsed as-is.
function resolveFilters(raw: string | null, defaultFilters?: Predicate[]): Predicate[] {
  if (raw === null) return defaultFilters ?? [];
  return parseFiltersParam(raw);
}

export function useUrlFilters(
  onFiltersChange?: () => void,
  defaultFilters?: Predicate[],
): UseUrlFiltersReturn {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  const [filters, setFiltersState] = useState<Predicate[]>(() =>
    resolveFilters(searchParams.get("filters"), defaultFilters),
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
    setFiltersState(resolveFilters(searchParams.get("filters"), defaultFilters));
  }, [searchParams, defaultFilters]);

  const setFilters = useCallback(
    (next: Predicate[]) => {
      setFiltersState(next);

      const params = new URLSearchParams(searchParams.toString());
      const serialized = serializeFiltersParam(next);
      if (serialized) {
        params.set("filters", serialized);
      } else if (defaultFilters && defaultFilters.length > 0) {
        // A non-empty default is configured: write the explicit empty marker rather than
        // deleting the key. Deleting it would make the key absent again, which re-resolves
        // to the default on the next read (reload, share, back/forward) instead of staying
        // cleared.
        params.set("filters", "[]");
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
    [searchParams, router, pathname, defaultFilters],
  );

  return { filters, setFilters };
}
