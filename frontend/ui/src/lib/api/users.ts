/**
 * Users API functions (Python backend - ClickHouse)
 */
import { fetchTraceApi, type TraceApiUser } from "./client";

export interface UserListItem {
  user_id: string;
  trace_count: number;
  last_trace_time: string;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cost: number;
}

export interface UserListResponse {
  data: UserListItem[];
  meta: {
    page: number;
    limit: number;
    total: number;
    total_input_tokens?: number;
    total_output_tokens?: number;
    total_cost?: number;
  };
}

export interface UserQueryOptions {
  page?: number;
  limit?: number;
  search_query?: string;
  start_after?: string;
  end_before?: string;
}

export async function getUsers(
  projectId: string,
  options: UserQueryOptions = {},
  user?: TraceApiUser,
): Promise<UserListResponse> {
  const params = new URLSearchParams();
  if (options.page !== undefined) params.set("page", String(options.page));
  if (options.limit !== undefined) params.set("limit", String(options.limit));
  if (options.search_query) params.set("search_query", options.search_query);
  if (options.start_after) params.set("start_after", options.start_after);
  if (options.end_before) params.set("end_before", options.end_before);

  const query = params.toString();
  const endpoint = `/projects/${projectId}/users${query ? `?${query}` : ""}`;

  return fetchTraceApi<UserListResponse>(endpoint, {}, user);
}
