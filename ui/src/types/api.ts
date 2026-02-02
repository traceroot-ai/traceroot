/**
 * Shared API types for Traceroot UI
 */

// Role type for workspace members
export type Role = "ADMIN" | "MEMBER" | "VIEWER";

// Workspace types
export interface Workspace {
  id: string;
  name: string;
  role: Role;
  member_count?: number;
  project_count?: number;
  create_time: string;
  update_time?: string;
}

export interface WorkspaceWithProjects extends Workspace {
  projects: Project[];
}

// Project types
export interface Project {
  id: string;
  workspace_id?: string;
  name: string;
  trace_ttl_days: number | null;
  access_key_count?: number;
  delete_time?: string | null;
  create_time: string;
  update_time?: string;
}

// Member types
export interface Member {
  id: string;
  user_id: string;
  email: string | null;
  name: string | null;
  role: Role;
  create_time: string;
}

// Invite types
export interface Invite {
  id: string;
  email: string;
  role: Role;
  invited_by: {
    id: string;
    email: string | null;
    name: string | null;
  } | null;
  create_time: string;
}

// Access key types
export interface AccessKey {
  id: string;
  project_id?: string;
  key_hint: string;
  name: string | null;
  expire_time: string | null;
  last_use_time: string | null;
  create_time: string;
}

export interface AccessKeyCreatedResponse extends AccessKey {
  key: string; // Full key, only returned once at creation
}

// Trace types
export interface TraceListItem {
  trace_id: string;
  project_id: string;
  name: string;
  trace_start_time: string;
  user_id: string | null;
  session_id: string | null;
  span_count: number;
  duration_ms: number | null;
  status: "ok" | "error";
  input: string | null;
  output: string | null;
}

export interface Span {
  span_id: string;
  trace_id: string;
  parent_span_id: string | null;
  name: string;
  span_kind: string;
  span_start_time: string;
  span_end_time: string | null;
  status: string;
  status_message: string | null;
  model_name: string | null;
  cost: number | null;
  input: string | null;
  output: string | null;
}

export interface TraceDetail {
  trace_id: string;
  project_id: string;
  name: string;
  trace_start_time: string;
  user_id: string | null;
  session_id: string | null;
  environment: string;
  release: string | null;
  input: string | null;
  output: string | null;
  spans: Span[];
}

export interface TraceListResponse {
  data: TraceListItem[];
  meta: {
    page: number;
    limit: number;
    total: number;
  };
}

export interface TraceQueryOptions {
  page?: number;
  limit?: number;
  name?: string;
  status?: "ok" | "error";
  user_id?: string;
  session_id?: string;
}

// Legacy aliases for backward compatibility
export type Organization = Workspace;
export type OrganizationWithProjects = WorkspaceWithProjects;
export type ApiKey = AccessKey;
export type ApiKeyCreatedResponse = AccessKeyCreatedResponse;
