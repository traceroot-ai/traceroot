/**
 * Project feature utilities
 */

/**
 * Format project creation date for display
 */
export function formatProjectDate(dateString: string): string {
  return new Date(dateString).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/**
 * Build the destination URL for switching to another project, preserving the
 * current sub-page where sensible. Settings sub-pages exist for every project
 * so they are kept; entity-specific segments (e.g. a detector id) are dropped.
 */
export function projectSwitchHref(pathname: string, targetProjectId: string): string {
  const match = pathname.match(/^\/projects\/[^/]+\/([^/]+)(?:\/([^/]+))?/);
  if (!match) return `/projects/${targetProjectId}/traces`;
  const [, subPage, nested] = match;
  if (subPage === "settings" && nested) {
    return `/projects/${targetProjectId}/settings/${nested}`;
  }
  return `/projects/${targetProjectId}/${subPage}`;
}

/**
 * Get display text for trace TTL
 */
export function formatTraceTtl(days: number | null): string {
  if (days === null) return "Forever";
  if (days === 1) return "1 day";
  return `${days} days`;
}
