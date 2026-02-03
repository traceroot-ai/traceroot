/**
 * Users API functions (Python backend - ClickHouse)
 */
import { fetchTraceApi } from "./client";

export interface UserListItem {
  user_id: string;
  trace_count: number;
  last_trace_time: string;
}

export interface UserListResponse {
  data: UserListItem[];
  meta: {
    page: number;
    limit: number;
    total: number;
  };
}

export interface UserQueryOptions {
  page?: number;
  limit?: number;
}

export async function getUsers(
  projectId: string,
  options: UserQueryOptions = {}
): Promise<UserListResponse> {
  const params = new URLSearchParams();
  if (options.page !== undefined) params.set("page", String(options.page));
  if (options.limit !== undefined) params.set("limit", String(options.limit));

  const query = params.toString();
  const endpoint = `/projects/${projectId}/users${query ? `?${query}` : ""}`;

  return fetchTraceApi<UserListResponse>(endpoint);
}
