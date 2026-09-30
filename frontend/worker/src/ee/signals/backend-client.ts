/**
 * The worker's side of the signal assignment endpoints. The Python backend runs
 * the ClickHouse queries; the worker never connects to ClickHouse itself.
 */

import { BACKEND_TIMEOUT_MS } from "./config.js";

/** A hit that fired and has no assignment yet, with the detector's output. */
export interface WaitingHitRow {
  run_id: string;
  trace_id: string;
  finding_id: string;
  timestamp_ms: number;
  /** Null when the trace row is gone. */
  trace_start_ms: number | null;
  summary: string;
  data: unknown;
}

/** One hit's row in ClickHouse signal_assignments. */
export interface AssignmentRow {
  project_id: string;
  detector_id: string;
  run_id: string;
  trace_id: string;
  signal_id: string;
  embedding: number[];
  score: number | null;
  criteria_version: number | null;
  assigned_at_ms: number;
  /** The worker gave up on this hit; signal_id is empty and it belongs to no signal. */
  gave_up?: boolean;
}

/** One detector finding of a trace; `payload` is the JSON array of per-detector entries. */
export interface TraceFindingRow {
  finding_id: string;
  payload: string;
}

export interface SignalsBackend {
  waitingHits(
    projectId: string,
    detectorId: string,
    sinceMs: number,
    limit: number,
  ): Promise<WaitingHitRow[]>;
  writeAssignments(rows: AssignmentRow[]): Promise<void>;
  traceFindings(projectId: string, traceId: string): Promise<TraceFindingRow[]>;
}

async function call<T>(
  method: "GET" | "POST",
  path: string,
  opts: { params?: Record<string, string>; body?: unknown } = {},
): Promise<T> {
  const url = new URL(path, process.env.BACKEND_INTERNAL_URL || "http://localhost:8000");
  for (const [k, v] of Object.entries(opts.params ?? {})) url.searchParams.set(k, v);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BACKEND_TIMEOUT_MS);
  timer.unref?.();
  try {
    const response = await fetch(url.toString(), {
      method,
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Secret": process.env.INTERNAL_API_SECRET || "",
      },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: controller.signal,
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`${method} ${path} returned ${response.status}: ${text.slice(0, 300)}`);
    }
    return (await response.json()) as T;
  } catch (err) {
    if (controller.signal.aborted)
      throw new Error(`${method} ${path} timed out after ${BACKEND_TIMEOUT_MS}ms`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export const signalsBackend: SignalsBackend = {
  async waitingHits(projectId, detectorId, sinceMs, limit) {
    const body = await call<{ data: WaitingHitRow[] }>(
      "GET",
      "/api/v1/internal/signals/waiting-hits",
      {
        params: {
          project_id: projectId,
          detector_id: detectorId,
          since_ms: String(Math.floor(sinceMs)),
          limit: String(limit),
        },
      },
    );
    return body.data;
  },
  async writeAssignments(rows) {
    if (rows.length === 0) return;
    await call("POST", "/api/v1/internal/signals/assignments", { body: { rows } });
  },
  async traceFindings(projectId, traceId) {
    const body = await call<{ findings: TraceFindingRow[] }>(
      "GET",
      `/api/v1/internal/traces/${encodeURIComponent(traceId)}/findings`,
      { params: { project_id: projectId } },
    );
    return body.findings;
  },
};
