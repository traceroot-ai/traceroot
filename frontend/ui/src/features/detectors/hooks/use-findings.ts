import { useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { ApiError } from "@/lib/api/client";

/** Snake-case shape returned by the backend for a trace's findings */
export interface BackendFinding {
  finding_id: string;
  trace_id: string;
  project_id: string;
  timestamp: string;
  summary: string;
  payload: string;
}

/** How a run's `rca_status` renders in the "Agent analysis" column. */
export interface RcaStatusPresentation {
  label: string;
  className: string;
  title?: string;
}

/**
 * Single source of truth for the agent-analysis status vocabulary:
 * absent field (enrichment unavailable) -> "—", null (no stored RCA row) ->
 * "Skipped", terminal/in-flight statuses -> their labels. An unrecognized
 * future status renders as its raw value rather than a misleading "Running…".
 */
export function describeRcaStatus(status: BackendRun["rca_status"]): RcaStatusPresentation {
  if (status === undefined) {
    return { label: "—", className: "font-mono text-[11px] text-muted-foreground" };
  }
  if (status === null) {
    return {
      label: "Skipped",
      className: "text-muted-foreground",
      title: "Root cause analysis was off for the detector(s) that fired",
    };
  }
  if (status === "failed") return { label: "Failed", className: "text-destructive" };
  if (status === "done") return { label: "Done", className: "text-foreground" };
  if (status === "pending" || status === "running") {
    return { label: "Running…", className: "text-muted-foreground" };
  }
  return { label: status, className: "text-muted-foreground" };
}

/** Pagination metadata returned alongside data arrays. */
export interface PaginationMeta {
  page: number;
  limit: number;
  total: number;
}

/**
 * GET a detector endpoint. Failures become an ApiError carrying the backend's
 * `detail`, which callers branch on (e.g. retention gating).
 */
async function getJson<T>(url: string, what: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    const fallback = `Failed to fetch ${what}: ${res.status}`;
    const body = await res.json().catch(() => ({ detail: fallback }));
    throw new ApiError(res.status, body.detail ?? fallback);
  }
  return res.json() as Promise<T>;
}

function fetchTraceFindings(projectId: string, traceId: string) {
  return getJson<{ findings: BackendFinding[] }>(
    `/api/projects/${projectId}/traces/${traceId}/findings`,
    "trace findings",
  );
}

export interface DetectorRca {
  id: string;
  findingId: string;
  sessionId: string | null;
  status: "pending" | "running" | "done" | "failed";
  result: string | null;
  completedAt: string | null;
  createTime: string;
}

function fetchRca(projectId: string, findingId: string) {
  return getJson<{ rca: DetectorRca | null }>(
    `/api/projects/${projectId}/findings/${findingId}/rca`,
    "RCA",
  );
}

// The worker writes findings, runs and RCA after a trace is ingested, so a trace
// opened live starts with none of them. These queries poll until they arrive, so
// the Alert button, Detectors tab and RCA answer show up without a refresh.
export const TRACE_POLL_INTERVAL_MS = 3000;
// Waiting for results the pipeline still owes us. Must outlast it: evaluation
// waits for the trace to go quiet (EVALUATOR_DELAY, ~60s) and jobs have no cap.
export const TRACE_POLL_WINDOW_MS = 300000;
// Waiting out a write race, where the record should already be there. Short,
// because the alternative is polling for minutes on a trace that has nothing
// coming at all.
export const TRACE_POLL_GRACE_MS = 30000;

/** Poll until `settled`, giving up at `windowMs`. */
function pollUntilSettled(settled: boolean, elapsedMs: number, windowMs: number): number | false {
  if (settled) return false;
  return elapsedMs < windowMs ? TRACE_POLL_INTERVAL_MS : false;
}

/** Settled once a finding exists: the Alert button and useRca take over. */
export function findingsPollInterval(findingCount: number, elapsedMs: number): number | false {
  return pollUntilSettled(findingCount > 0, elapsedMs, TRACE_POLL_WINDOW_MS);
}

/**
 * A run row appears only once its detector finishes, so there is no way to tell
 * "all runs are in" from "one is still coming". Poll for the whole window.
 */
export function detectorRunsPollInterval(elapsedMs: number): number | false {
  return elapsedMs < TRACE_POLL_WINDOW_MS ? TRACE_POLL_INTERVAL_MS : false;
}

/**
 * Polls while the run is in flight. A missing row only gets the grace period: the
 * worker writes the finding before the row, so a fresh finding briefly has none —
 * but an RCA-disabled detector never writes one at all.
 */
