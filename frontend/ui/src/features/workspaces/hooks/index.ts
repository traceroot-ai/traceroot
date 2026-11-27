/**
 * Workspace feature hooks
 */
import { useQuery, type UseQueryOptions } from "@tanstack/react-query";
import { getWorkspaces, getWorkspace } from "@/lib/api";
import { useSession } from "@/lib/auth-client";
import type { Workspace, WorkspaceWithProjects } from "@/types/api";

// Refresh ingestion dates while a workspace or project table is visible.
export const ACTIVITY_REFRESH_INTERVAL_MS = 30_000;

/**
 * Hook for fetching all workspaces for the current user
 */
export function useWorkspaces(
  enabled: boolean = true,
  queryOptions: Pick<UseQueryOptions<Workspace[]>, "refetchInterval" | "refetchOnMount"> = {},
) {
  return useQuery({
    queryKey: ["workspaces"],
    queryFn: getWorkspaces,
    enabled,
    ...queryOptions,
  });
}

/**
 * Hook for fetching a single workspace with its projects
 */
export function useWorkspace(
  workspaceId: string,
  enabled: boolean = true,
  queryOptions: Pick<
    UseQueryOptions<WorkspaceWithProjects>,
    "refetchInterval" | "refetchOnMount"
  > = {},
) {
  const { data: session, isPending: sessionPending } = useSession();
  const userId = sessionPending ? undefined : session?.user.id;
  return useQuery({
    queryKey: ["workspace", workspaceId, userId],
    queryFn: () => getWorkspace(workspaceId),
    enabled: enabled && !!workspaceId && !!userId,
    ...queryOptions,
  });
}
