import { useQuery } from "@tanstack/react-query";
import { hasMinRole, Role } from "@traceroot/core";
import { useProject } from "@/features/projects/hooks";
import { useWorkspace } from "@/features/workspaces/hooks";
import { getTraceLabels, listProjectLabels } from "./api";

export const projectLabelsKey = (projectId: string) => ["project-labels", projectId] as const;

export const traceLabelsKey = (projectId: string, traceId: string, spanId: string | null) =>
  ["trace-labels", projectId, traceId, spanId] as const;

export function useProjectLabels(projectId: string, enabled = true) {
  return useQuery({
    queryKey: projectLabelsKey(projectId),
    queryFn: ({ signal }) => listProjectLabels(projectId, signal),
    enabled,
  });
}

export function useTraceLabels(
  projectId: string,
  traceId: string,
  spanId: string | null,
  enabled: boolean,
) {
  return useQuery({
    queryKey: traceLabelsKey(projectId, traceId, spanId),
    queryFn: ({ signal }) => getTraceLabels(projectId, traceId, spanId, signal),
    enabled,
  });
}

export function useCanManageProjectLabels(projectId: string, enabled = true) {
  const { data: project } = useProject(projectId, enabled);
  const { data: workspace } = useWorkspace(project?.workspace_id ?? "", enabled);
  return enabled && !!workspace && hasMinRole(workspace.role, Role.MEMBER);
}
