/**
 * Workspace feature hooks
 */
import { useQuery } from "@tanstack/react-query";
import { getWorkspaces, getWorkspace } from "@/lib/api";

/**
 * Hook for fetching all workspaces for the current user
 */
export function useWorkspaces(enabled: boolean = true) {
  return useQuery({
    queryKey: ["workspaces"],
    queryFn: getWorkspaces,
    enabled,
  });
}

/**
 * Hook for fetching a single workspace with its projects
 */
export function useWorkspace(workspaceId: string, enabled: boolean = true) {
  return useQuery({
    queryKey: ["workspace", workspaceId],
    queryFn: () => getWorkspace(workspaceId),
    enabled: enabled && !!workspaceId,
  });
}
