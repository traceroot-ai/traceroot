/**
 * Usage API client - calls Python backend for ClickHouse queries.
 */

// Backend internal API base URL
const BACKEND_URL = process.env.BACKEND_INTERNAL_URL || "http://localhost:8000";
const INTERNAL_API_SECRET = process.env.INTERNAL_API_SECRET || "";

// A not-yet-ready backend (e.g. at worker startup) must not hang this call forever.
const REQUEST_TIMEOUT_MS = 10_000;

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
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Backend API error: ${response.status} - ${errorText}`);
  }

  return response.json() as Promise<T>;
}

/**
 * Get detailed usage (traces, spans, detector runs) for a workspace.
 * Detector runs are counted from ClickHouse `detector_runs` so the billing
 * cron is the single source of truth — matching how spans/AI runs work.
 */
export async function getWorkspaceUsageDetails(params: {
  projectIds: string[];
  start: Date;
  end: Date;
}): Promise<{ traces: number; spans: number; detectorRuns: number }> {
  if (params.projectIds.length === 0) {
    return { traces: 0, spans: 0, detectorRuns: 0 };
  }

  const result = await internalApiRequest<{
    traces: number;
    spans: number;
    detector_runs: number;
  }>("/api/v1/internal/usage/details", {
    project_ids: params.projectIds.join(","),
    start: params.start.toISOString(),
    end: params.end.toISOString(),
  });

  return {
    traces: result.traces,
    spans: result.spans,
    detectorRuns: result.detector_runs ?? 0,
  };
}

/**
 * No-op for API client (no connection to close).
 */
export async function closeClickHouseClient(): Promise<void> {
  // No-op - using HTTP API, no persistent connection
}
