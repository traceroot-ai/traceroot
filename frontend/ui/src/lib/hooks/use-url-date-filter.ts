/**
 * Hook for managing date filter state synchronized with URL parameters and a
 * per-project localStorage preference. The URL keeps links shareable and wins
 * when present; otherwise the stored selection applies, so a range picked on
 * any page (trace list, dashboards, detectors) carries to all of them.
 */
import { useState, useCallback, useMemo, useEffect, useLayoutEffect, useRef } from "react";
import { useSearchParams, useRouter, usePathname, useParams } from "next/navigation";
import {
  DEFAULT_DATE_FILTER,
  DATE_FILTER_OPTIONS,
  toTimestampBounds,
  findDateFilterOption,
  clampDateFilter,
  type DateFilterOption,
} from "@/lib/date-filter";
import { readStoredDateFilter, writeStoredDateFilter } from "@/lib/date-filter-storage";

// useLayoutEffect on the client, useEffect during SSR: layout effects never
// run on the server, and React warns when a server render encounters one.
const useIsomorphicLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;

interface UseUrlDateFilterReturn {
  dateFilter: DateFilterOption;
  customStartDate: Date | null;
  customEndDate: Date | null;
  setDateFilter: (option: DateFilterOption) => void;
  setCustomRange: (start: Date, end: Date) => void;
  timestamps: {
    startAfter?: string;
    endBefore?: string;
  };
}