export function rcaPollInterval(
  status: DetectorRca["status"] | undefined,
  elapsedMs: number,
): number | false {
  if (status === "pending" || status === "running") return TRACE_POLL_INTERVAL_MS;
  return pollUntilSettled(status !== undefined, elapsedMs, TRACE_POLL_GRACE_MS); // done|failed => settled
}

/**
 * Milliseconds since `key` last changed. Switching trace or finding restarts the
 * window, so each freshly-opened one gets the full wait.
 */
function useElapsedSince(key: string): () => number {
  const ref = useRef<{ key: string; at: number }>({ key, at: Date.now() });
  if (ref.current.key !== key) ref.current = { key, at: Date.now() };
  return () => Date.now() - ref.current.at;
}

export function useRca(projectId: string, findingId: string) {
  const elapsed = useElapsedSince(findingId);
  return useQuery({
    queryKey: ["detector-rca", projectId, findingId],
    queryFn: () => fetchRca(projectId, findingId),
    enabled: !!projectId && !!findingId,
    refetchInterval: (query) => rcaPollInterval(query.state.data?.rca?.status, elapsed()),
  });
}

/** Snake-case shape returned by the backend for a single detector run */
export interface BackendRun {
  run_id: string;
  detector_id: string;
  project_id: string;
  trace_id: string;
  finding_id: string | null;
  status: string;
  timestamp: string;
  /** Per-detector summary from the finding payload. Empty string when not triggered. */
  summary: string;
  /**
   * Human-readable detector name, joined in the trace-detector-runs proxy.
   * Falls back to `detector_id` when the detector was deleted.
   */
  name?: string;
  /**
   * Stored RCA status for a triggered run, enriched by the runs proxy route.
   * null = no DetectorRca row (RCA skipped — disabled on every detector that
   * fired); absent = enrichment unavailable or the run never triggered.
   */
  rca_status?: "pending" | "running" | "done" | "failed" | null;
}

export interface RunsQuery {
  page?: number;
  limit?: number;
  start_after?: string;
  end_before?: string;
  search_query?: string;
  /** When true, return only triggered runs (finding_id IS NOT NULL). */
  identified?: boolean;
}

export interface RunsResponse {
  data: BackendRun[];
  meta: PaginationMeta;
}

function fetchRuns(projectId: string, detectorId: string, query: RunsQuery = {}) {
  const params = new URLSearchParams();
  if (query.page !== undefined) params.set("page", String(query.page));
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  if (query.start_after) params.set("start_after", query.start_after);
  if (query.end_before) params.set("end_before", query.end_before);
  if (query.search_query) params.set("search_query", query.search_query);
  if (query.identified) params.set("identified", "true");

  const qs = params.toString();
  return getJson<RunsResponse>(
    `/api/projects/${projectId}/detectors/${detectorId}/runs${qs ? `?${qs}` : ""}`,
    "runs",
  );
}

export function useRuns(projectId: string, detectorId: string, query: RunsQuery = {}) {
  return useQuery({
    queryKey: [
      "detector-runs",
      projectId,
      detectorId,
      query.page ?? 0,
      query.limit ?? 50,
      query.search_query ?? null,
      query.start_after ?? null,
      query.end_before ?? null,
      query.identified ?? false,
    ],
    queryFn: () => fetchRuns(projectId, detectorId, query),
    enabled: !!projectId && !!detectorId,
  });
}

export function useTraceFindings(projectId: string, traceId: string) {
  const elapsed = useElapsedSince(traceId);
  return useQuery({
    queryKey: ["trace-findings", projectId, traceId],
    queryFn: () => fetchTraceFindings(projectId, traceId),
    enabled: !!projectId && !!traceId,
    refetchInterval: (query) =>
      findingsPollInterval(query.state.data?.findings?.length ?? 0, elapsed()),
  });
}

function fetchTraceDetectorRuns(projectId: string, traceId: string) {
  return getJson<{ runs: BackendRun[] }>(
    `/api/projects/${projectId}/traces/${traceId}/detector-runs`,
    "trace detector runs",
  );
}

export function useTraceDetectorRuns(projectId: string, traceId: string) {
  const elapsed = useElapsedSince(traceId);
  return useQuery({
    queryKey: ["trace-detector-runs", projectId, traceId],
    queryFn: () => fetchTraceDetectorRuns(projectId, traceId),
    enabled: !!projectId && !!traceId,
    refetchInterval: () => detectorRunsPollInterval(elapsed()),
  });
}
