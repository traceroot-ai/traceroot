/**
 * Shared API types for TraceRoot UI
 */

import type { Role, SpanKind, SpanStatus, TraceStatus } from "@traceroot/core";

export type { Role };

// Usage stats (cached, updated hourly by billing worker)
export interface UsageStats {
  traces: number;
  spans: number;
  tokens: number;
  updatedAt: string;
  ai?: AIUsageData;
}

// Workspace types
export interface Workspace {
  id: string;
  name: string;
  role: Role;
  member_count?: number;
  project_count?: number;
  create_time: string;
  update_time?: string;
  // Billing fields
  billingPlan?: string;
  billingCustomerId?: string | null;
  billingSubscriptionId?: string | null;
  billingStatus?: string | null;
  currentUsage?: UsageStats | null;
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
  status: TraceStatus;
  input: string | null;
  output: string | null;
  total_input_tokens?: number;
  total_output_tokens?: number;
  total_cost?: number;
}

export interface Span {
  span_id: string;
  trace_id: string;
  parent_span_id: string | null;
  name: string;
  span_kind: SpanKind;
  span_start_time: string;
  span_end_time: string | null;
  status: SpanStatus;
  status_message: string | null;
  model_name: string | null;
  cost: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
  input: string | null;
  output: string | null;
  metadata: string | null;
  git_source_file: string | null;
  git_source_line: number | null;
  git_source_function: string | null;
  pending?: boolean;
}

export interface TraceDetail {
  trace_id: string;
  project_id: string;
  name: string;
  trace_start_time: string;
  user_id: string | null;
  session_id: string | null;
  git_ref: string | null;
  git_repo: string | null;
  environment: string;
  release: string | null;
  input: string | null;
  output: string | null;
  metadata: string | null;
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
  status?: TraceStatus;
  user_id?: string;
  session_id?: string;
  // Date range filtering
  start_after?: string; // ISO timestamp - filter traces after this time
  end_before?: string; // ISO timestamp - filter traces before this time
  // Multi-field keyword search (searches trace_id, name, session_id, user_id)
  search_query?: string;
}

// Session types
export interface SessionListItem {
  session_id: string;
  trace_count: number;
  user_ids: string[];
  first_trace_time: string | null;
  last_trace_time: string | null;
  duration_ms: number | null;
  total_input_tokens: number | null;
  total_output_tokens: number | null;
  total_cost?: number | null;
  input: string | null;
  output: string | null;
}

export interface SessionListResponse {
  data: SessionListItem[];
  meta: { page: number; limit: number; total: number };
}

export interface SessionTraceItem {
  trace_id: string;
  name: string;
  trace_start_time: string;
  user_id: string | null;
  input: string | null;
  output: string | null;
  duration_ms: number | null;
  status: string;
}

export interface SessionDetailResponse {
  session_id: string;
  traces: SessionTraceItem[];
  user_ids: string[];
  trace_count: number;
  first_trace_time: string | null;
  last_trace_time: string | null;
  duration_ms: number | null;
  total_input_tokens: number | null;
  total_output_tokens: number | null;
  total_cost?: number | null;
}

export interface SessionQueryOptions {
  page?: number;
  limit?: number;
  search_query?: string;
  start_after?: string;
  end_before?: string;
}

// AI token usage stats (nested in UsageStats.ai)
export interface AIUsageCategory {
  messages: number;
  inputTokens: number;
  outputTokens: number;
  cost: number;
}

export interface AIUsageByModel extends AIUsageCategory {
  model: string;
  provider: string;
  isByok: boolean;
}

export interface AIUsageData {
  runsUsed: number;
  systemUsage: AIUsageCategory;
  byokUsage: AIUsageCategory;
  byModel: AIUsageByModel[];
}

// Legacy aliases for backward compatibility
export type Organization = Workspace;
export type OrganizationWithProjects = WorkspaceWithProjects;
export type ApiKey = AccessKey;
export type ApiKeyCreatedResponse = AccessKeyCreatedResponse;
