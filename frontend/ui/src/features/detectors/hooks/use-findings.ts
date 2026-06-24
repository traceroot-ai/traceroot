import { useQuery } from "@tanstack/react-query";

/** Snake-case shape returned by the backend */
export interface BackendFinding {
  finding_id: string;
  trace_id: string;
  project_id: string;
  timestamp: string;
  summary: string;
  payload: string;
  /**
   * Stored RCA status for this finding, enriched by the findings proxy route.
   * null = no DetectorRca row (RCA skipped — disabled on every detector that
   * fired); absent = enrichment unavailable.
   */
  rca_status?: "pending" | "running" | "done" | "failed" | null;
}

/** How a finding's `rca_status` renders in the "Agent analysis" column. */
export interface RcaStatusPresentation {
  label: string;
  className: string;
  title?: string;
}

/**
 * Single source of truth for the agent-analysis status vocabulary:
 * absent field (enrichment unavailable) -> "—", null (no stored RCA row) ->
 * "Skipped", terminal/in-flight statuses -> their labels. An unrecognized
 * future status renders as its raw value rather than a misleading in-flight
 * state.
 */
export function describeRcaStatus(status: BackendFinding["rca_status"]): RcaStatusPresentation {
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
  if (status === "pending") return { label: "Queued", className: "text-muted-foreground" };
  if (status === "running") return { label: "Running…", className: "text-muted-foreground" };
  return { label: status, className: "text-muted-foreground" };
}

/** Pagination metadata returned alongside data arrays. */
export interface PaginationMeta {
  page: number;
  limit: number;
  total: number;
}

/**
 * Query options shape mirrors `TraceQueryOptions` so a `useListPageState`
 * `queryOptions` object can be spread directly into either hook.
 */
export interface FindingsQuery {
  page?: number;
  limit?: number;
  /** ISO-8601 lower bound on `timestamp` (inclusive). */
  start_after?: string;
  /** ISO-8601 upper bound on `timestamp` (exclusive). */
  end_before?: string;
  /** Substring match against trace_id OR summary. */
  search_query?: string;
}

export interface FindingsResponse {
  data: BackendFinding[];
  meta: PaginationMeta;
}

async function fetchFindings(
  projectId: string,
  detectorId: string,
  query: FindingsQuery = {},
): Promise<FindingsResponse> {
  const params = new URLSearchParams();
  if (query.page !== undefined) params.set("page", String(query.page));
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  if (query.start_after) params.set("start_after", query.start_after);
  if (query.end_before) params.set("end_before", query.end_before);
  if (query.search_query) params.set("search_query", query.search_query);

  const qs = params.toString();
  const url = `/api/projects/${projectId}/detectors/${detectorId}/findings${qs ? `?${qs}` : ""}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch findings: ${res.status}`);
  return res.json() as Promise<FindingsResponse>;
}

async function fetchTraceFindings(
  projectId: string,
  traceId: string,
): Promise<{ findings: BackendFinding[] }> {
  const url = `/api/projects/${projectId}/traces/${traceId}/findings`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch trace findings: ${res.status}`);
  return res.json() as Promise<{ findings: BackendFinding[] }>;
}

export function useFindings(projectId: string, detectorId: string, query: FindingsQuery = {}) {
  return useQuery({
    queryKey: [
      "findings",
      projectId,
      detectorId,
      query.page ?? 0,
      query.limit ?? 50,
      query.search_query ?? null,
      query.start_after ?? null,
      query.end_before ?? null,
    ],
    queryFn: () => fetchFindings(projectId, detectorId, query),
    enabled: !!projectId && !!detectorId,
  });
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

/** How an RCA status renders in the trace-detail header. */
export interface TraceRcaStatusPresentation {
  label: string;
  className: string;
  title: string;
  busy?: boolean;
}

export function describeTraceRcaStatus(status: DetectorRca["status"]): TraceRcaStatusPresentation {
  if (status === "pending") {
    return {
      label: "RCA queued",
      className:
        "border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-400",
      title: "Root cause analysis is queued",
    };
  }
  if (status === "running") {
    return {
      label: "RCA running…",
      className:
        "border-blue-300 bg-blue-50 text-blue-700 dark:border-blue-800 dark:bg-blue-950/40 dark:text-blue-400",
      title: "Root cause analysis is running",
      busy: true,
    };
  }
  if (status === "done") {
    return {
      label: "RCA ready",
      className:
        "border-red-300 bg-red-50 text-red-700 hover:bg-red-100 dark:border-red-800 dark:bg-red-950/40 dark:text-red-400 dark:hover:bg-red-950/60",
      title: "Open root cause analysis",
    };
  }
  return {
    label: "RCA failed",
    className:
      "border-destructive/40 bg-destructive/10 text-destructive dark:border-destructive/50",
    title: "Root cause analysis failed",
  };
}

async function fetchRca(
  projectId: string,
  findingId: string,
): Promise<{ rca: DetectorRca | null }> {
  const url = `/api/projects/${projectId}/findings/${findingId}/rca`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch RCA: ${res.status}`);
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
}

export interface RunsQuery {
  page?: number;
  limit?: number;
  start_after?: string;
  end_before?: string;
  search_query?: string;
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

  const qs = params.toString();
  const url = `/api/projects/${projectId}/detectors/${detectorId}/runs${qs ? `?${qs}` : ""}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch runs: ${res.status}`);
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
