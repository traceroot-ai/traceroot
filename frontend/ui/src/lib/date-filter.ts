/**
 * Date filtering utilities for trace queries.
 * Provides preset durations and timestamp conversion.
 */

export interface DateFilterOption {
  id: string;
  label: string;
  durationMinutes: number | null; // null means no time constraint or custom
  isCustom?: boolean;
}

/**
 * Available date filter presets for trace listing.
 */
export const DATE_FILTER_OPTIONS: DateFilterOption[] = [
  { id: "30m", label: "Last 30 minutes", durationMinutes: 30 },
  { id: "1h", label: "Last 1 hour", durationMinutes: 60 },
  { id: "3h", label: "Last 3 hours", durationMinutes: 180 },
  { id: "6h", label: "Last 6 hours", durationMinutes: 360 },
  { id: "1d", label: "Last 24 hours", durationMinutes: 1440 },
  { id: "7d", label: "Last 7 days", durationMinutes: 10080 },
  { id: "30d", label: "Last 30 days", durationMinutes: 43200 },
  { id: "custom", label: "Custom", durationMinutes: null, isCustom: true },
];

export const DEFAULT_DATE_FILTER = DATE_FILTER_OPTIONS.find((o) => o.id === "1d")!;

/**
 * Convert a date filter option to timestamp bounds.
 */
export function toTimestampBounds(
  optionId: string,
  customStartDate?: Date,
  customEndDate?: Date,
): {
  startAfter?: string;
  endBefore?: string;
} {
  // Handle custom date range
  if (optionId === "custom") {
    return {
      startAfter: customStartDate?.toISOString(),
      endBefore: customEndDate?.toISOString(),
    };
  }

  const option = DATE_FILTER_OPTIONS.find((opt) => opt.id === optionId);
  if (!option || option.durationMinutes === null) {
    return {};
  }

  const now = new Date();
  const start = new Date(now.getTime() - option.durationMinutes * 60 * 1000);

  return {
    startAfter: start.toISOString(),
    // No endBefore for preset filters - show all traces up to now
  };
}

/**
 * Find a date filter option by ID, with fallback to default.
 */
export function findDateFilterOption(optionId: string): DateFilterOption {
  return DATE_FILTER_OPTIONS.find((opt) => opt.id === optionId) ?? DEFAULT_DATE_FILTER;
}

/**
 * Format a date for display in the filter button (yyyy/mm/dd hh:mm).
 */
export function formatFilterDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${year}/${month}/${day} ${hours}:${minutes}`;
}

/**
 * Format a single date for range display (using UTC).
 * Format: "Feb 03, 14:55" (omit year if current year)
 */
function formatSingleDateUTC(date: Date, includeYear: boolean): string {
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  const month = months[date.getUTCMonth()];
  const day = String(date.getUTCDate()).padStart(2, "0");
  const hours = String(date.getUTCHours()).padStart(2, "0");
  const minutes = String(date.getUTCMinutes()).padStart(2, "0");

  if (includeYear) {
    const year = date.getUTCFullYear();
    return `${month} ${day} ${year}, ${hours}:${minutes}`;
  }
  return `${month} ${day}, ${hours}:${minutes}`;
}

/**
 * Format a date range for display (using UTC).
 * Format: "Feb 03, 14:55 - Feb 03, 15:55"
 * Omits year if both dates are in current year.
 */
export function formatDateRange(start: Date, end: Date): string {
  const currentYear = new Date().getUTCFullYear();
  const includeYear =
    start.getUTCFullYear() !== currentYear || end.getUTCFullYear() !== currentYear;

  return `${formatSingleDateUTC(start, includeYear)} - ${formatSingleDateUTC(end, includeYear)}`;
}
