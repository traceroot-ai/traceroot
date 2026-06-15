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

export async function writeDetectorRun(params: {
  runId: string;
  detectorId: string;
  projectId: string;
  traceId: string;
  findingId: string | null;
  status: "completed" | "failed";
}): Promise<void> {
  await internalPost("/api/v1/internal/detector-runs", params);
}

export async function writeDetectorFinding(params: {
  findingId: string;
  projectId: string;
  traceId: string;
  summary: string;
  payload: string;
}): Promise<void> {
  await internalPost("/api/v1/internal/detector-findings", params);
}
