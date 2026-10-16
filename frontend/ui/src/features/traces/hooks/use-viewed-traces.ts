"use client";

/**
 * The trace list's read/unread state: which traces this browser has opened, kept per project in
 * localStorage (see `viewed-storage`). The list paints an unviewed trace with a leading dot, and
 * opening a trace marks it viewed, so the dot clears the moment the user looks at the row.
 *
 * The mutator writes through storage synchronously (`mergeViewedTrace`) instead of the state
 * setter's write, which React defers to a later commit: the entry is live in every tab on the
 * project, so a deferred write would widen the window in which another tab's mark can be dropped.
 */
import { useCallback, useMemo } from "react";
import { readStored, useLocalStorage, writeStored } from "@/lib/hooks/use-local-storage";
import {
  mergeViewedTrace,
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
      const key = viewedTracesKey(projectId);
      // Read and write the live entry directly, so the read-modify-write is synchronous and the
      // merge can re-read if another tab raced us. `stored` is the fallback when storage is
      // unavailable (private mode), where the merge still returns a usable list.
      const merged = mergeViewedTrace(
        {
          read: () => normalizeViewedTraces(readStored(key, stored)),
          write: (ids) => writeStored(key, toStoredViewedTraces(ids)),
        },
        traceId,
      );
      // Mirror the merged list into React state so the list re-renders. The setter rewrites the
      // same bytes; harmless, and it keeps the in-session value correct if storage is unavailable.
      setStored(toStoredViewedTraces(merged));
    },
    [projectId, setStored, stored],
  );

  return { viewedTraceIds, markViewed };
}
