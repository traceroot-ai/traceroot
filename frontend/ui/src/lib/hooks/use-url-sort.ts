/**
 * Hook for a list's column sort synchronized with URL parameters, so a sorted view is
 * shareable and survives refresh / back-forward.
 *
 * URL params: sort (a column key), order ("asc" | "desc"). Both absent means the list's
 * default order.
 */
import { useCallback, useMemo } from "react";
import { useSearchParams, useRouter, usePathname } from "next/navigation";
import type { ListSort } from "@/types/api";

interface UseUrlSortReturn<K extends string> {
  /** The sort named by the URL, or undefined for the list's default order. */
  sort: ListSort<K> | undefined;
  /** Sort by a column, or reverse the direction if it is already the sorted one. */
  toggleSort: (key: K) => void;
}

/**
 * @param sortKeys Columns this list can sort by; anything else in the URL is ignored.
 * Omit for a list with no sorting.
 * @param onSortChange Called after a new sort is written. The URL page reset already
 * happens inside that write, so pass a state-only page reset.
 * @param defaultSort The column and direction the unsorted list is already in, if one is
 * on screen, so the first click on it reverses the order rather than repeating it.
 */
export function useUrlSort<K extends string>(
  sortKeys: readonly K[] | undefined,
  onSortChange?: () => void,
  defaultSort?: ListSort<K>,
): UseUrlSortReturn<K> {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  const rawKey = searchParams.get("sort");
  const key = sortKeys?.find((candidate) => candidate === rawKey);
  const order = searchParams.get("order") === "asc" ? "asc" : "desc";
  const sort = useMemo(() => (key ? { key, order } : undefined), [key, order]) as
    | ListSort<K>
    | undefined;

  const currentKey = sort?.key ?? defaultSort?.key;
  const currentOrder = sort?.order ?? defaultSort?.order;

  const toggleSort = useCallback(
    (next: K) => {
      // Descending first: the useful end of a count or a time is the large, recent one.
      const nextOrder = next === currentKey && currentOrder === "desc" ? "asc" : "desc";
      const params = new URLSearchParams(searchParams.toString());
      params.set("sort", next);
      params.set("order", nextOrder);
      // Back to the first page in the same write: page N of one order means nothing in
      // another, and a second write would rebuild from these now-stale params.
      params.delete("page_index");
      router.replace(`${pathname}?${params.toString()}`, { scroll: false });
      onSortChange?.();
    },
    [currentKey, currentOrder, searchParams, router, pathname, onSortChange],
  );

  return { sort, toggleSort };
}
