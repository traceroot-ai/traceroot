import { Role } from "../constants";

export type { Role };

const ROLE_ORDER = [Role.VIEWER, Role.MEMBER, Role.ADMIN] as const;

/**
 * Check if a role meets the minimum required role.
 */
export function hasMinRole(userRole: Role, minRole: Role): boolean {
  const userIndex = ROLE_ORDER.indexOf(userRole);
  const minIndex = ROLE_ORDER.indexOf(minRole);
  return userIndex >= minIndex;
}

// API Response Types
export interface ApiError {
  error: string;
}

export interface ApiSuccess<T> {
  data: T;
}

// Access Key Types
export interface AccessKeyPublic {
  id: string;
  key_hint: string;
  name: string | null;
  expire_time: Date | null;
  last_use_time: Date | null;
  create_time: Date;
}

export interface AccessKeyCreateResponse extends AccessKeyPublic {
  key: string; // Full key, only returned on creation
}

// Workspace Types
export interface WorkspaceSummary {
  id: string;
  name: string;
  role: Role;
  projectCount: number;
  memberCount: number;
}

// Project Types
export interface ProjectSummary {
  id: string;
  name: string;
  workspace_id: string;
  trace_ttl_days: number | null;
  create_time: Date;
}

// User Types
export interface UserPublic {
  id: string;
  email: string | null;
  name: string | null;
}

export interface WorkspaceMemberPublic {
  user: UserPublic;
  role: Role;
  joined_at: Date;
}
