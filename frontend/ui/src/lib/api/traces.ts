/**
 * Trace API functions (Python backend - ClickHouse)
 */
import { fetchTraceApi, type TraceApiUser } from "./client";
import type {
  MetadataKeysResponse,
  SpanIO,
  TraceDetail,
  TraceListResponse,
  TraceQueryOptions,
} from "@/types/api";
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
  if (options.include_evaluations) params.set("include_evaluations", "true");
  const filtersParam = serializeFiltersParam(options.filters);
  if (filtersParam) params.set("filters", filtersParam);

  const query = params.toString();
  const endpoint = `/projects/${projectId}/traces${query ? `?${query}` : ""}`;

  return fetchTraceApi<TraceListResponse>(endpoint, {}, user);
}

/**
 * Summaries (name, errors, cost, latency) of a known set of traces, at most 100,
 * whatever their age: no default time window applies to an id list.
 */
export async function getTracesByIds(
  projectId: string,
  traceIds: string[],
  user?: TraceApiUser,
): Promise<TraceListResponse> {
  // No ids means no request: `limit=0` would violate the backend's `ge=1` bound.
  if (traceIds.length === 0) {
    return { data: [], meta: { page: 0, limit: 0, total: 0 } };
  }
  // Backend cap for ?trace_ids= (see backend/rest/routers/traces.py MAX_TRACE_IDS).
  const ids = traceIds.slice(0, 100);
  const params = new URLSearchParams({ limit: String(ids.length) });
  for (const id of ids) params.append("trace_ids", id);
  return fetchTraceApi<TraceListResponse>(`/projects/${projectId}/traces?${params}`, {}, user);
}

export async function tracesExist(
  projectId: string,
  user?: TraceApiUser,
): Promise<{ exists: boolean }> {
  return fetchTraceApi<{ exists: boolean }>(`/projects/${projectId}/traces/exists`, {}, user);
}

/** Opt-in read scopes for internal telemetry; omit for customer traffic. */
export type TraceSource = "detector" | "agent" | "user";

export async function getTrace(
  projectId: string,
  traceId: string,
  _apiKey: string,
  user?: TraceApiUser,
  source?: TraceSource,
): Promise<TraceDetail> {
  const query = source ? `?source=${source}` : "";
  return fetchTraceApi<TraceDetail>(`/projects/${projectId}/traces/${traceId}${query}`, {}, user);
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
  endBefore: string | undefined,
  user?: TraceApiUser,
): Promise<FilterValuesResponse> {
  const params = new URLSearchParams();
  if (startAfter) params.set("start_after", startAfter);
  if (endBefore) params.set("end_before", endBefore);
  const query = params.toString() ? `?${params.toString()}` : "";
  return fetchTraceApi<FilterValuesResponse>(
    `/projects/${projectId}/traces/filter-values/${encodeURIComponent(field)}${query}`,
    {},
    user,
  );
}

/**
 * Metadata keys observed in the active window, frequency-ordered — the discovery answer
 * behind the metadata filter's key combobox, its one consumer.
 *
 * The window is passed exactly as the distinct-values fetcher passes it, and for the same
 * reason: a key list gathered outside the window the user is looking at would suggest keys
 * that return zero rows the moment they are picked. The response carries the keys and
 * nothing else — it does not echo the bounds back.
 */
export async function getMetadataKeys(
  projectId: string,
  startAfter: string | undefined,
  endBefore: string | undefined,
  user?: TraceApiUser,
): Promise<MetadataKeysResponse> {
  const params = new URLSearchParams();
  if (startAfter) params.set("start_after", startAfter);
  if (endBefore) params.set("end_before", endBefore);
  const query = params.toString() ? `?${params.toString()}` : "";
  return fetchTraceApi<MetadataKeysResponse>(
    `/projects/${projectId}/traces/metadata-keys${query}`,
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
