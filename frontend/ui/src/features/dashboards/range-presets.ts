import type { TimeRange } from "./types";

// Range presets for the widget builder's preview window (the dashboard page
// itself uses the shared trace-list date filter).
export const RANGE_PRESETS = [
  { label: "Last 24 hours", days: 1 },
  { label: "Last 7 days", days: 7 },
  { label: "Last 30 days", days: 30 },
] as const;

export function makeRange(days: number): TimeRange {
  return {
    start: new Date(Date.now() - days * 86_400_000),
    end: new Date(),
  };
}
