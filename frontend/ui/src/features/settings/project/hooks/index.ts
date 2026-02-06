/**
 * Project settings hooks
 * Local hooks to avoid cross-feature imports
 */
import { useQuery } from '@tanstack/react-query';
import { getProject } from '@/lib/api';

/**
 * Hook for fetching a project in settings context
 */
export function useProject(projectId: string, enabled: boolean = true) {
  return useQuery({
    queryKey: ['project', projectId],
    queryFn: () => getProject(projectId),
    enabled: enabled && !!projectId,
  });
}
