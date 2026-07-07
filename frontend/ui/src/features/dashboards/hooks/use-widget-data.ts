import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useSession as useAuthSession } from "@/lib/auth-client";
import type { TraceApiUser } from "@/lib/api/client";
import * as api from "../api";
import {
  isSpecComplete,
  parseSpec,
  type TimeRange,
  type WidgetFieldValue,
  type WidgetSpec,
} from "../types";

export function useWidgetSchema(projectId: string) {
  const { data: authSession, isPending } = useAuthSession();
  const sessionReady = !isPending && !!authSession?.user;
  const user: TraceApiUser | undefined = authSession?.user
    ? { id: authSession.user.id, email: authSession.user.email }
    : undefined;

  return useQuery({
    queryKey: ["widget-schema", projectId],
    queryFn: () => api.fetchWidgetSchema(projectId, user),
    enabled: sessionReady && !!projectId,
    staleTime: 5 * 60 * 1000,
  });
}

export function useWidgetData(
  projectId: string,
  widgetId: string,
  spec: WidgetSpec,
  range: TimeRange,
  enabled = true,
) {
  const { data: authSession, isPending } = useAuthSession();
  const sessionReady = !isPending && !!authSession?.user;
  const user: TraceApiUser | undefined = authSession?.user
    ? { id: authSession.user.id, email: authSession.user.email }
    : undefined;

  return useQuery({
    queryKey: [
      "widget-data",
      projectId,
      widgetId,
      JSON.stringify(spec),
      range.start.getTime(),
      range.end.getTime(),
    ],
    queryFn: () => api.runWidgetQuery(projectId, spec, range, user),
    enabled: enabled && sessionReady && !!projectId && !!widgetId,
    retry: 1,
    placeholderData: keepPreviousData,
  });
}

/**
 * Distinct stored values for a string filter field, fetched lazily (only for an
 * enumerable filter, once a field is picked) and bounded by the dashboard window.
 * Backed by the same cached distinct-values scan as the trace-list filter dropdown.
 */
export function useWidgetFieldValues(
  projectId: string,
  view: "spans" | "traces" | undefined,
  field: string,
  range: TimeRange,
  enabled: boolean,
): { values: WidgetFieldValue[]; isLoading: boolean } {
  const { data: authSession, isPending } = useAuthSession();
  const sessionReady = !isPending && !!authSession?.user;
  const user: TraceApiUser | undefined = authSession?.user
    ? { id: authSession.user.id, email: authSession.user.email }
    : undefined;

  const active = enabled && sessionReady && !!projectId && !!view && !!field;
  const { data, isLoading } = useQuery({
    queryKey: [
      "widget-field-values",
      projectId,
      view ?? null,
      field,
      range.start.getTime(),
      range.end.getTime(),
    ],
    queryFn: () => api.fetchWidgetFieldValues(projectId, view!, field, range, user),
    enabled: active,
    staleTime: 30_000,
  });
  // Mask React Query's retained cache while inactive so a row that switched field
  // or to a non-enumerable op reports no values rather than a stale list.
  return active ? { values: data?.values ?? [], isLoading } : { values: [], isLoading: false };
}

export function useWidgetPreview(projectId: string, draft: unknown, range: TimeRange) {
  const { data: authSession, isPending } = useAuthSession();
  const sessionReady = !isPending && !!authSession?.user;
  const user: TraceApiUser | undefined = authSession?.user
    ? { id: authSession.user.id, email: authSession.user.email }
    : undefined;

  return useQuery({
    queryKey: [
      "widget-preview",
      projectId,
      JSON.stringify(draft),
      range.start.getTime(),
      range.end.getTime(),
    ],
    queryFn: () => api.runWidgetQuery(projectId, parseSpec(draft)!, range, user),
    enabled: sessionReady && !!projectId && isSpecComplete(draft),
    staleTime: 10_000,
    retry: false,
    placeholderData: keepPreviousData,
  });
}
