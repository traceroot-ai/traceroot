/**
 * Best-effort persistence of a list page's selected date filter in
 * localStorage, so the user's time-range choice survives every way of
 * returning to the page (sidebar link, browser back, in-app navigation,
 * full reload) — not just an in-page back button.
 *
 * Opt-in per page via a stable `key`. Storage I/O reuses the shared SSR-guarded
 * helpers in use-local-storage; failures are swallowed there, so persistence
 * never blocks rendering. See issue #951.
 */
import {
  DATE_FILTER_OPTIONS,
  findDateFilterOption,
  type DateFilterOption,
} from "@/lib/date-filter";
import { readStored, writeStored } from "@/lib/hooks/use-local-storage";

const STORAGE_PREFIX = "traceroot.dateFilter.";

interface StoredDateFilter {
  id: string;
  // ISO strings, present only for the custom range.
  start?: string;
  end?: string;
}

export interface RestoredDateFilter {
  option: DateFilterOption;
  customStart: Date | null;
  customEnd: Date | null;
}

/**
 * Persist the selected date filter for `key`. Custom ranges also store their
 * start/end instants. No-op on the server or when localStorage is unavailable.
 */
export function persistDateFilter(
  key: string,
  option: DateFilterOption,
  customStart: Date | null,
  customEnd: Date | null,
): void {
  const payload: StoredDateFilter = { id: option.id };
  if (option.isCustom && customStart && customEnd) {
    payload.start = customStart.toISOString();
    payload.end = customEnd.toISOString();
  }
  writeStored(STORAGE_PREFIX + key, payload);
}

/**
 * Read the persisted date filter for `key`. Returns null when nothing is
 * stored, the payload is malformed, the stored id is not a known filter option
 * (e.g. removed/renamed in a later build), or a stored custom range is
 * incomplete or has unparseable dates — so the caller falls back to its own
 * default rather than a silently-wrong window.
 */
export function readPersistedDateFilter(key: string): RestoredDateFilter | null {
  const stored = readStored<StoredDateFilter | null>(STORAGE_PREFIX + key, null);
  if (!stored || typeof stored.id !== "string") return null;

  // findDateFilterOption silently returns the default for an unknown id, which
  // would downgrade the user's window without signal — reject it instead.
  if (!DATE_FILTER_OPTIONS.some((o) => o.id === stored.id)) return null;
  const option = findDateFilterOption(stored.id);

  if (option.isCustom) {
    if (!stored.start || !stored.end) return null;
    const start = new Date(stored.start);
    const end = new Date(stored.end);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
    return { option, customStart: start, customEnd: end };
  }

  return { option, customStart: null, customEnd: null };
}
