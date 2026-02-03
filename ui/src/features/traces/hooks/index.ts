/**
 * Trace feature hooks
 */
import { useQuery } from '@tanstack/react-query';
import { getTraces, getTrace } from '@/lib/api';
import { getUsers, type UserQueryOptions } from '@/lib/api/users';
import type { TraceQueryOptions } from '@/types/api';

/**
 * Hook for fetching paginated traces list
 */
export function useTraces(projectId: string, options: TraceQueryOptions = {}) {
  return useQuery({
    queryKey: ['traces', projectId, options.page, options.limit, options.name, options.status, options.user_id, options.session_id],
    queryFn: () => getTraces(projectId, '', options),
  });
}

/**
 * Hook for fetching a single trace with its spans
 */
export function useTrace(projectId: string, traceId: string, enabled: boolean = true) {
  return useQuery({
    queryKey: ['trace', projectId, traceId],
    queryFn: () => getTrace(projectId, traceId, ''),
    enabled,
  });
}

/**
 * Hook for fetching paginated users list
 */
export function useUsers(projectId: string, options: UserQueryOptions = {}) {
  return useQuery({
    queryKey: ['users', projectId, options.page, options.limit],
    queryFn: () => getUsers(projectId, options),
  });
}
