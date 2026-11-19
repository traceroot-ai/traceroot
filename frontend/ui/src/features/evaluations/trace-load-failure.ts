import { ApiError } from "@/lib/api/errors";
import { isRetentionError } from "@/lib/api/retention";

/**
 * Why a result's reported trace failed to load, as the run detail explains it:
 *
 * - `ingesting`  not found, and the result was recorded moments ago: its telemetry
 *                is plausibly still on its way through ingestion.
 * - `delayed`    still not found past the ingest window or after repeated loads. It
 *                may yet arrive, but nothing says it will, so we don't promise it.
 * - `signed-out` the request carried no valid session (401).
 * - `forbidden`  the account may not read this project's traces (403).
 * - `retention`  outside the plan's retention window (a policy 403); the trace
 *                viewer renders its own banner for this one.
 * - `failed`     a server error, a network failure or timeout, or any other refusal.
 */
export type TraceLoadFailure =
  | "ingesting"
  | "delayed"
  | "signed-out"
  | "forbidden"
  | "retention"
  | "failed";

/**
 * How long after a result is recorded a missing trace still reads as "ingesting".
 * The SDK exports spans in batches (a 5s delay, a 30s export timeout) and ingestion
 * runs behind a queue, so a healthy trace lands well inside this window; past it, a
 * miss is no longer evidence that the trace is on its way.
 */
export const TRACE_INGEST_WINDOW_MS = 2 * 60_000;

/** Failed loads after which a missing trace stops reading as "ingesting", however recent. */
export const TRACE_NOT_FOUND_MAX_LOADS = 3;

export function classifyTraceLoadFailure({
  error,
  failedLoads,
  recordedAt,
  now = Date.now(),
}: {
  error: unknown;
  /** Loads of this trace that ended in an error so far (each includes its retries). */
  failedLoads: number;
  /** When the result that reported the trace was recorded (ISO). */
  recordedAt: string | null | undefined;
  now?: number;
}): TraceLoadFailure {
  if (!(error instanceof ApiError)) return "failed"; // network failure or unexpected throw
  if (error.status === 404) {
    if (failedLoads >= TRACE_NOT_FOUND_MAX_LOADS) return "delayed";
    // An unknown or unparseable record time stays "ingesting": not knowing when the
    // result landed is no evidence that its trace is late.
    const recorded = recordedAt ? new Date(recordedAt).getTime() : NaN;
    return Number.isNaN(recorded) || now - recorded < TRACE_INGEST_WINDOW_MS
      ? "ingesting"
      : "delayed";
  }
  if (isRetentionError(error)) return "retention";
  if (error.status === 401) return "signed-out";
  if (error.status === 403) return "forbidden";
  return "failed";
}
