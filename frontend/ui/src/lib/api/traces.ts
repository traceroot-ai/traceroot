/**
 * Trace API functions (Python backend - ClickHouse)
 */
import { fetchTraceApi, type TraceApiUser } from "./client";
import type { SpanIO, TraceDetail, TraceListResponse, TraceQueryOptions } from "@/types/api";

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

/**
 * Fetch full input/output/metadata for a single span on demand.
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

