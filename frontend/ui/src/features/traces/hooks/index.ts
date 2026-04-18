/**
 * Trace feature hooks
 */
import { useQuery } from "@tanstack/react-query";
import { useSession as useAuthSession } from "@/lib/auth-client";
import { getTraces, getTrace } from "@/lib/api";
import { getSessions, getSession, type SessionDetailOptions } from "@/lib/api/sessions";
import { getUsers, type UserQueryOptions } from "@/lib/api/users";
import type { SessionQueryOptions, TraceQueryOptions } from "@/types/api";
import type { TraceApiUser } from "@/lib/api/client";

// Individual state hooks (for fine-grained control)
export { usePagination } from "./use-pagination";
export { useDateFilter } from "./use-date-filter";
export { useKeywordSearch } from "./use-keyword-search";
export { useUrlDateFilter } from "./use-url-date-filter";
export { useUrlPagination } from "./use-url-pagination";

// Composed state hooks
export { useTraceListState } from "./use-trace-list-state";
// URL-synced version for shared date filter across pages
export { useListPageState } from "./use-list-page-state";

// Live trace streaming
export { useTraceStream } from "./use-trace-stream";

/**
 * Hook for fetching paginated traces list
 */
export function useTraces(
  projectId: string,
  options: TraceQueryOptions = {},
  queryOptions: {
    staleTime?: number;
    refetchInterval?: number | false | ((query: unknown) => number | false);
  } = {},
) {
  const { data: authSession, isPending } = useAuthSession();
  const sessionReady = !isPending && !!authSession?.user;
  const user: TraceApiUser | undefined = authSession?.user
    ? { id: authSession.user.id, email: authSession.user.email }
    : undefined;
  return useQuery({
    queryKey: [
      "traces",
      projectId,
      options.page,
      options.limit,
      options.search_query,
      options.start_after,
      options.end_before,
      options.user_id,
      options.session_id,
    ],
    queryFn: () => getTraces(projectId, "", options, user),
    enabled: sessionReady && !!projectId,
    ...queryOptions,
  });
}

/**
 * Hook for fetching a single trace with its spans
 */
export function useTrace(projectId: string, traceId: string, enabled: boolean = true) {
  const { data: authSession, isPending } = useAuthSession();
  const sessionReady = !isPending && !!authSession?.user;
  const user: TraceApiUser | undefined = authSession?.user
    ? { id: authSession.user.id, email: authSession.user.email }
    : undefined;
  return useQuery({
    queryKey: ["trace", projectId, traceId],
    queryFn: () => getTrace(projectId, traceId, "", user),
    enabled: sessionReady && enabled,
  });
}

/**
 * Hook for fetching paginated users list
 */
export function useUsers(projectId: string, options: UserQueryOptions = {}) {
  const { data: authSession, isPending } = useAuthSession();
  const sessionReady = !isPending && !!authSession?.user;
  const user: TraceApiUser | undefined = authSession?.user
    ? { id: authSession.user.id, email: authSession.user.email }
    : undefined;
  return useQuery({
    queryKey: [
      "users",
      projectId,
      options.page,
      options.limit,
      options.search_query,
      options.start_after,
      options.end_before,
    ],
    queryFn: () => getUsers(projectId, options, user),
    enabled: sessionReady && !!projectId,
  });
}

/**
 * Hook for fetching paginated sessions list
 */
export function useSessions(projectId: string, options: SessionQueryOptions = {}) {
  const { data: authSession, isPending } = useAuthSession();
  const sessionReady = !isPending && !!authSession?.user;
  const user: TraceApiUser | undefined = authSession?.user
    ? { id: authSession.user.id, email: authSession.user.email }
    : undefined;
  return useQuery({
    queryKey: [
      "sessions",
      projectId,
      options.page,
      options.limit,
      options.search_query,
      options.start_after,
      options.end_before,
    ],
    queryFn: () => getSessions(projectId, options, user),
    enabled: sessionReady && !!projectId,
  });
}

/**
 * Hook for fetching a single session detail
 */
export function useSession(
  projectId: string,
  sessionId: string,
  options: SessionDetailOptions = {},
  enabled: boolean = true,
) {
  const { data: authSession, isPending } = useAuthSession();
  const sessionReady = !isPending && !!authSession?.user;
  const user: TraceApiUser | undefined = authSession?.user
    ? { id: authSession.user.id, email: authSession.user.email }
    : undefined;
  return useQuery({
    queryKey: ["session", projectId, sessionId, options.start_after, options.end_before],
    queryFn: () => getSession(projectId, sessionId, options, user),
    enabled: sessionReady && enabled,
  });
}
