/**
 * Sessions API functions (Python backend - ClickHouse)
 */
import type { SessionDetailResponse, SessionListResponse, SessionQueryOptions } from "@/types/api";
import { fetchTraceApi } from "./client";

export async function getSessions(
  projectId: string,
  options: SessionQueryOptions = {},
): Promise<SessionListResponse> {
  const params = new URLSearchParams();
  if (options.page !== undefined) params.set("page", String(options.page));
  if (options.limit !== undefined) params.set("limit", String(options.limit));
  if (options.search_query) params.set("search_query", options.search_query);
  if (options.start_after) params.set("start_after", options.start_after);
  if (options.end_before) params.set("end_before", options.end_before);

  const query = params.toString();
  const endpoint = `/projects/${projectId}/sessions${query ? `?${query}` : ""}`;

  return fetchTraceApi<SessionListResponse>(endpoint);
}

export interface SessionDetailOptions {
  start_after?: string;
  end_before?: string;
}

export async function getSession(
  projectId: string,
  sessionId: string,
  options: SessionDetailOptions = {},
): Promise<SessionDetailResponse> {
  const params = new URLSearchParams();
  if (options.start_after) params.set("start_after", options.start_after);
  if (options.end_before) params.set("end_before", options.end_before);

  const query = params.toString();
  const endpoint = `/projects/${projectId}/sessions/${encodeURIComponent(sessionId)}${query ? `?${query}` : ""}`;

  return fetchTraceApi<SessionDetailResponse>(endpoint);
}
