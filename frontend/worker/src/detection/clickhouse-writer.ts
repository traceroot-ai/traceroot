/**
 * Internal API client for writing detector results to ClickHouse.
 * The TypeScript worker calls the Python backend's internal API,
 * which handles the actual ClickHouse writes.
 * Pattern matches frontend/worker/src/ee/billing/clickhouse.ts
 */

const BACKEND_URL = process.env.BACKEND_INTERNAL_URL || "http://localhost:8000";
const INTERNAL_API_SECRET = process.env.INTERNAL_API_SECRET || "";

/**
 * Who wrote a detector_runs / detector_findings row (migration 017): a
 * detector, or a Loop recording its findings as hits of its hidden detector.
 * Readers of detector findings, runs and usage keep only "detector" rows.
 * Omitted reads as "detector" server-side.
 */
export type DetectorRowSource = "detector" | "loop";

/**
 * How long one write may take, response included. Each write is a single row,
 * so this only cuts off a request that hung; it then fails like any other
 * failed write.
 */
export const INTERNAL_WRITE_TIMEOUT_MS = 30_000;

async function internalPost(path: string, body: unknown): Promise<void> {
  const response = await fetch(`${BACKEND_URL}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Internal-Secret": INTERNAL_API_SECRET,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(INTERNAL_WRITE_TIMEOUT_MS),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Backend API error ${response.status}: ${text}`);
  }
}

export async function writeDetectorRun(params: {
  runId: string;
  detectorId: string;
  projectId: string;
  traceId: string;
  findingId: string | null;
  status: "completed" | "failed";
  // True when the eval recorded inference usage for this run version — the
  // model was reached and billed, whatever the final status. The usage meter
  // counts a run when its latest version completed OR used inference; failures
  // before any model call (missing key, unknown model, span download) leave
  // this omitted/false. Omitted reads as false server-side (migration 016).
  usedInference?: boolean;
  // True when the worker emitted a self-trace for this run — set
  // optimistically at emit time, before ingestion is guaranteed; gates the
  // runs-tab link to the run's own trace. Omitted (false) when no emit
  // happened, e.g. the spans download failed before any detector ran.
  selfTraced?: boolean;
  source?: DetectorRowSource;
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
  source?: DetectorRowSource;
  timestampMs?: number;
}): Promise<void> {
  await internalPost("/api/v1/internal/detector-findings", params);
}
