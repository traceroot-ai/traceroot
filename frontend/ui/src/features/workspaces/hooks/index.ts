/**
 * Workspace feature hooks
 */
import { useCallback } from "react";
import { useQuery, type UseQueryOptions } from "@tanstack/react-query";
import { getWorkspaces, getWorkspace } from "@/lib/api";
import { useSession } from "@/lib/auth-client";
import { ApiError } from "@/lib/api/errors";
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
  const {
    data: session,
    isPending: sessionPending,
    isRefetching: sessionRefetching,
    error: sessionError,
    refetch: refetchSession,
  } = useSession();
  const identityPending = sessionPending || sessionRefetching;
  const userId = identityPending || sessionError ? undefined : session?.user.id;
  const query = useQuery({
    queryKey: ["workspace", workspaceId, userId],
    queryFn: () => {
      if (!userId) throw new ApiError(401, "Unauthorized");
      return getWorkspace(workspaceId);
    },
    enabled: enabled && !!workspaceId && !identityPending,
    ...queryOptions,
  });
  const refetchQuery = query.refetch;
  const refetch = useCallback(
    async (options?: Parameters<typeof query.refetch>[0]) => {
      if (!userId) await refetchSession();
      return refetchQuery(options);
    },
    [userId, refetchSession, refetchQuery],
  );
  return { ...query, refetch };
}
