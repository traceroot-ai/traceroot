/**
 * API client for Traceroot backend.
 */
import { getSession } from "next-auth/react";    

const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000/api/v1";

// Get auth headers from NextAuth session                                                                                                                                                                                              
async function getAuthHeaders(): Promise<Record<string, string>> {                                                                                                                                                                     
    const session = await getSession();                                                                                                                                                                                                  
                                                                                                                                                                                                                                         
    const headers: Record<string, string> = {                                                                                                                                                                                            
      "Content-Type": "application/json",                                                                                                                                                                                                
    };                                                                                                                                                                                                                                   
                                                                                                                                                                                                                                         
    if (session?.user) {                                                                                                                                                                                                                 
      headers["x-user-id"] = session.user.id;                                                                                                                                                                                            
      if (session.user.email) headers["x-user-email"] = session.user.email;                                                                                                                                                              
      if (session.user.name) headers["x-user-name"] = session.user.name;                                                                                                                                                                 
    }                                                                                                                                                                                                                                    
                                                                                                                                                                                                                                         
    return headers;                                                                                                                                                                                                                      
}                                                                

async function fetchApi<T>(                                                                                                                                                                                                            
  endpoint: string,                                                                                                                                                                                                                    
  options: RequestInit = {}                                                                                                                                                                                                            
): Promise<T> {                                                                                                                                                                                                                        
  const headers = await getAuthHeaders();                                                                                                                                                                                              
                                                                                                                                                                                                                                       
  const response = await fetch(`${API_BASE}${endpoint}`, {                                                                                                                                                                             
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
                                                                                                                                                                                                                                       
  // Handle 204 No Content                                                                                                                                                                                                             
  if (response.status === 204) {                                                                                                                                                                                                       
    return undefined as T;                                                                                                                                                                                                             
  }                                                                                                                                                                                                                                    
                                                                                                                                                                                                                                       
  return response.json();                                                                                                                                                                                                              
} 

// Types
export type Role = "OWNER" | "ADMIN" | "MEMBER" | "VIEWER";

export interface Organization {
  id: string;
  name: string;
  role: Role;
  created_at: string;
  updated_at: string;
}

export interface Project {
  id: string;
  org_id: string;
  name: string;
  retention_days: number | null;
  created_at: string;
  updated_at: string;
}

export interface OrganizationWithProjects extends Organization {
  projects: Project[];
}

export interface Member {
  id: string;
  user_id: string;
  email: string | null;
  name: string | null;
  role: Role;
  created_at: string;
}

export interface OrganizationListResponse {
  data: Organization[];
}

export interface ProjectListResponse {
  data: Project[];
}

export interface MemberListResponse {
  data: Member[];
}

// Organization APIs
export async function getOrganizations(): Promise<Organization[]> {
  const response = await fetchApi<OrganizationListResponse>("/organizations");
  return response.data;
}

export async function createOrganization(name: string): Promise<Organization> {
  return fetchApi<Organization>("/organizations", {
    method: "POST",
    body: JSON.stringify({ name }),
  });
}

export async function getOrganization(orgId: string): Promise<OrganizationWithProjects> {
  return fetchApi<OrganizationWithProjects>(`/organizations/${orgId}`);
}

export async function updateOrganization(orgId: string, name: string): Promise<Organization> {
  return fetchApi<Organization>(`/organizations/${orgId}`, {
    method: "PUT",
    body: JSON.stringify({ name }),
  });
}

export async function deleteOrganization(orgId: string): Promise<void> {
  return fetchApi<void>(`/organizations/${orgId}`, {
    method: "DELETE",
  });
}

// Project APIs
export async function getProjects(orgId: string): Promise<Project[]> {
  const response = await fetchApi<ProjectListResponse>(`/organizations/${orgId}/projects`);
  return response.data;
}

export async function createProject(orgId: string, name: string): Promise<Project> {
  return fetchApi<Project>(`/organizations/${orgId}/projects`, {
    method: "POST",
    body: JSON.stringify({ name }),
  });
}

export async function deleteProject(orgId: string, projectId: string): Promise<void> {
  return fetchApi<void>(`/organizations/${orgId}/projects/${projectId}`, {
    method: "DELETE",
  });
}

// Member APIs
export async function getMembers(orgId: string): Promise<Member[]> {
  const response = await fetchApi<MemberListResponse>(`/organizations/${orgId}/members`);
  return response.data;
}

export async function addMember(orgId: string, email: string, role: Role): Promise<Member> {
  return fetchApi<Member>(`/organizations/${orgId}/members`, {
    method: "POST",
    body: JSON.stringify({ email, role }),
  });
}

export async function updateMemberRole(
  orgId: string,
  userId: string,
  role: Role
): Promise<Member> {
  return fetchApi<Member>(`/organizations/${orgId}/members/${userId}`, {
    method: "PUT",
    body: JSON.stringify({ role }),
  });
}

export async function removeMember(orgId: string, userId: string): Promise<void> {
  return fetchApi<void>(`/organizations/${orgId}/members/${userId}`, {
    method: "DELETE",
  });
}

// =============================================================================
// API Key Types & APIs
// =============================================================================

export interface ApiKey {
  id: string;
  project_id: string;
  key_prefix: string;
  name: string | null;
  expires_at: string | null;
  last_used_at: string | null;
  created_at: string;
}

export interface ApiKeyCreatedResponse {
  id: string;
  project_id: string;
  key_prefix: string;
  name: string | null;
  expires_at: string | null;
  last_used_at: string | null;
  created_at: string;
  key: string; // Full key, only returned once at creation
}

export interface ApiKeyListResponse {
  data: ApiKey[];
}

export async function getApiKeys(projectId: string): Promise<ApiKeyListResponse> {
  return fetchApi<ApiKeyListResponse>(`/projects/${projectId}/api-keys`);
}

export async function createApiKey(
  projectId: string,
  name?: string
): Promise<{ data: ApiKeyCreatedResponse }> {
  const response = await fetchApi<ApiKeyCreatedResponse>(`/projects/${projectId}/api-keys`, {
    method: "POST",
    body: JSON.stringify({ name: name || null }),
  });
  return { data: response };
}

export async function deleteApiKey(projectId: string, keyId: string): Promise<void> {
  return fetchApi<void>(`/projects/${projectId}/api-keys/${keyId}`, {
    method: "DELETE",
  });
}

// =============================================================================
// Trace Types & APIs
// =============================================================================

export interface TraceListItem {
  id: string;
  project_id: string;
  name: string;
  status: "ok" | "error";
  duration_ms: number;
  total_tokens: number | null;
  span_count: number;
  user_id: string | null;
  session_id: string | null;
  timestamp: string;
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
  _apiKey: string, // Reserved for future auth
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

  return fetchApi<TraceListResponse>(endpoint);
}
