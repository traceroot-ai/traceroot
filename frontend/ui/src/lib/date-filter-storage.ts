import { readStored, writeStored } from "@/lib/hooks/use-local-storage";

/**
 * Per-project, per-browser persistence for the shared date-filter selection.
 * Every windowed surface (trace list, dashboards, detectors, the widget
 * builder's preview) reads and writes the same slot, so picking a range on
 * one page carries to all of them. An explicit `?date_filter=` URL parameter
 * still wins on the page it targets — shared links show the sender's view —
 * but only a user action writes the preference.
 */
export interface StoredDateFilter {
  id: string;
  /** ISO timestamps, present only when id === "custom". */
  start?: string;
  end?: string;
}

export function dateFilterStorageKey(projectId: string): string {
  return `traceroot:date-filter:v1:${projectId}`;
}

export function readStoredDateFilter(projectId: string): StoredDateFilter | null {
  const stored = readStored<StoredDateFilter | null>(dateFilterStorageKey(projectId), null);
  if (!stored || typeof stored.id !== "string") return null;
  return stored;
}

export function writeStoredDateFilter(projectId: string, value: StoredDateFilter): void {
  writeStored(dateFilterStorageKey(projectId), value);
}
