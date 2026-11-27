/**
 * Project feature hooks
 */
import { useCallback } from "react";
import { useQuery, type RefetchOptions } from "@tanstack/react-query";
import { getProject, getProjects } from "@/lib/api";
import { useSession } from "@/lib/auth-client";
import { ApiError } from "@/lib/api/errors";

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
    queryKey: ["project", projectId, userId],
    queryFn: () => {
      if (!userId) throw new ApiError(401, "Unauthorized");
      return getProject(projectId);
    },
    enabled: enabled && !!projectId && !identityPending,
  });
  const refetchQuery = query.refetch;
  const refetch = useCallback(
    async (options?: RefetchOptions) => {
      if (!userId) await refetchSession();
      return refetchQuery(options);
    },
    [userId, refetchSession, refetchQuery],
  );
  return { ...query, refetch };
}
