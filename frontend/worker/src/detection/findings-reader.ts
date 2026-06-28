/**
 * Internal API client for reading detector findings/counts for digests.
 * The TypeScript worker calls the Python backend's internal API, which runs
 * the actual ClickHouse queries.
 * Pattern matches frontend/worker/src/ee/billing/clickhouse.ts
 */

const BACKEND_URL = process.env.BACKEND_INTERNAL_URL || "http://localhost:8000";
const INTERNAL_API_SECRET = process.env.INTERNAL_API_SECRET || "";

/**
 * Make an authenticated GET request to the internal backend API.
 */
async function internalGet<T>(path: string, params: Record<string, string>): Promise<T> {
  const url = new URL(path, BACKEND_URL);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  const response = await fetch(url.toString(), {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      "X-Internal-Secret": INTERNAL_API_SECRET,
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Backend API error: ${response.status} - ${text}`);
  }

  return response.json() as Promise<T>;
}

export type DetectorCounts = Record<string, { finding_count: number; run_count: number }>;

/**
 * Read per-detector finding and run counts for a project over a time window.
 * Detectors with zero runs in the window are absent from the map.
 */
export async function readDetectorCounts(
  projectId: string,
  start: Date,
  end: Date,
): Promise<DetectorCounts> {
  const body = await internalGet<{ data: DetectorCounts }>("/api/v1/internal/detector-counts", {
    project_id: projectId,
    start_after: start.toISOString(),
    end_before: end.toISOString(),
  });
  return body.data;
}

/**
 * Return the trace id of the latest finding for a detector in the window,
 * or null when the detector produced no findings.
 */
export async function readLatestFinding(
  projectId: string,
  detectorId: string,
  start: Date,
  end: Date,
): Promise<string | null> {
  const body = await internalGet<{ data: Array<{ trace_id: string }> }>(
    "/api/v1/internal/detector-findings",
    {
      project_id: projectId,
      detector_id: detectorId,
      start_after: start.toISOString(),
      end_before: end.toISOString(),
      page: "0",
      limit: "1",
    },
  );
  return body.data[0]?.trace_id ?? null;
}
