/**
 * API module index - re-exports all API functions and types
 */

// Client utilities
export { fetchNextApi, fetchTraceApi } from "./client";

// Workspace APIs
export {
  getWorkspaces,
  createWorkspace,
  getWorkspace,
  updateWorkspace,
  deleteWorkspace,
  // Legacy aliases
  getOrganizations,
  createOrganization,
  getOrganization,
  updateOrganization,
  deleteOrganization,
} from "./workspaces";

// Project APIs
export { getProjects, getProject, createProject, updateProject, deleteProject } from "./projects";

// Member APIs
export { getMembers, addMember, updateMemberRole, removeMember } from "./members";

// Invite APIs
export { getInvites, createInvite, cancelInvite, acceptInvite } from "./invites";

// Access Key APIs
export {
  getAccessKeys,
  createAccessKey,
  updateAccessKey,
  deleteAccessKey,
  // Legacy aliases
  getApiKeys,
  createApiKey,
  updateApiKey,
  deleteApiKey,
} from "./access-keys";

// Trace APIs
export { getTraces, getTrace } from "./traces";

// Re-export all types from types/api.ts for backward compatibility
export type {
  Role,
  Workspace,
  WorkspaceWithProjects,
  Project,
  Member,
  Invite,
  AccessKey,
  AccessKeyCreatedResponse,
  TraceListItem,
  Span,
  TraceDetail,
  TraceListResponse,
  TraceQueryOptions,
  // Legacy type aliases
  Organization,
  OrganizationWithProjects,
  ApiKey,
  ApiKeyCreatedResponse,
} from "@/types/api";
