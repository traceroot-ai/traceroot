/**
 * Workspace API functions
 */
import { fetchNextApi } from "./client";
import type { Workspace, WorkspaceWithProjects } from "@/types/api";

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

// Legacy aliases
export const getOrganizations = getWorkspaces;
export const createOrganization = createWorkspace;
export const getOrganization = getWorkspace;
export const updateOrganization = updateWorkspace;
export const deleteOrganization = deleteWorkspace;
