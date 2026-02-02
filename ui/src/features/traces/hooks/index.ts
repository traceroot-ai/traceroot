/**
 * Trace feature hooks
 */
import { useQuery } from '@tanstack/react-query';
import { getTraces, getTrace } from '@/lib/api';
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
