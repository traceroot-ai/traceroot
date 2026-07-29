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

// The digest needs finding_count plus sample_trace_ids (deep-link targets,
// newest-first); the backend window-summary endpoint also returns run_count
// (consumed by the UI), which we don't type here. sample_trace_ids is empty for
// a detector that ran but never fired.
export type DetectorWindowSummary = Record<
  string,
  {
    finding_count: number;
    sample_trace_ids: string[];
    /** Recent per-detector judge sentences (newest first, SQL-capped); only
     * present when the read asked for them. Feeds the digest LLM summary. */
    sample_summaries?: string[];
  }
>;

/**
 * Read the per-detector window summary (finding counts + each detector's sample
 * triggered traces) for a project over a time window. Detectors with zero runs
 * in the window are absent from the map.
 */
export async function readDetectorWindowSummary(
  projectId: string,
  start: Date,
  end: Date,
  opts: { includeSummaries?: boolean } = {},
): Promise<DetectorWindowSummary> {
  const params: Record<string, string> = {
    project_id: projectId,
    start_after: start.toISOString(),
    end_before: end.toISOString(),
  };
  if (opts.includeSummaries) params.include_summaries = "true";
  const body = await internalGet<{ data: DetectorWindowSummary }>(
    "/api/v1/internal/detector-window-summary",
    params,
  );
  return body.data;
}
