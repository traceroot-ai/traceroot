/**
 * API client for Traceroot.
 *
 * - Workspace/Project/Member/AccessKey APIs → Next.js API routes (Prisma)
 * - Trace APIs → Python backend (ClickHouse)
 */
import { getSession } from "next-auth/react";

// Python backend URL for trace APIs only
const TRACE_API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000/api/v1";

// Fetch from Next.js API routes (no auth headers needed, uses cookies)
async function fetchNextApi<T>(
  endpoint: string,
  options: RequestInit = {}
): Promise<T> {
  const response = await fetch(`/api${endpoint}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...options.headers,
    },
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: "Unknown error" }));
    throw new Error(error.error || `API error: ${response.status}`);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return response.json();
}

// Fetch from Python backend (for traces - needs user headers)
async function fetchTraceApi<T>(
  endpoint: string,
  options: RequestInit = {}
): Promise<T> {
  const session = await getSession();

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (session?.user) {
    headers["x-user-id"] = session.user.id;
    if (session.user.email) headers["x-user-email"] = session.user.email;
    if (session.user.name) headers["x-user-name"] = session.user.name;
  }

  const response = await fetch(`${TRACE_API_BASE}${endpoint}`, {
    ...options,
    headers: {
      ...headers,
      ...options.headers,
    },
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ detail: "Unknown error" }));
    throw new Error(error.detail || `API error: ${response.status}`);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return response.json();
}

// =============================================================================
// Types
// =============================================================================

export type Role = "OWNER" | "ADMIN" | "MEMBER" | "VIEWER";

export interface Workspace {
  id: string;
  name: string;
  role: Role;
  member_count?: number;
  project_count?: number;
  create_time: string;
  update_time?: string;
}

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

export interface WorkspaceWithProjects extends Workspace {
  projects: Project[];
}

export interface Member {
  id: string;
  user_id: string;
  email: string | null;
  name: string | null;
  role: Role;
  create_time: string;
}

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

// =============================================================================
// Workspace APIs (Next.js)
// =============================================================================

export async function getWorkspaces(): Promise<Workspace[]> {
  const response = await fetchNextApi<{ workspaces: Workspace[] }>("/workspaces");
  return response.workspaces;
}

export async function createWorkspace(name: string): Promise<Workspace> {
  return fetchNextApi<Workspace>("/workspaces", {
    method: "POST",
    body: JSON.stringify({ name }),
  });
}

export async function getWorkspace(workspaceId: string): Promise<WorkspaceWithProjects> {
  return fetchNextApi<WorkspaceWithProjects>(`/workspaces/${workspaceId}`);
}

export async function updateWorkspace(workspaceId: string, name: string): Promise<Workspace> {
  return fetchNextApi<Workspace>(`/workspaces/${workspaceId}`, {
    method: "PUT",
    body: JSON.stringify({ name }),
  });
}

export async function deleteWorkspace(workspaceId: string): Promise<void> {
  return fetchNextApi<void>(`/workspaces/${workspaceId}`, {
    method: "DELETE",
  });
}

// =============================================================================
// Project APIs (Next.js)
// =============================================================================

export async function getProjects(workspaceId: string): Promise<Project[]> {
  const response = await fetchNextApi<{ projects: Project[] }>(`/workspaces/${workspaceId}/projects`);
  return response.projects;
}

export async function getProject(projectId: string): Promise<Project & { workspace_id: string }> {
  return fetchNextApi<Project & { workspace_id: string }>(`/projects/${projectId}`);
}

export async function createProject(workspaceId: string, name: string, trace_ttl_days?: number): Promise<Project> {
  return fetchNextApi<Project>(`/workspaces/${workspaceId}/projects`, {
    method: "POST",
    body: JSON.stringify({ name, trace_ttl_days }),
  });
}

export async function updateProject(
  workspaceId: string,
  projectId: string,
  data: { name?: string; trace_ttl_days?: number | null }
): Promise<Project> {
  return fetchNextApi<Project>(`/workspaces/${workspaceId}/projects/${projectId}`, {
    method: "PATCH",
    body: JSON.stringify(data),
  });
}

export async function deleteProject(workspaceId: string, projectId: string): Promise<void> {
  return fetchNextApi<void>(`/workspaces/${workspaceId}/projects/${projectId}`, {
    method: "DELETE",
  });
}

// =============================================================================
// Member APIs (Next.js)
// =============================================================================

export async function getMembers(workspaceId: string): Promise<Member[]> {
  const response = await fetchNextApi<{ members: Member[] }>(`/workspaces/${workspaceId}/members`);
  return response.members;
}

export async function addMember(workspaceId: string, userId: string, role: Role): Promise<Member> {
  return fetchNextApi<Member>(`/workspaces/${workspaceId}/members`, {
    method: "POST",
    body: JSON.stringify({ userId, role }),
  });
}

export async function updateMemberRole(
  workspaceId: string,
  userId: string,
  role: Role
): Promise<Member> {
  return fetchNextApi<Member>(`/workspaces/${workspaceId}/members/${userId}`, {
    method: "PUT",
    body: JSON.stringify({ role }),
  });
}

export async function removeMember(workspaceId: string, userId: string): Promise<void> {
  return fetchNextApi<void>(`/workspaces/${workspaceId}/members/${userId}`, {
    method: "DELETE",
  });
}

// =============================================================================
// Invite APIs (Next.js)
// =============================================================================

export async function getInvites(workspaceId: string): Promise<Invite[]> {
  const response = await fetchNextApi<{ invites: Invite[] }>(`/workspaces/${workspaceId}/invites`);
  return response.invites;
}

export async function createInvite(workspaceId: string, email: string, role: Role): Promise<Invite> {
  return fetchNextApi<Invite>(`/workspaces/${workspaceId}/invites`, {
    method: "POST",
    body: JSON.stringify({ email, role }),
  });
}

export async function cancelInvite(workspaceId: string, inviteId: string): Promise<void> {
  return fetchNextApi<void>(`/workspaces/${workspaceId}/invites/${inviteId}`, {
    method: "DELETE",
  });
}

export async function acceptInvite(inviteId: string): Promise<{ workspace: { id: string; name: string }; role: Role }> {
  return fetchNextApi<{ workspace: { id: string; name: string }; role: Role }>(`/invites/${inviteId}/accept`, {
    method: "POST",
  });
}

// =============================================================================
// Access Key APIs (Next.js)
// =============================================================================

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

export async function getAccessKeys(projectId: string): Promise<{ access_keys: AccessKey[] }> {
  return fetchNextApi<{ access_keys: AccessKey[] }>(`/projects/${projectId}/api-keys`);
}

export async function createAccessKey(
  projectId: string,
  name?: string
): Promise<{ data: AccessKeyCreatedResponse }> {
  const response = await fetchNextApi<AccessKeyCreatedResponse>(`/projects/${projectId}/api-keys`, {
    method: "POST",
    body: JSON.stringify({ name: name || null }),
  });
  return { data: response };
}

export async function updateAccessKey(
  projectId: string,
  keyId: string,
  name: string | null
): Promise<AccessKey> {
  return fetchNextApi<AccessKey>(`/projects/${projectId}/api-keys/${keyId}`, {
    method: "PATCH",
    body: JSON.stringify({ name }),
  });
}

export async function deleteAccessKey(projectId: string, keyId: string): Promise<void> {
  return fetchNextApi<void>(`/projects/${projectId}/api-keys/${keyId}`, {
    method: "DELETE",
  });
}

// Legacy aliases for backward compatibility during migration
export const getOrganizations = getWorkspaces;
export const createOrganization = createWorkspace;
export const getOrganization = getWorkspace;
export const updateOrganization = updateWorkspace;
export const deleteOrganization = deleteWorkspace;
export const getApiKeys = getAccessKeys;
export const createApiKey = createAccessKey;
export const updateApiKey = updateAccessKey;
export const deleteApiKey = deleteAccessKey;
export type Organization = Workspace;
export type OrganizationWithProjects = WorkspaceWithProjects;
export type ApiKey = AccessKey;
export type ApiKeyCreatedResponse = AccessKeyCreatedResponse;

// =============================================================================
// Trace Types & APIs (Python backend - ClickHouse)
// =============================================================================

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

export async function getTraces(
  projectId: string,
  _apiKey: string,
  options: TraceQueryOptions = {}
): Promise<TraceListResponse> {
  const params = new URLSearchParams();
  if (options.page !== undefined) params.set("page", String(options.page));
  if (options.limit !== undefined) params.set("limit", String(options.limit));
  if (options.name) params.set("name", options.name);
  if (options.status) params.set("status", options.status);
  if (options.user_id) params.set("user_id", options.user_id);
  if (options.session_id) params.set("session_id", options.session_id);

  const query = params.toString();
  const endpoint = `/projects/${projectId}/traces${query ? `?${query}` : ""}`;

  return fetchTraceApi<TraceListResponse>(endpoint);
}

export async function getTrace(
  projectId: string,
  traceId: string,
  _apiKey: string
): Promise<TraceDetail> {
  return fetchTraceApi<TraceDetail>(`/projects/${projectId}/traces/${traceId}`);
}
