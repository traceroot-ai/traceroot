"use client";

/**
 * The trace list's read/unread state: which traces this browser has opened, kept per project in
 * localStorage (see `viewed-storage`). The list paints an unviewed trace with a leading dot, and
 * opening a trace marks it viewed, so the dot clears the moment the user looks at the row.
 *
 * The mutator reads the live localStorage entry, not this tab's React state, before adding: the
 * entry is live in every tab on the project, and a `storage` event reaches the other tabs only
 * after the write, so in that window this tab's state is a version behind. Adding to the stale
 * state would write back a list missing the other tab's trace and turn its dot on again. This is
 * the same reason `useTraceColumns` reads before it writes.
 */
import { useCallback, useMemo } from "react";
import { readStored, useLocalStorage } from "@/lib/hooks/use-local-storage";
import {
  addViewedTrace,
  NO_VIEWED_TRACES,
  normalizeViewedTraces,
  toStoredViewedTraces,
  viewedTracesKey,
  type StoredViewedTraces,
} from "@/features/traces/viewed-storage";

export interface UseViewedTracesReturn {
  /** The trace ids this browser has opened, for the list to compare rows against. */
  viewedTraceIds: ReadonlySet<string>;
  markViewed: (traceId: string) => void;
}

export function useViewedTraces(projectId: string): UseViewedTracesReturn {
  const [stored, setStored] = useLocalStorage<StoredViewedTraces>(
    viewedTracesKey(projectId),
    NO_VIEWED_TRACES,
  );

  const viewedTraceIds = useMemo(() => new Set(normalizeViewedTraces(stored)), [stored]);

  const markViewed = useCallback(
    (traceId: string) => {
      if (traceId === "") return;
      // Read on disk, falling back to this tab's state when storage is unavailable. The read is
      // here rather than inside the setter's updater because the setter persists on every call,
      // so a read inside it would see its own first write on a StrictMode double-invoke.
      const current = normalizeViewedTraces(readStored(viewedTracesKey(projectId), stored));
      // Already the most recent viewing: nothing to write, so the open trace does not rewrite
      // storage or re-render the list on every selection.
      if (current[0] === traceId) return;
      setStored(toStoredViewedTraces(addViewedTrace(current, traceId)));
    },
    [projectId, setStored, stored],
  );

  return { viewedTraceIds, markViewed };
}
