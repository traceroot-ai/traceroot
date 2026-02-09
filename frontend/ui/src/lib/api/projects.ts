/**
 * Project API functions
 */
import { fetchNextApi } from "./client";
import type { Project } from "@/types/api";

export async function getProjects(workspaceId: string): Promise<Project[]> {
  const response = await fetchNextApi<{ projects: Project[] }>(
    `/workspaces/${workspaceId}/projects`,
  );
  return response.projects;
}

export async function getProject(projectId: string): Promise<Project & { workspace_id: string }> {
  return fetchNextApi<Project & { workspace_id: string }>(`/projects/${projectId}`);
}

export async function createProject(
  workspaceId: string,
  name: string,
  trace_ttl_days?: number,
): Promise<Project> {
  return fetchNextApi<Project>(`/workspaces/${workspaceId}/projects`, {
    method: "POST",
    body: JSON.stringify({ name, trace_ttl_days }),
  });
}

export async function updateProject(
  workspaceId: string,
  projectId: string,
  data: { name?: string; trace_ttl_days?: number | null },
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
