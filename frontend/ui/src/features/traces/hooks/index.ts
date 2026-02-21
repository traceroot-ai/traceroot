/**
 * Trace feature hooks
 */
import { useQuery } from "@tanstack/react-query";
import { getTraces, getTrace } from "@/lib/api";
import { getSessions, getSession } from "@/lib/api/sessions";
import { getUsers, type UserQueryOptions } from "@/lib/api/users";
import type { SessionQueryOptions, TraceQueryOptions } from "@/types/api";

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

/**
 * Hook for fetching paginated traces list
 */
export function useTraces(projectId: string, options: TraceQueryOptions = {}) {
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
    queryFn: () => getTraces(projectId, "", options),
  });
}

/**
 * Hook for fetching a single trace with its spans
 */
export function useTrace(projectId: string, traceId: string, enabled: boolean = true) {
  return useQuery({
    queryKey: ["trace", projectId, traceId],
    queryFn: () => getTrace(projectId, traceId, ""),
    enabled,
  });
}

/**
 * Hook for fetching paginated users list
 */
export function useUsers(projectId: string, options: UserQueryOptions = {}) {
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
    queryFn: () => getUsers(projectId, options),
  });
}

/**
 * Hook for fetching paginated sessions list
 */
export function useSessions(projectId: string, options: SessionQueryOptions = {}) {
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
    queryFn: () => getSessions(projectId, options),
  });
}

/**
 * Hook for fetching a single session detail
 */
export function useSession(projectId: string, sessionId: string, enabled: boolean = true) {
  return useQuery({
    queryKey: ["session", projectId, sessionId],
    queryFn: () => getSession(projectId, sessionId),
    enabled,
  });
}
