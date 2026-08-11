"use client";

/**
 * Column visibility for the trace list, persisted per project. The list shows fixed registry
 * columns only: which ones is entirely the user's choice in the column picker, and nothing
 * else — a filter included — puts a column on screen.
 */
import { useCallback, useMemo } from "react";
import { useLocalStorage } from "@/lib/hooks/use-local-storage";
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
      // Normalizes the previous entry rather than the rendered selection: the entry is live in
      // every tab on the project, so the value being flipped has to be the one on disk now.
      setStored((previous) => {
        const flipped = normalizeColumns(previous);
        return toStoredColumns(
          flipped.includes(id) ? flipped.filter((existing) => existing !== id) : [...flipped, id],
        );
      });
    },
    [setStored],
  );

  const reset = useCallback(() => setStored(NO_COLUMNS), [setStored]);

  return { visibleColumns, toggleField, reset };
}
