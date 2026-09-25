"use client";

/**
 * Column visibility for the trace list, persisted per project. The list shows fixed registry
 * columns only: which ones is entirely the user's choice in the column picker, and nothing
 * else — a filter included — puts a column on screen.
 */
import { useCallback, useMemo } from "react";
import { readStored, useLocalStorage } from "@/lib/hooks/use-local-storage";
import { visibleFixedColumns, type FixedColumnId } from "@/features/traces/columns";
import {
  columnsStorageKey,
  normalizeColumns,
  toStoredColumns,
  NO_COLUMNS,
  type StoredColumns,
} from "@/features/traces/column-storage";

export interface UseTraceColumnsReturn {
  /** Fixed columns to render, already resolved against the defaults, in registry order. */
  visibleColumns: FixedColumnId[];
  toggleField: (id: FixedColumnId) => void;
  reset: () => void;
}

export function useTraceColumns(projectId: string): UseTraceColumnsReturn {
  const [stored, setStored] = useLocalStorage<StoredColumns>(
    columnsStorageKey(projectId),
    NO_COLUMNS,
  );

  const visibleColumns = useMemo(() => visibleFixedColumns(normalizeColumns(stored)), [stored]);

  const toggleField = useCallback(
    (id: FixedColumnId) => {
      // Flips the entry on disk rather than the rendered selection. The entry is live in every
      // tab on the project, and `useLocalStorage` only catches up on a `storage` event, which
      // the writing tab queues rather than delivering with the write — so between another tab's
      // toggle and that event this tab's state is a version behind, and flipping it would write
      // back a selection missing that tab's column.
      //
      // Read here rather than inside the setter's updater: StrictMode invokes an updater twice
      // and the setter persists on every call, so a read inside it would see its own first write
      // and flip the value straight back. `stored` is the fallback so that a browser where
      // storage is unavailable keeps toggling against the in-session value.
      const current = normalizeColumns(
        readStored<StoredColumns>(columnsStorageKey(projectId), stored),
      );
      setStored(
        toStoredColumns(
          current.includes(id) ? current.filter((existing) => existing !== id) : [...current, id],
        ),
      );
    },
    [projectId, setStored, stored],
  );

  const reset = useCallback(() => setStored(NO_COLUMNS), [setStored]);

  return { visibleColumns, toggleField, reset };
}
