/**
 * Project feature utilities
 */

/**
 * Format project creation date for display
 */
export function formatProjectDate(dateString: string): string {
  return new Date(dateString).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

/**
 * Get display text for trace TTL
 */
export function formatTraceTtl(days: number | null): string {
  if (days === null) return 'Forever';
  if (days === 1) return '1 day';
  return `${days} days`;
}
