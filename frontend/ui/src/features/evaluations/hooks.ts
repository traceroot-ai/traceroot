/**
 * React Query hooks for the server-backed evaluation feature. Mirrors the
 * detectors hooks: queryKey arrays, fetch() against the committed Route Handlers,
 * throw on !res.ok, enabled on projectId, mutations invalidate the caches.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  DatasetRow,
  DatasetDetailResponse,
  EvaluationRow,
  RunRow,
  RunDetailResponse,
} from "./types";

interface Meta {
  page: number;
  limit: number;
  total: number;
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Request failed: ${res.status}`);
  return res.json() as Promise<T>;
}

async function sendJson<T>(url: string, method: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => null);
    throw new Error(detail?.error ?? `Request failed: ${res.status}`);
  }
  return res.json() as Promise<T>;
}

// ---------------------------------------------------------------------------
// Datasets
// ---------------------------------------------------------------------------

export function useDatasets(
  projectId: string,
  query: { search_query?: string; page?: number; limit?: number } = {},
) {
  const params = new URLSearchParams();
  if (query.search_query) params.set("search_query", query.search_query);
  if (query.page !== undefined) params.set("page", String(query.page));
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  const qs = params.toString();
  return useQuery({
    queryKey: ["datasets", "list", projectId, query.search_query ?? null, query.page ?? 0],
    queryFn: () =>
      getJson<{ data: DatasetRow[]; meta: Meta }>(
        `/api/projects/${projectId}/datasets${qs ? `?${qs}` : ""}`,
      ),
    enabled: !!projectId,
    placeholderData: (prev) => prev,
  });
}

export function useDataset(projectId: string, datasetId: string) {
  return useQuery({
    queryKey: ["datasets", "detail", projectId, datasetId],
    queryFn: () =>
      getJson<DatasetDetailResponse>(`/api/projects/${projectId}/datasets/${datasetId}`),
    enabled: !!projectId && !!datasetId,
  });
}

export function useCreateDataset(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { name: string; description?: string | null }) =>
      sendJson<{ dataset: DatasetRow }>(`/api/projects/${projectId}/datasets`, "POST", input),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["datasets"] }),
  });
}

export function useUpdateDataset(projectId: string, datasetId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { name?: string; description?: string | null }) =>
      sendJson<{ dataset: DatasetRow }>(
        `/api/projects/${projectId}/datasets/${datasetId}`,
        "PATCH",
        input,
      ),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["datasets"] }),
  });
}

export function useDeleteDataset(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (datasetId: string) =>
      sendJson<{ deleted: boolean }>(
        `/api/projects/${projectId}/datasets/${datasetId}`,
        "DELETE",
        undefined,
      ),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["datasets"] }),
  });
}

export interface SaveTestCaseInput {
  input: string;
  expected?: string | null;
  recorded_output?: string | null;
  metadata?: Record<string, unknown> | null;
  review?: "needs_review" | "ready";
  capture_reason?: string;
  source_trace_id?: string | null;
  source_span_id?: string | null;
  source_span_name?: string | null;
  source_span_kind?: string | null;
}

export function useSaveTestCase(projectId: string, datasetId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: SaveTestCaseInput) =>
      sendJson<{ duplicate: boolean; testCaseId?: string; versionId?: string }>(
        `/api/projects/${projectId}/datasets/${datasetId}/test-cases`,
        "POST",
        input,
      ),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["datasets"] }),
  });
}

export function useUpdateTestCase(projectId: string, datasetId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: {
      testCaseId: string;
      patch: {
        input?: string;
        expected?: string | null;
        metadata?: Record<string, unknown> | null;
        review?: "needs_review" | "ready";
      };
    }) =>
      sendJson<{ versionId: string; versionNumber: number; focusTestCaseId: string }>(
        `/api/projects/${projectId}/datasets/${datasetId}/test-cases/${args.testCaseId}`,
        "PATCH",
        args.patch,
      ),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["datasets"] }),
  });
}

// ---------------------------------------------------------------------------
// Evaluations
// ---------------------------------------------------------------------------

export function useEvaluations(projectId: string) {
  return useQuery({
    queryKey: ["evaluations", "lineages", projectId],
    queryFn: () => getJson<{ data: EvaluationRow[] }>(`/api/projects/${projectId}/evaluations`),
    enabled: !!projectId,
  });
}

export function useEvaluationRuns(
  projectId: string,
  query: {
    evaluation_id?: string;
    dataset_id?: string;
    status?: string;
    search_query?: string;
    page?: number;
    limit?: number;
  } = {},
) {
  const params = new URLSearchParams();
  if (query.evaluation_id) params.set("evaluation_id", query.evaluation_id);
  if (query.dataset_id) params.set("dataset_id", query.dataset_id);
  if (query.status) params.set("status", query.status);
  if (query.search_query) params.set("search_query", query.search_query);
  if (query.page !== undefined) params.set("page", String(query.page));
  const qs = params.toString();
  return useQuery({
    queryKey: [
      "evaluations",
      "runs",
      projectId,
      query.evaluation_id ?? null,
      query.dataset_id ?? null,
      query.status ?? null,
      query.search_query ?? null,
      query.page ?? 0,
    ],
    queryFn: () =>
      getJson<{ data: RunRow[]; meta: Meta }>(
        `/api/projects/${projectId}/evaluations/runs${qs ? `?${qs}` : ""}`,
      ),
    enabled: !!projectId,
    placeholderData: (prev) => prev,
  });
}

export function useEvaluationRun(projectId: string, runId: string) {
  return useQuery({
    queryKey: ["evaluations", "run", projectId, runId],
    queryFn: () =>
      getJson<RunDetailResponse>(`/api/projects/${projectId}/evaluations/runs/${runId}`),
    enabled: !!projectId && !!runId,
  });
}

export function useCreateHumanScore(projectId: string, resultId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      verdict: "pass" | "fail" | "unsure";
      quality?: number | null;
      comment?: string | null;
      reviewer: string;
    }) =>
      sendJson(
        `/api/projects/${projectId}/evaluations/results/${resultId}/human-score`,
        "POST",
        input,
      ),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["evaluations", "run"] }),
  });
}
