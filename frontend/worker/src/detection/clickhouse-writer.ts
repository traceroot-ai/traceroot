/**
 * Internal API client for writing detector results to ClickHouse.
 * The TypeScript worker calls the Python backend's internal API,
 * which handles the actual ClickHouse writes.
 * Pattern matches frontend/worker/src/ee/billing/clickhouse.ts
 */

const BACKEND_URL = process.env.BACKEND_INTERNAL_URL || "http://localhost:8000";
const INTERNAL_API_SECRET = process.env.INTERNAL_API_SECRET || "";

async function internalPost(path: string, body: unknown): Promise<void> {
  const response = await fetch(`${BACKEND_URL}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Internal-Secret": INTERNAL_API_SECRET,
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Backend API error ${response.status}: ${text}`);
  }
}

/**
 * Terminal state of a detector run, as stored in ClickHouse.
 *
 * The distinction that matters for metering is whether a model was reached, not
 * whether the run succeeded: 'failed' never reached one, so nothing was spent,
 * while 'failed_after_inference' did and its tokens are billed like any scan.
 */
export type DetectorRunStatus = "completed" | "failed" | "failed_after_inference";

export async function writeDetectorRun(params: {
  runId: string;
  detectorId: string;
  projectId: string;
  traceId: string;
  findingId: string | null;
  status: DetectorRunStatus;
  // True when the worker emitted a self-trace for this run — set
  // optimistically at emit time, before ingestion is guaranteed; gates the
  // runs-tab link to the run's own trace. Omitted (false) when no emit
  // happened, e.g. the spans download failed before any detector ran.
  selfTraced?: boolean;
  // Worker epoch-ms time to store as the row timestamp. Omit to let ClickHouse
  // default to now64(3). Set for triggered runs so the digest window count
  // shares the clock that keys the flush.
  timestampMs?: number;
}): Promise<void> {
  await internalPost("/api/v1/internal/detector-runs", params);
}

export async function writeDetectorFinding(params: {
  findingId: string;
  projectId: string;
  traceId: string;
  summary: string;
  payload: string;
  timestampMs?: number;
}): Promise<void> {
  await internalPost("/api/v1/internal/detector-findings", params);
}
