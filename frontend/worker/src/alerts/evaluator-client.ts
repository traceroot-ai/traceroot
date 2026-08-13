/**
 * Internal API client for evaluating alert rules. Node owns the schedule and
 * the state; only the Python backend has a ClickHouse client, so the metric is
 * computed there.
 */

import { isAlertFilterOperator, type AlertFilter } from "@traceroot/core";

const BACKEND_URL = process.env.BACKEND_INTERNAL_URL || "http://localhost:8000";
const INTERNAL_API_SECRET = process.env.INTERNAL_API_SECRET || "";
const EVALUATE_TIMEOUT_MS = 30_000;

/**
 * `MAX_ALERTS_PER_REQUEST` in backend/rest/schemas/alerts.py is the ceiling the
 * server enforces — a longer list is a 422 that fails the whole batch — and
 * this side cannot import it, so it is restated and chunked against. The chunk
 * stays below the cap because every alert costs up to two capped ClickHouse
 * reads and the client aborts at EVALUATE_TIMEOUT_MS.
 */
export const MAX_ALERTS_PER_REQUEST = 50;
export const ALERT_EVALUATION_CHUNK_SIZE = Math.min(25, MAX_ALERTS_PER_REQUEST);

/**
 * Requests in flight at once, across every project the tick claimed. A chunk is
 * already up to fifty capped ClickHouse reads, so width here multiplies into
 * the backend: past this the queueing alone outlasts EVALUATE_TIMEOUT_MS and
 * every rule in the tick fails together.
 */
export const ALERT_EVALUATION_CONCURRENCY = 4;

export interface AlertEvaluationSpec {
  readonly alert_id: string;
  readonly view: string;
  readonly measure: string;
  readonly aggregation: string;
  readonly filters: readonly AlertFilter[];
}

export interface AlertEvaluationResult {
  readonly alert_id: string;
  readonly value: number | null;
  readonly row_count: number;
  readonly error: string | null;
}

export interface AlertEvaluationRequest {
  readonly projectId: string;
  readonly windowStart: Date;
  readonly windowEnd: Date;
  readonly alerts: readonly AlertEvaluationSpec[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Whether the backend's filter model will accept this spec. It refuses a
 * violation as a request-validation error over the whole batch rather than as
 * one alert's `error`, so a rule stored before that vocabulary was enforced
 * would otherwise silence every alert sharing its window.
 */
export function isSendableAlertSpec(spec: AlertEvaluationSpec): boolean {
  return spec.filters.every(
    (filter: AlertFilter) =>
      filter.field.length > 0 &&
      isAlertFilterOperator(filter.op) &&
      (typeof filter.value === "number"
        ? Number.isFinite(filter.value)
        : typeof filter.value === "string" && filter.value.length > 0),
  );
}

function parseResult(entry: unknown): AlertEvaluationResult | null {
  if (!isRecord(entry) || typeof entry.alert_id !== "string") return null;
  return {
    alert_id: entry.alert_id,
    value: typeof entry.value === "number" && Number.isFinite(entry.value) ? entry.value : null,
    row_count: typeof entry.row_count === "number" ? entry.row_count : 0,
    error: typeof entry.error === "string" && entry.error.length > 0 ? entry.error : null,
  };
}

export async function evaluateAlerts(
  request: AlertEvaluationRequest,
): Promise<AlertEvaluationResult[]> {
  const response = await fetch(`${BACKEND_URL}/api/v1/internal/alert-evaluate`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Internal-Secret": INTERNAL_API_SECRET,
    },
    body: JSON.stringify({
      project_id: request.projectId,
      window_start: request.windowStart.toISOString(),
      window_end: request.windowEnd.toISOString(),
      alerts: request.alerts,
    }),
    signal: AbortSignal.timeout(EVALUATE_TIMEOUT_MS),
  });

  if (!response.ok) {
    // The body is withheld: a FastAPI validation error echoes the request under
    // `input`, which carries every filter value the user typed.
    const body = await response.text();
    throw new Error(
      `Backend API error ${response.status} (alerts=${request.alerts.length}, body=${body.length} bytes withheld)`,
    );
  }

  const body: unknown = await response.json();
  const results = isRecord(body) ? body.results : undefined;
  if (!Array.isArray(results)) {
    throw new Error("Backend API error: alert-evaluate returned no results array");
  }

  return results
    .map(parseResult)
    .filter((result): result is AlertEvaluationResult => result !== null);
}
