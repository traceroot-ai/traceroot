/**
 * Internal API client for reading detector findings/counts for digests.
 * The TypeScript worker calls the Python backend's internal API, which runs
 * the actual ClickHouse queries.
 * Pattern matches frontend/worker/src/ee/billing/clickhouse.ts
 */

const BACKEND_URL = process.env.BACKEND_INTERNAL_URL || "http://localhost:8000";
const INTERNAL_API_SECRET = process.env.INTERNAL_API_SECRET || "";

/**
 * Make an authenticated POST request to the internal backend API.
 */
async function internalPost<T>(path: string, body: unknown): Promise<T> {
  const url = new URL(path, BACKEND_URL);

  const response = await fetch(url.toString(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Internal-Secret": INTERNAL_API_SECRET,
    },
    body: JSON.stringify(body),
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

export interface DetectorWindowSummaryResult {
  data: DetectorWindowSummary;
  /** Distinct finding ids across the selected detector runs in the window. */
  distinctFindingCount: number;
}

/**
 * Read the window's distinct finding count and per-detector summary (trigger
 * counts + each detector's sample triggered traces). Detectors with zero runs
 * in the window are absent from the data map.
 */
export async function readDetectorWindowSummary(
  projectId: string,
  start: Date,
  end: Date,
  opts: { includeSummaries?: boolean; detectorIds?: string[] } = {},
): Promise<DetectorWindowSummaryResult> {
  const body = await internalPost<{
    data: DetectorWindowSummary;
    distinct_finding_count: unknown;
  }>("/api/v1/internal/detector-window-summary", {
    project_id: projectId,
    start_after: start.toISOString(),
    end_before: end.toISOString(),
    include_summaries: opts.includeSummaries === true,
    detector_ids: opts.detectorIds ?? [],
  });
  const distinctFindingCount = body.distinct_finding_count;
  if (
    typeof distinctFindingCount !== "number" ||
    !Number.isFinite(distinctFindingCount) ||
    !Number.isInteger(distinctFindingCount) ||
    distinctFindingCount < 0
  ) {
    throw new Error(
      "Invalid detector-window-summary distinct_finding_count: expected a finite nonnegative integer",
    );
  }
  return {
    data: body.data,
    distinctFindingCount,
  };
}
