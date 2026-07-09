import { DATE_FILTER_OPTIONS, DEFAULT_DATE_FILTER, findDateFilterOption } from "@/lib/date-filter";
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

export function makeRange(optionId: string): TimeRange {
  // findDateFilterOption falls back to the default option for unknown ids;
  // the ?? covers the custom option's null duration, which callers never pass
  // (RANGE_PRESETS filters custom out).
  const minutes =
    findDateFilterOption(optionId).durationMinutes ?? DEFAULT_DATE_FILTER.durationMinutes!;
  return {
    start: new Date(Date.now() - minutes * 60_000),
    end: new Date(),
  };
}
