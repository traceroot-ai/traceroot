import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Format duration in milliseconds to human readable string.
 * e.g., 1500 -> "1.5s", 150 -> "150ms", 65000 -> "1m 5s"
 */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "-";

  if (ms < 1000) {
    return `${Math.round(ms)}ms`;
  }

  if (ms < 60000) {
    return `${(ms / 1000).toFixed(1)}s`;
  }

  const minutes = Math.floor(ms / 60000);
  const seconds = Math.round((ms % 60000) / 1000);
  return `${minutes}m ${seconds}s`;
}

/**
 * Format token count to human readable string.
 * e.g., 1500 -> "1.5k", 1500000 -> "1.5M"
 */
export function formatTokens(count: number | null | undefined): string {
  if (count === null || count === undefined) return "-";

  if (count < 1000) {
    return String(count);
  }

  if (count < 1000000) {
    return `${(count / 1000).toFixed(1)}k`;
  }

  return `${(count / 1000000).toFixed(1)}M`;
}

/**
 * Parse a date string as UTC.
 * Backend sends timestamps without timezone marker, but they are UTC.
 */
function parseAsUTC(date: string | Date): Date {
  if (date instanceof Date) return date;

  // If the string doesn't have timezone info, treat it as UTC
  if (!date.endsWith("Z") && !date.includes("+") && !/\d{2}:\d{2}$/.test(date.slice(-6))) {
    return new Date(date + "Z");
  }
  return new Date(date);
}

/**
 * Format date to relative time string.
 * e.g., "2 minutes ago", "3 hours ago", "yesterday"
 */
export function formatRelativeTime(date: string | Date | null | undefined): string {
  if (!date) return "-";

  const now = new Date();
  const then = parseAsUTC(date);
  const diffMs = now.getTime() - then.getTime();
  const diffSeconds = Math.floor(diffMs / 1000);
  const diffMinutes = Math.floor(diffSeconds / 60);
  const diffHours = Math.floor(diffMinutes / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffSeconds < 60) {
    return "just now";
  }

  if (diffMinutes < 60) {
    return `${diffMinutes} minute${diffMinutes === 1 ? "" : "s"} ago`;
  }

  if (diffHours < 24) {
    return `${diffHours} hour${diffHours === 1 ? "" : "s"} ago`;
  }

  if (diffDays === 1) {
    return "yesterday";
  }

  if (diffDays < 7) {
    return `${diffDays} days ago`;
  }

  // For older dates, show the actual date
  return then.toLocaleDateString();
}

/**
 * Format date to a readable string in local timezone.
 * e.g., "2026-01-29 15:39:51" (displayed in user's local time)
 */
export function formatDate(date: string | Date | null | undefined): string {
  if (!date) return "-";

  const d = parseAsUTC(date);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const hours = String(d.getHours()).padStart(2, "0");
  const minutes = String(d.getMinutes()).padStart(2, "0");
  const seconds = String(d.getSeconds()).padStart(2, "0");
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

/**
 * Format cost to human readable string with appropriate precision.
 * e.g., 0.000123 -> "$0.000123", 0.0523 -> "$0.0523", 1.50 -> "$1.50"
 */
export function formatCost(cost: number | null | undefined): string {
  if (cost === null || cost === undefined || cost === 0) return "-";
  if (cost < 0.01) return `$${cost.toFixed(6)}`;
  if (cost < 1) return `$${cost.toFixed(4)}`;
  return `$${cost.toFixed(2)}`;
}
