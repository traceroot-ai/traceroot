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
 * Format date to relative time string.
 * e.g., "2 minutes ago", "3 hours ago", "yesterday"
 */
export function formatRelativeTime(date: string | Date | null | undefined): string {
  if (!date) return "-";

  const now = new Date();
  const then = typeof date === "string" ? new Date(date) : date;
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