export function useUrlDateFilter(
  onFilterChange?: () => void,
  defaultId?: string,
  retentionDays?: number | null,
): UseUrlDateFilterReturn {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const routeParams = useParams();
  const projectId = typeof routeParams?.projectId === "string" ? routeParams.projectId : null;

  // Read initial state from URL
  const urlDateFilterId = searchParams.get("date_filter");
  const urlStartDate = searchParams.get("start");
  const urlEndDate = searchParams.get("end");

  // Parse URL values into state. State holds the selection as picked (URL,
  // default, restore, or user action); clamping to the retention window is a
  // derived read below, so it re-evaluates when retention resolves instead of
  // being baked in here while it's still unknown.
  const initialDateFilter = urlDateFilterId
    ? findDateFilterOption(urlDateFilterId)
    : defaultId
      ? findDateFilterOption(defaultId)
      : DEFAULT_DATE_FILTER;
  const initialCustomStart = urlStartDate ? new Date(urlStartDate) : null;
  const initialCustomEnd = urlEndDate ? new Date(urlEndDate) : null;

  const [rawDateFilter, setRawDateFilter] = useState<DateFilterOption>(initialDateFilter);
  const [customStartDate, setCustomStartDateState] = useState<Date | null>(initialCustomStart);
  const [customEndDate, setCustomEndDateState] = useState<Date | null>(initialCustomEnd);
  const [filterVersion, setFilterVersion] = useState(0);

  // Use ref for callback to avoid dependency issues
  const onFilterChangeRef = useRef(onFilterChange);
  onFilterChangeRef.current = onFilterChange;

  // Adopt the stored per-project selection once at mount, and only when the
  // URL carries no explicit filter (a shared link's range must win on the page
  // it targets). The first render still shows the default — identical to the
  // server HTML, so hydration never mismatches — but adopting in a LAYOUT
  // effect re-renders before the browser paints, so the user never sees the
  // default window. (react-query subscribes during the same commit, so a
  // default-window fetch can still start and be superseded — invisible, but
  // one extra backend query per hard load; eliminating it would mean gating
  // every consumer query on a restoration flag.)
  const restoredRef = useRef(false);
  useIsomorphicLayoutEffect(() => {
    if (restoredRef.current) return;
    restoredRef.current = true;
    if (!projectId || searchParams.get("date_filter")) return;
    const stored = readStoredDateFilter(projectId);
    if (!stored) return;
    const option = findDateFilterOption(stored.id);
    if (option.isCustom) {
      const start = stored.start ? new Date(stored.start) : null;
      const end = stored.end ? new Date(stored.end) : null;
      // Parseable AND ordered: an inverted range would query start > end and
      // silently return nothing everywhere.
      if (!start || !end || isNaN(start.getTime()) || isNaN(end.getTime()) || end < start) return;
      setCustomStartDateState(start);
      setCustomEndDateState(end);
    } else if (option.id === rawDateFilter.id) {
      // Stored matches what's already showing — nothing to adopt.
      return;
    }
    setRawDateFilter(option);
    setFilterVersion((v) => v + 1);
    // The effective window changed under the page: consumers that paginate
    // must reset (a stale ?page_index can point past the restored window).
    onFilterChangeRef.current?.();
    // rawDateFilter.id is deliberately not a dependency: it's read only on the
    // once-guarded first run, and restoredRef prevents any re-run. (The lint
    // rule doesn't check custom-named hooks, so this documents what it can't.)
  }, [projectId, searchParams]);

  // Only explicit user actions persist: adopting a link's URL param must not
  // overwrite the preference the user picked themselves.
  const persistSelection = useCallback(
    (id: string, start: Date | null, end: Date | null) => {
      if (!projectId) return;
      writeStoredDateFilter(
        projectId,
        id === "custom" && start && end
          ? { id, start: start.toISOString(), end: end.toISOString() }
          : { id },
      );
    },
    [projectId],
  );

  // Sync state from URL when it changes (e.g., navigating from another page)
  useEffect(() => {
    const newDateFilterId = searchParams.get("date_filter");
    const newStartDate = searchParams.get("start");
    const newEndDate = searchParams.get("end");

    if (newDateFilterId) {
      const newFilter = findDateFilterOption(newDateFilterId);
      if (newFilter.id !== rawDateFilter.id) {
        setRawDateFilter(newFilter);
        setFilterVersion((v) => v + 1);
      }
    }

    if (newStartDate) {
      const parsed = new Date(newStartDate);
      if (!customStartDate || parsed.getTime() !== customStartDate.getTime()) {
        setCustomStartDateState(parsed);
      }
    }

    if (newEndDate) {
      const parsed = new Date(newEndDate);
      if (!customEndDate || parsed.getTime() !== customEndDate.getTime()) {
        setCustomEndDateState(parsed);
      }
    }
  }, [searchParams, rawDateFilter, customStartDate, customEndDate]);

  // Update URL when state changes
  const updateUrl = useCallback(
    (filterId: string, start: Date | null, end: Date | null) => {
      const params = new URLSearchParams(searchParams.toString());

      // Always set the date filter
      params.set("date_filter", filterId);

      // Set custom dates if using custom filter
      if (filterId === "custom" && start && end) {
        params.set("start", start.toISOString());
        params.set("end", end.toISOString());
      } else {
        // Remove custom date params for preset filters
        params.delete("start");
        params.delete("end");
      }

      router.replace(`${pathname}?${params.toString()}`, { scroll: false });
    },
    [searchParams, router, pathname],
  );

  const setDateFilter = useCallback(
    (option: DateFilterOption) => {
      setRawDateFilter(option);
      setFilterVersion((v) => v + 1);

      if (!option.isCustom) {
        updateUrl(option.id, null, null);
        persistSelection(option.id, null, null);
      }

      onFilterChangeRef.current?.();
    },
    [updateUrl, persistSelection],
  );

  const setCustomRange = useCallback(
    (start: Date, end: Date) => {
      setCustomStartDateState(start);
      setCustomEndDateState(end);

      const customOption = DATE_FILTER_OPTIONS.find((o) => o.isCustom)!;
      setRawDateFilter(customOption);
      updateUrl("custom", start, end);
      persistSelection("custom", start, end);

      onFilterChangeRef.current?.();
    },
    [updateUrl, persistSelection],
  );

  // Clamp to the retention window at read time. Retention is unknown while
  // the workspace lookup is in flight (a hard reload), so clamping when state
  // is written would bake the fail-closed fallback into the restored
  // selection; deriving keeps the raw pick and re-clamps once retention
  // resolves.
  const dateFilter = useMemo(
    () => clampDateFilter(rawDateFilter, retentionDays),
    [rawDateFilter, retentionDays],
  );

  // Retention resolving after mount can change the effective window with no
  // user action, and consumers that paginate must reset like on any other
  // window change (a stale ?page_index can point past the clamped window).
  // Explicit picks and the restore path fire the callback themselves, so only
  // a clamp-driven change — same raw selection, different effective filter —
  // fires here.
  const prevFilterIdsRef = useRef({ rawId: rawDateFilter.id, effectiveId: dateFilter.id });
  useEffect(() => {
    const prev = prevFilterIdsRef.current;
    const clampChanged = prev.effectiveId !== dateFilter.id && prev.rawId === rawDateFilter.id;
    prevFilterIdsRef.current = { rawId: rawDateFilter.id, effectiveId: dateFilter.id };
    if (clampChanged) onFilterChangeRef.current?.();
  }, [rawDateFilter.id, dateFilter.id]);

  // Calculate timestamps
  const timestamps = useMemo(() => {
    return toTimestampBounds(
      dateFilter.id,
      customStartDate ?? undefined,
      customEndDate ?? undefined,
    );
  }, [dateFilter.id, customStartDate, customEndDate, filterVersion]);

  return {
    dateFilter,
    customStartDate,
    customEndDate,
    setDateFilter,
    setCustomRange,
    timestamps,
  };
}
