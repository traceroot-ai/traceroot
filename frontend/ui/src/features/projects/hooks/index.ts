/**
 * Project feature hooks
 */
import { useQuery } from "@tanstack/react-query";
import { getProject, getProjects } from "@/lib/api";
import { useSession } from "@/lib/auth-client";

/**
 * Hook for fetching projects in a workspace
 */
export function useProjects(workspaceId: string, enabled: boolean = true) {
  return useQuery({
    queryKey: ["projects", workspaceId],
    queryFn: () => getProjects(workspaceId),
    enabled: enabled && !!workspaceId,
  });
}

/**
 * Hook for fetching a single project
 */
export function useProject(projectId: string, enabled: boolean = true) {
  const { data: session, isPending: sessionPending } = useSession();
  const userId = sessionPending ? undefined : session?.user.id;
  return useQuery({
    queryKey: ["project", projectId, userId],
    queryFn: () => getProject(projectId),
    enabled: enabled && !!projectId && !!userId,
  });
}
