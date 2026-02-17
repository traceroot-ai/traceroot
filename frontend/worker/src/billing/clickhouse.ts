/**
 * Usage API client - calls Python backend for ClickHouse queries.
 */

// Backend internal API base URL
const BACKEND_URL = process.env.BACKEND_INTERNAL_URL || "http://localhost:8000";
const INTERNAL_API_SECRET = process.env.INTERNAL_API_SECRET || "";

/**
 * Make an authenticated request to the internal backend API.
 */
async function internalApiRequest<T>(path: string, params?: Record<string, string>): Promise<T> {
  const url = new URL(path, BACKEND_URL);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
  }

  const response = await fetch(url.toString(), {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      "X-Internal-Secret": INTERNAL_API_SECRET,
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Backend API error: ${response.status} - ${errorText}`);
  }

  return response.json() as Promise<T>;
}

/**
 * Get total usage for a workspace (sum of all projects) in the current billing period.
 * Used for billing metering.
 */
export async function getWorkspaceUsageInPeriod(params: {
  projectIds: string[];
  start: Date;
  end: Date;
}): Promise<number> {
  if (params.projectIds.length === 0) {
    return 0;
  }

  const result = await internalApiRequest<{
    total_events: number;
  }>("/api/v1/internal/usage/total", {
    project_ids: params.projectIds.join(","),
    start: params.start.toISOString(),
    end: params.end.toISOString(),
  });

  return result.total_events;
}

/**
 * No-op for API client (no connection to close).
 */
export async function closeClickHouseClient(): Promise<void> {
  // No-op - using HTTP API, no persistent connection
}
