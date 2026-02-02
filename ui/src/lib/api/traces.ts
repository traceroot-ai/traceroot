/**
 * Trace API functions (Python backend - ClickHouse)
 */
import { fetchTraceApi } from "./client";
import type { TraceDetail, TraceListResponse, TraceQueryOptions } from "@/types/api";

export async function getTraces(
  projectId: string,
  _apiKey: string,
  options: TraceQueryOptions = {}
): Promise<TraceListResponse> {
  const params = new URLSearchParams();
  if (options.page !== undefined) params.set("page", String(options.page));
  if (options.limit !== undefined) params.set("limit", String(options.limit));
  if (options.name) params.set("name", options.name);
  if (options.status) params.set("status", options.status);
  if (options.user_id) params.set("user_id", options.user_id);
  if (options.session_id) params.set("session_id", options.session_id);

  const query = params.toString();
  const endpoint = `/projects/${projectId}/traces${query ? `?${query}` : ""}`;

  return fetchTraceApi<TraceListResponse>(endpoint);
}

export async function getTrace(
  projectId: string,
  traceId: string,
  _apiKey: string
): Promise<TraceDetail> {
  return fetchTraceApi<TraceDetail>(`/projects/${projectId}/traces/${traceId}`);
}
