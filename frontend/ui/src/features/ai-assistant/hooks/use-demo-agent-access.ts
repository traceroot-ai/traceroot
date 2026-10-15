"use client";

import { useQuery } from "@tanstack/react-query";
import { getProject, getWorkspace } from "@/lib/api";
import { isDemoWorkspaceViewer } from "@/features/workspaces/utils";

export function useDemoAgentAccess(projectId?: string) {
  const { data: project } = useQuery({
    queryKey: ["project", projectId],
    queryFn: () => getProject(projectId!),
    enabled: !!projectId,
  });
  const workspaceId = project?.workspace_id;
  const { data: workspace } = useQuery({
    queryKey: ["workspace", workspaceId],
    queryFn: () => getWorkspace(workspaceId!),
    enabled: !!workspaceId,
  });
  return {
    readOnly: isDemoWorkspaceViewer(workspace),
    loading: !!projectId && !workspace,
  };
}
