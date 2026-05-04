import { useQuery } from "@tanstack/react-query";

/** Snake-case shape returned by the backend */
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
