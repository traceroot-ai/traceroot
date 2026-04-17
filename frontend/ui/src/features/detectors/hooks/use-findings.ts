import { useQuery } from "@tanstack/react-query";

/** Camel-case frontend model (legacy, kept for backward compat) */
export interface Finding {
  id: string;
  detectorId: string;
  traceId: string;
  projectId: string;
  identified: boolean;
  reasoning: string;
  output: Record<string, unknown>;
  createTime: string;
}

/** Snake-case shape returned by the backend */
export interface BackendFinding {
  finding_id: string;
  detector_id: string;
  trace_id: string;
  project_id: string;
  timestamp: string;
  summary: string;
  payload: string;
}

export interface FindingsQuery {
  limit?: number;
  offset?: number;
  since?: string;
}

async function fetchFindings(
  projectId: string,
  detectorId: string,
  query: FindingsQuery = {},
): Promise<{ findings: BackendFinding[] }> {
  const params = new URLSearchParams();
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  if (query.offset !== undefined) params.set("offset", String(query.offset));
  if (query.since) params.set("since", query.since);

  const qs = params.toString();
  const url = `/api/projects/${projectId}/detectors/${detectorId}/findings${qs ? `?${qs}` : ""}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch findings: ${res.status}`);
  return res.json() as Promise<{ findings: BackendFinding[] }>;
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
      query.limit ?? 50,
      query.offset ?? 0,
      query.since ?? null,
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
}

export interface RunsQuery {
  limit?: number;
  offset?: number;
}

async function fetchRuns(
  projectId: string,
  detectorId: string,
  query: RunsQuery = {},
): Promise<{ runs: BackendRun[] }> {
  const params = new URLSearchParams();
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  if (query.offset !== undefined) params.set("offset", String(query.offset));

  const qs = params.toString();
  const url = `/api/projects/${projectId}/detectors/${detectorId}/runs${qs ? `?${qs}` : ""}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch runs: ${res.status}`);
  return res.json() as Promise<{ runs: BackendRun[] }>;
}

export function useRuns(projectId: string, detectorId: string, query: RunsQuery = {}) {
  return useQuery({
    queryKey: ["detector-runs", projectId, detectorId, query.limit ?? 50, query.offset ?? 0],
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
