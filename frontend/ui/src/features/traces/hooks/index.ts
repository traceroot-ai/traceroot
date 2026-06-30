/**
 * Trace feature hooks
 */
import { useCallback } from "react";
import { useQuery, keepPreviousData, useQueryClient } from "@tanstack/react-query";
import { useSession as useAuthSession } from "@/lib/auth-client";
import { getTraces, getTrace, getSpanIO } from "@/lib/api";
import { getSessions, getSession, type SessionDetailOptions } from "@/lib/api/sessions";
import { getUsers, type UserQueryOptions } from "@/lib/api/users";
import type { SessionQueryOptions, TraceQueryOptions } from "@/types/api";
import type { TraceApiUser } from "@/lib/api/client";

// Composed state hooks
export { useTraceListState } from "./use-trace-list-state";

// Live trace streaming
export { useTraceStream } from "./use-trace-stream";

/**
 * Canonical React Query key for the paginated traces list. Exported so the
 * hover-prefetch and the useTraces hook key identically — a drift here would
 * silently cache prefetched pages under a key the hook never reads.
 */
export function tracesQueryKey(projectId: string, options: TraceQueryOptions = {}) {
  return [
    "traces",
    projectId,
    options.page,
    options.limit,
    options.search_query,
    options.start_after,
    options.end_before,
    options.user_id,
    options.session_id,
  ] as const;
}

/** Traces are mostly append-only; a short stale window stops redundant refetches
 *  on revisit and lets a hover-prefetched page actually "stick" before navigation. */
export const TRACES_LIST_STALE_TIME_MS = 30_000;

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
    queryKey: tracesQueryKey(projectId, options),
    queryFn: () => getTraces(projectId, "", options, user),
    enabled: sessionReady && !!projectId,
    placeholderData: keepPreviousData,
    staleTime: TRACES_LIST_STALE_TIME_MS,
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

// Per-span I/O is cached for 5 minutes: the blobs are immutable once a span
// completes, and this lets a hover-prefetch satisfy the subsequent click
// without a refetch. Shared by useSpanIO and the SpanTreeView hover prefetch.
export const SPAN_IO_STALE_TIME_MS = 5 * 60 * 1000;

/**
 * React Query key for a single span's lazily-fetched I/O. Exported so the
 * SpanTreeView hover-prefetch and the useSpanIO hook key identically.
 */
export function spanIOQueryKey(projectId: string, traceId: string, spanId: string) {
  return ["span-io", projectId, traceId, spanId] as const;
}

/**
 * Hook for lazily fetching a single span's full I/O (input/output/metadata).
 * Only fetches when spanId is provided (i.e. the user selected a span); the
 * trace-detail skeleton no longer ships per-span I/O.
 */
export function useSpanIO(projectId: string, traceId: string, spanId: string | null) {
  const { data: authSession, isPending } = useAuthSession();
  const sessionReady = !isPending && !!authSession?.user;
  const user: TraceApiUser | undefined = authSession?.user
    ? { id: authSession.user.id, email: authSession.user.email }
    : undefined;
  return useQuery({
    queryKey: spanIOQueryKey(projectId, traceId, spanId ?? ""),
    queryFn: () => getSpanIO(projectId, traceId, spanId!, user),
    enabled: sessionReady && !!spanId,
    staleTime: SPAN_IO_STALE_TIME_MS,
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
 * Returns a function that warms an adjacent traces page into the React Query
 * cache. Wire to hover/focus of the pagination prev/next buttons so the click
 * lands on a cache hit. No-op until auth + projectId are ready.
 */
export function usePrefetchTraces(projectId: string) {
  const queryClient = useQueryClient();
  const { data: authSession } = useAuthSession();
  const user: TraceApiUser | undefined = authSession?.user
    ? { id: authSession.user.id, email: authSession.user.email }
    : undefined;

  return useCallback(
    (options: TraceQueryOptions = {}) => {
      if (!projectId || !user) return;
      queryClient.prefetchQuery({
        queryKey: tracesQueryKey(projectId, options),
        queryFn: () => getTraces(projectId, "", options, user),
        staleTime: TRACES_LIST_STALE_TIME_MS,
      });
    },
    // `user` is a fresh object literal each render; key off its stable id/email
    // so the callback isn't rebuilt every render.
    [queryClient, projectId, user?.id, user?.email], // eslint-disable-line react-hooks/exhaustive-deps
  );
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
