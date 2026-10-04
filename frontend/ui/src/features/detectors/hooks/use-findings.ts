import { useQuery } from "@tanstack/react-query";
import type { TraceStatus } from "@traceroot/core";
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

/** Pagination metadata returned alongside data arrays. */
export interface PaginationMeta {
  page: number;
  limit: number;
  total: number;
}

async function fetchTraceFindings(
  projectId: string,
  traceId: string,
): Promise<{ findings: BackendFinding[] }> {
  const url = `/api/projects/${projectId}/traces/${traceId}/findings`;
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res
      .json()
      .catch(() => ({ detail: `Failed to fetch trace findings: ${res.status}` }));
    throw new ApiError(res.status, body.detail ?? `Failed to fetch trace findings: ${res.status}`);
  }
  return res.json() as Promise<{ findings: BackendFinding[] }>;
}

export interface DetectorRca {
  id: string;
  findingId: string;
  sessionId: string | null;
  status: "pending" | "running" | "done" | "failed";
  result: string | null;
  completedAt: string | null;
  createTime: string;
  /**
   * Agent trace of the newest execution whose trace is `available`, so the link
   * survives a pending retry; when none is, the current (highest-attempt)
   * execution's trace and its pending/failed/disabled status. Null when the
   * finding has no execution row.
   */
  traceId: string | null;
  traceStatus: TraceStatus | null;
  /** Current (highest) attempt; null when the finding has no execution row. */
  attempt: number | null;
}

async function fetchRca(
  projectId: string,
  findingId: string,
): Promise<{ rca: DetectorRca | null }> {
  const url = `/api/projects/${projectId}/findings/${findingId}/rca`;
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.json().catch(() => ({ detail: `Failed to fetch RCA: ${res.status}` }));
    throw new ApiError(res.status, body.detail ?? `Failed to fetch RCA: ${res.status}`);
  }
  return res.json() as Promise<{ rca: DetectorRca | null }>;
}

export function useRca(projectId: string, findingId: string) {
  return useQuery({
    queryKey: ["detector-rca", projectId, findingId],
    queryFn: () => fetchRca(projectId, findingId),
    enabled: !!projectId && !!findingId,
    refetchInterval: (query) => {
      const status = query.state.data?.rca?.status;
      // Poll while running/pending, stop once done or failed
      return status === "running" || status === "pending" ? 3000 : false;
    },
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
   * The signal this triggered run's hit belongs to, enriched by the runs proxy.
   * null = not grouped (yet); absent = enrichment unavailable or the run never
   * triggered.
   */
  signal_id?: string | null;
  /**
   * The agent trace of the RCA that analysed this run's own trace for its
   * signal, enriched by the runs proxy; null when the run only joined a signal
   * analysed on another trace, or no attempt's trace has landed yet.
   */
  agent_trace_id?: string | null;
  /**
   * True when the worker emitted a self-trace for this run (trace_id = run_id);
   * gates the runs-tab link to the run's own trace. Optional for back-compat
   * with reads from an un-migrated backend, which imply false.
   */
  self_traced?: boolean;
}

/**
 * A run's self-trace id is its dashless run_id (trace_id = run_id by
 * construction on the emit side). One shared helper so every self-trace
 * opener and matcher derives the id the same way.
 */
export function selfTraceId(run: Pick<BackendRun, "run_id">): string {
  return run.run_id.replaceAll("-", "");
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

async function fetchRuns(
  projectId: string,
  detectorId: string,
  query: RunsQuery = {},
): Promise<RunsResponse> {
  const params = new URLSearchParams();
  if (query.page !== undefined) params.set("page", String(query.page));
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  if (query.start_after) params.set("start_after", query.start_after);
  if (query.end_before) params.set("end_before", query.end_before);
  if (query.search_query) params.set("search_query", query.search_query);
  if (query.identified) params.set("identified", "true");

  const qs = params.toString();
  const url = `/api/projects/${projectId}/detectors/${detectorId}/runs${qs ? `?${qs}` : ""}`;
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.json().catch(() => ({ detail: `Failed to fetch runs: ${res.status}` }));
    throw new ApiError(res.status, body.detail ?? `Failed to fetch runs: ${res.status}`);
  }
  return res.json() as Promise<RunsResponse>;
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
  return useQuery({
    queryKey: ["trace-findings", projectId, traceId],
    queryFn: () => fetchTraceFindings(projectId, traceId),
    enabled: !!projectId && !!traceId,
  });
}

async function fetchTraceDetectorRuns(
  projectId: string,
  traceId: string,
): Promise<{ runs: BackendRun[] }> {
  const url = `/api/projects/${projectId}/traces/${traceId}/detector-runs`;
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res
      .json()
      .catch(() => ({ detail: `Failed to fetch trace detector runs: ${res.status}` }));
    throw new ApiError(
      res.status,
      body.detail ?? `Failed to fetch trace detector runs: ${res.status}`,
    );
  }
  return res.json() as Promise<{ runs: BackendRun[] }>;
}

export function useTraceDetectorRuns(projectId: string, traceId: string) {
  return useQuery({
    queryKey: ["trace-detector-runs", projectId, traceId],
    queryFn: () => fetchTraceDetectorRuns(projectId, traceId),
    enabled: !!projectId && !!traceId,
  });
}
