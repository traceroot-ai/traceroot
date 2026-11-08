import { NAV_GROUPS, NAV_HOME } from "@/components/layout/nav-items";

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

const EXTRA_SECTION_LABELS: Record<string, string> = { users: "Users", sessions: "Sessions" };

/**
 * The breadcrumb label of a top-level project page (`/projects/:id/signals` ->
 * "Signals"), so every section shows its own name in the header. Nested and
 * unknown pages return undefined: they pass their own `current` label.
 */
export function projectSectionLabel(pathname: string, projectId: string): string | undefined {
  const match = pathname.match(/^\/projects\/([^/]+)\/([^/]+)\/?$/);
  if (!match || match[1] !== projectId) return undefined;
  const segment = match[2];
  return (
    EXTRA_SECTION_LABELS[segment] ??
    [NAV_HOME, ...NAV_GROUPS.flatMap((g) => g.items)].find((i) => i.segment === segment)?.label
  );
}
