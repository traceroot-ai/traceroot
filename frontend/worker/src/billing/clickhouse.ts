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
 * Get detailed usage (traces and spans separately) for a workspace.
 */
export async function getWorkspaceUsageDetails(params: {
  projectIds: string[];
  start: Date;
  end: Date;
}): Promise<{ traces: number; spans: number }> {
  if (params.projectIds.length === 0) {
    return { traces: 0, spans: 0 };
  }

  const result = await internalApiRequest<{
    traces: number;
    spans: number;
  }>("/api/v1/internal/usage/details", {
    project_ids: params.projectIds.join(","),
    start: params.start.toISOString(),
    end: params.end.toISOString(),
  });

  return result;
}

/**
 * No-op for API client (no connection to close).
 */
export async function closeClickHouseClient(): Promise<void> {
  // No-op - using HTTP API, no persistent connection
}
