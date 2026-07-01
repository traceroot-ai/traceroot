/**
 * Trace API functions (Python backend - ClickHouse)
 */
import { fetchTraceApi, type TraceApiUser } from "./client";
import type { SpanIO, TraceDetail, TraceListResponse, TraceQueryOptions } from "@/types/api";
import { serializeFiltersParam } from "@/features/filters/predicate";
import type { FilterFieldsResponse, FilterValuesResponse } from "@/features/filters/registry";

export async function getTraces(
  projectId: string,
  _apiKey: string,
  options: TraceQueryOptions = {},
  user?: TraceApiUser,
): Promise<TraceListResponse> {
  const params = new URLSearchParams();
  if (options.page !== undefined) params.set("page", String(options.page));
  if (options.limit !== undefined) params.set("limit", String(options.limit));
  if (options.name) params.set("name", options.name);
  if (options.user_id) params.set("user_id", options.user_id);
  if (options.session_id) params.set("session_id", options.session_id);
  if (options.start_after) params.set("start_after", options.start_after);
  if (options.end_before) params.set("end_before", options.end_before);
  if (options.search_query) params.set("search_query", options.search_query);
  const filtersParam = serializeFiltersParam(options.filters);
  if (filtersParam) params.set("filters", filtersParam);

  const query = params.toString();
  const endpoint = `/projects/${projectId}/traces${query ? `?${query}` : ""}`;

  return fetchTraceApi<TraceListResponse>(endpoint, {}, user);
}

export async function getTrace(
  projectId: string,
  traceId: string,
  _apiKey: string,
  user?: TraceApiUser,
): Promise<TraceDetail> {
  return fetchTraceApi<TraceDetail>(`/projects/${projectId}/traces/${traceId}`, {}, user);
}

/** Registry of filterable fields driving the filter dropdown (Python source of truth). */
export async function getFilterFields(
  projectId: string,
  user?: TraceApiUser,
): Promise<FilterFieldsResponse> {
  return fetchTraceApi<FilterFieldsResponse>(
    `/projects/${projectId}/traces/filter-fields`,
    {},
    user,
  );
}

/** Distinct values for one categorical field, time-bounded by the active window. */
export async function getFilterValues(
  projectId: string,
  field: string,
  startAfter: string | undefined,
  user?: TraceApiUser,
): Promise<FilterValuesResponse> {
  const query = startAfter ? `?start_after=${encodeURIComponent(startAfter)}` : "";
  return fetchTraceApi<FilterValuesResponse>(
    `/projects/${projectId}/traces/filter-values/${encodeURIComponent(field)}${query}`,
    {},
    user,
  );
}

/**
 * Fetch full input/output/metadata for a single span on demand.
 * Backed by GET /projects/{projectId}/traces/{traceId}/spans/{spanId}/io.
 */
export async function getSpanIO(
  projectId: string,
  traceId: string,
  spanId: string,
  user?: TraceApiUser,
): Promise<SpanIO> {
  return fetchTraceApi<SpanIO>(
    `/projects/${projectId}/traces/${traceId}/spans/${spanId}/io`,
    {},
    user,
  );
}
