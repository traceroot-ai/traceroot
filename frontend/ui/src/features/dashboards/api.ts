import { fetchNextApi, fetchTraceApi, type TraceApiUser } from "@/lib/api/client";
import type {
  DashboardDetail,
  DashboardSummary,
  LayoutItem,
  TimeRange,
  Widget,
  WidgetFieldValuesResponse,
  WidgetQueryResult,
  WidgetSchema,
  WidgetSpec,
} from "./types";

export function listDashboards(projectId: string) {
  return fetchNextApi<{ data: DashboardSummary[] }>(`/projects/${projectId}/dashboards`);
}

export function getDashboard(projectId: string, dashboardId: string) {
  return fetchNextApi<{ dashboard: DashboardDetail }>(
    `/projects/${projectId}/dashboards/${dashboardId}`,
  );
}

export function createDashboard(projectId: string, input: { name: string; description?: string }) {
  return fetchNextApi<{ dashboard: DashboardSummary }>(`/projects/${projectId}/dashboards`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function updateDashboard(
  projectId: string,
  dashboardId: string,
  input: { name?: string; description?: string | null; layout?: LayoutItem[] },
) {
  return fetchNextApi<{ dashboard: DashboardSummary }>(
    `/projects/${projectId}/dashboards/${dashboardId}`,
    { method: "PATCH", body: JSON.stringify(input) },
  );
}

export function deleteDashboard(projectId: string, dashboardId: string) {
  return fetchNextApi<{ deleted: boolean }>(`/projects/${projectId}/dashboards/${dashboardId}`, {
    method: "DELETE",
  });
}

export function createWidget(
  projectId: string,
  dashboardId: string,
  input: { title: string; type: Widget["type"]; spec: object; displayConfig?: object },
) {
  return fetchNextApi<{ widget: Widget }>(
    `/projects/${projectId}/dashboards/${dashboardId}/widgets`,
    { method: "POST", body: JSON.stringify(input) },
  );
}

export function updateWidget(
  projectId: string,
  dashboardId: string,
  widgetId: string,
  input: { title?: string; spec?: object; displayConfig?: object },
) {
  return fetchNextApi<{ widget: Widget }>(
    `/projects/${projectId}/dashboards/${dashboardId}/widgets/${widgetId}`,
    { method: "PATCH", body: JSON.stringify(input) },
  );
}

export function deleteWidget(projectId: string, dashboardId: string, widgetId: string) {
  return fetchNextApi<{ deleted: boolean }>(
    `/projects/${projectId}/dashboards/${dashboardId}/widgets/${widgetId}`,
    { method: "DELETE" },
  );
}

// The TRACE_API_BASE already includes /api/v1, so paths begin with /projects/...
export function fetchWidgetSchema(projectId: string, user?: TraceApiUser) {
  return fetchTraceApi<WidgetSchema>(`/projects/${projectId}/widgets/schema`, {}, user);
}

export function fetchWidgetFieldValues(
  projectId: string,
  view: "spans" | "traces",
  field: string,
  range: TimeRange,
  user?: TraceApiUser,
) {
  const params = new URLSearchParams({
    start_time: range.start.toISOString(),
    end_time: range.end.toISOString(),
  });
  return fetchTraceApi<WidgetFieldValuesResponse>(
    `/projects/${projectId}/widgets/field-values/${view}/${encodeURIComponent(field)}?${params}`,
    {},
    user,
  );
}

export function runWidgetQuery(
  projectId: string,
  spec: WidgetSpec,
  range: TimeRange,
  user?: TraceApiUser,
) {
  return fetchTraceApi<WidgetQueryResult>(
    `/projects/${projectId}/widgets/query`,
    {
      method: "POST",
      body: JSON.stringify({
        spec,
        start_time: range.start.toISOString(),
        end_time: range.end.toISOString(),
      }),
    },
    user,
  );
}
