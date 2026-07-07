import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { broadcastQueryInvalidation } from "@/lib/cross-tab-sync";
import * as api from "../api";
import type { LayoutItem, Widget } from "../types";

export function useDashboards(projectId: string) {
  return useQuery({
    queryKey: ["dashboards", projectId],
    queryFn: () => api.listDashboards(projectId),
    select: (data) => data.data,
    enabled: !!projectId,
  });
}

export function useDashboard(projectId: string, dashboardId: string) {
  return useQuery({
    queryKey: ["dashboard", projectId, dashboardId],
    queryFn: () => api.getDashboard(projectId, dashboardId),
    select: (data) => data.dashboard,
    enabled: !!projectId && !!dashboardId,
  });
}

function invalidateDashboards(
  queryClient: ReturnType<typeof useQueryClient>,
  projectId: string,
  dashboardId?: string,
) {
  void queryClient.invalidateQueries({ queryKey: ["dashboards", projectId] });
  broadcastQueryInvalidation(["dashboards", projectId]);
  if (dashboardId) {
    void queryClient.invalidateQueries({ queryKey: ["dashboard", projectId, dashboardId] });
    broadcastQueryInvalidation(["dashboard", projectId, dashboardId]);
  }
}

export function useDashboardMutations(projectId: string, dashboardId?: string) {
  const queryClient = useQueryClient();

  const createDashboard = useMutation({
    mutationFn: (input: { name: string; description?: string }) =>
      api.createDashboard(projectId, input),
    onSuccess: () => invalidateDashboards(queryClient, projectId),
  });

  const updateLayout = useMutation({
    mutationFn: (layout: LayoutItem[]) => api.updateDashboard(projectId, dashboardId!, { layout }),
    onSuccess: () => invalidateDashboards(queryClient, projectId, dashboardId),
  });

  const renameDashboard = useMutation({
    mutationFn: (input: { name?: string; description?: string | null }) =>
      api.updateDashboard(projectId, dashboardId!, input),
    onSuccess: () => invalidateDashboards(queryClient, projectId, dashboardId),
  });

  const removeDashboard = useMutation({
    mutationFn: (id: string) => api.deleteDashboard(projectId, id),
    onSuccess: (_data, id) => invalidateDashboards(queryClient, projectId, id),
  });

  const createWidget = useMutation({
    mutationFn: (input: {
      title: string;
      type: Widget["type"];
      spec: object;
      displayConfig?: object;
    }) => api.createWidget(projectId, dashboardId!, input),
    onSuccess: () => invalidateDashboards(queryClient, projectId, dashboardId),
  });

  const updateWidget = useMutation({
    mutationFn: ({
      widgetId,
      ...input
    }: {
      widgetId: string;
      title?: string;
      spec?: object;
      displayConfig?: object;
    }) => api.updateWidget(projectId, dashboardId!, widgetId, input),
    onSuccess: () => invalidateDashboards(queryClient, projectId, dashboardId),
  });

  const removeWidget = useMutation({
    mutationFn: (widgetId: string) => api.deleteWidget(projectId, dashboardId!, widgetId),
    onSuccess: () => invalidateDashboards(queryClient, projectId, dashboardId),
  });

  return {
    createDashboard,
    updateLayout,
    renameDashboard,
    removeDashboard,
    createWidget,
    updateWidget,
    removeWidget,
  };
}
