/**
 * Workspace feature utilities
 */
import { Role } from "@traceroot/core";

/**
 * Format workspace creation date for display
 */
export function formatWorkspaceDate(dateString: string): string {
  return new Date(dateString).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/**
 * Get display label for role
 */
export function getRoleLabel(role: Role): string {
  const labels: Record<Role, string> = {
    ADMIN: "Admin",
    MEMBER: "Member",
    VIEWER: "Viewer",
  };
  return labels[role] || role;
}

/**
 * Check if role has admin privileges
 */
export function isAdminRole(role: Role): boolean {
  return role === Role.ADMIN;
}

/**
 * Build the destination URL for switching to another workspace, preserving
 * the current workspace sub-page (e.g. settings) where possible.
 */
export function workspaceSwitchHref(pathname: string, targetWorkspaceId: string): string {
  const match = pathname.match(/^\/workspaces\/[^/]+\/(.+)/);
  if (!match) return `/workspaces/${targetWorkspaceId}/projects`;
  return `/workspaces/${targetWorkspaceId}/${match[1]}`;
}
