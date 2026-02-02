/**
 * Workspace feature utilities
 */
import type { Role } from '@/types/api';

/**
 * Format workspace creation date for display
 */
export function formatWorkspaceDate(dateString: string): string {
  return new Date(dateString).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

/**
 * Get display label for role
 */
export function getRoleLabel(role: Role): string {
  const labels: Record<Role, string> = {
    ADMIN: 'Admin',
    MEMBER: 'Member',
    VIEWER: 'Viewer',
  };
  return labels[role] || role;
}

/**
 * Check if role has admin privileges
 */
export function isAdminRole(role: Role): boolean {
  return role === 'ADMIN';
}
