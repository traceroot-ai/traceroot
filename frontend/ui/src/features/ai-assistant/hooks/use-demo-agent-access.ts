"use client";

import { useSession } from "@/lib/auth-client";
import { useQuery } from "@tanstack/react-query";
import { getProject, getWorkspace } from "@/lib/api";
import { isDemoWorkspaceViewer } from "@/features/workspaces/utils";

export function useDemoAgentAccess(projectId?: string) {
  const { data: session, isPending: sessionPending } = useSession();
  const userId = session?.user.id;
  const { data: project, isPending: projectPending } = useQuery({
    queryKey: ["project", projectId, "demo-agent-access", userId],
    queryFn: () => getProject(projectId!),
    enabled: !!projectId && !!userId,
  });
  const workspaceId = project?.workspace_id;
  const { data: workspace, isPending: workspacePending } = useQuery({
    queryKey: ["workspace", workspaceId, "demo-agent-access", userId],
    queryFn: () => getWorkspace(workspaceId!),
    enabled: !!workspaceId && !!userId,
  });
  return {
    readOnly: isDemoWorkspaceViewer(workspace),
    loading:
      !!sessionPending ||
      (!!userId && !!projectId && !!projectPending) ||
      (!!userId && !!workspaceId && !!workspacePending),
  };
}
