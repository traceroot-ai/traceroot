/**
 * Workspace settings hooks
 * Local hooks to avoid cross-feature imports
 */
import { useQuery } from "@tanstack/react-query";
import { getWorkspace } from "@/lib/api";

/**
 * Hook for fetching a workspace in settings context
 */
export function useWorkspace(workspaceId: string, enabled: boolean = true) {
  return useQuery({
    queryKey: ["workspace", workspaceId],
    queryFn: () => getWorkspace(workspaceId),
    enabled: enabled && !!workspaceId,
  });
}
