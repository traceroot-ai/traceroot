"use client";

import { useWorkspace } from "@/features/workspaces/hooks";
import { canEditProjects } from "@/features/workspaces/utils";
import { useProject } from "./index";

/**
 * Whether the signed-in user can change things in this project; see
 * canEditProjects. False while the role loads, so a viewer never sees the
 * controls flash. True when the lookup fails: the API stays the real check.
 * Shares the project and workspace queries of the breadcrumb and the sidebar,
 * so it adds no requests.
 */
export function useCanEditProject(projectId: string): boolean {
  const project = useProject(projectId);
  const workspace = useWorkspace(project.data?.workspace_id ?? "");
  if (project.isError || workspace.isError) return true;
  return canEditProjects(workspace.data?.role);
}
