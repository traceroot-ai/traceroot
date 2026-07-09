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
    // Teammates' edits have no push channel and cross-tab sync only covers
    // one browser, so an open dashboard would otherwise show another user's
    // changes only on focus/navigation. Polling pauses while the tab is
    // hidden (react-query default).
    refetchInterval: 30_000,
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
    // A 30s-poll (or focus-refetch) response carrying the pre-save layout can
    // land between the drag's PATCH and its refetch, reverting the grid and
    // re-PATCHing the old layout. Cancel in-flight reads and write the new
    // layout into the cache up front so that window doesn't exist.
    onMutate: async (layout) => {
      const key = ["dashboard", projectId, dashboardId];
      await queryClient.cancelQueries({ queryKey: key });
      queryClient.setQueryData(key, (prev: { dashboard: { layout: LayoutItem[] } } | undefined) =>
        prev ? { ...prev, dashboard: { ...prev.dashboard, layout } } : prev,
      );
    },
    // On failure the optimistic layout is wrong — refetch the truth.
    onError: () => invalidateDashboards(queryClient, projectId, dashboardId),
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
