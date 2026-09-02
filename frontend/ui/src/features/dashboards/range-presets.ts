import {
  DATE_FILTER_OPTIONS,
  DEFAULT_DATE_FILTER,
  findDateFilterOption,
  type DateFilterOption,
} from "@/lib/date-filter";
import { readStoredDateFilter } from "@/lib/date-filter-storage";
import type { TimeRange } from "./types";

// The widget builder's preview-window presets ARE the shared trace-list
// date-filter options (minus "custom", which needs the full range-picker UI
// the preview doesn't have). This module used to hold its own hand-rolled
// 24h/7d/30d list with a 7-day default, which silently diverged from the
// 24-hour default the trace list and dashboard page share — it is now a thin
// adapter over lib/date-filter.ts so there is exactly one source of truth for
// presets and default across all three surfaces.
export const RANGE_PRESETS = DATE_FILTER_OPTIONS.filter((o) => o.durationMinutes !== null);

// The same default the trace list and dashboard page resolve to (24 hours).
export const DEFAULT_RANGE_ID = DEFAULT_DATE_FILTER.id;

/**
 * The range the rest of the site is currently using for this project, as one
 * of this module's presets. It reads the per-project selection the shared
 * date-filter picker persists (readStoredDateFilter — the exact slot the
 * trace list, dashboards, and detectors pages write through), so a surface
 * with no picker of its own charts the window the user actually chose.
 *
 * The shared default answers for everything the stored slot can't say: no
 * project to key by, nothing stored, storage unavailable (SSR, privacy
 * modes — readStoredDateFilter swallows those), an id no preset here knows,
 * and the custom option, whose explicit start/end these preset-only surfaces
 * have no picker to represent.
 */
export function resolveSiteRange(projectId: string | null | undefined): DateFilterOption {
  if (!projectId) return DEFAULT_DATE_FILTER;
  const stored = readStoredDateFilter(projectId);
  if (stored === null) return DEFAULT_DATE_FILTER;
  return RANGE_PRESETS.find((option) => option.id === stored.id) ?? DEFAULT_DATE_FILTER;
}

export function makeRange(optionId: string): TimeRange {
  // findDateFilterOption falls back to the default option for unknown ids;
  // the ?? covers the custom option's null duration, which callers never pass
  // (RANGE_PRESETS filters custom out).
  const minutes =
    findDateFilterOption(optionId).durationMinutes ?? DEFAULT_DATE_FILTER.durationMinutes!;
  // Derive start from a single clock read so the range spans exactly the
  // preset's duration; a second read would skew it by the ms elapsed between.
  const end = new Date();
  return {
    start: new Date(end.getTime() - minutes * 60_000),
    end,
  };
}
