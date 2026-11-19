/**
 * React Query hooks for the server-backed evaluation feature. Mirrors the
 * detectors hooks: queryKey arrays, fetch() against the committed Route Handlers,
 * throw on !res.ok, enabled on projectId, mutations invalidate the caches.
 */
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  DatasetRow,
  DatasetDetailResponse,
  EvaluationRow,
  RunRow,
  RunDetailResponse,
  EvalResultStatus,
  ScoreRow,
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
    queryKey: [
      "datasets",
      "list",
      projectId,
      query.search_query ?? null,
      query.page ?? 0,
      query.limit ?? null,
    ],
    queryFn: () =>
      getJson<{ data: DatasetRow[]; meta: Meta }>(
        `/api/projects/${projectId}/datasets${qs ? `?${qs}` : ""}`,
      ),
    enabled: !!projectId,
    placeholderData: (prev, prevQuery) => (prevQuery?.queryKey[2] === projectId ? prev : undefined),
  });
}

export function useDataset(projectId: string, datasetId: string, versionId?: string | null) {
  const qs = versionId ? `?version_id=${encodeURIComponent(versionId)}` : "";
  return useQuery({
    queryKey: ["datasets", "detail", projectId, datasetId, versionId ?? null],
    queryFn: () =>
      getJson<DatasetDetailResponse>(`/api/projects/${projectId}/datasets/${datasetId}${qs}`),
    enabled: !!projectId && !!datasetId,
    placeholderData: (prev, prevQuery) => (prevQuery?.queryKey[2] === projectId ? prev : undefined),
  });
}

export function useCreateDataset(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { name: string; description?: string | null }) =>
      sendJson<{ dataset: DatasetRow; created: boolean }>(
        `/api/projects/${projectId}/datasets`,
        "POST",
        input,
      ),
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
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["datasets"] });
      // Refresh the trace's span→dataset chips so a just-saved span is marked.
      void qc.invalidateQueries({ queryKey: ["evaluations", "trace-test-cases"] });
    },
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
        `/api/projects/${projectId}/datasets/${datasetId}/test-cases/${encodeURIComponent(args.testCaseId)}`,
        "PATCH",
        args.patch,
      ),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["datasets"] }),
  });
}

/** Delete a test case → publishes a new version without it (older snapshots keep it). */
export function useDeleteTestCase(projectId: string, datasetId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (testCaseId: string) =>
      sendJson<{ versionId: string; versionNumber: number }>(
        `/api/projects/${projectId}/datasets/${datasetId}/test-cases/${encodeURIComponent(testCaseId)}`,
        "DELETE",
        undefined,
      ),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["datasets"] }),
  });
}

export interface TestCaseRunRow {
  resultId: string;
  runId: string;
  runNumber: number;
  candidateVersion: string;
  evaluationName: string;
  /** The dataset version this run measured — used to hide runs that measured a
   *  DIFFERENT version of this row (a different input/expected association). */
  datasetVersionId: string;
  ranAt: string;
  status: string;
  change: "improved" | "regressed" | "unchanged" | null;
  /** Run-level totals (summed over the run's cases), à la the Experiments list. */
  caseCount: number;
  cost: number | null;
  elapsedMs: number | null;
}

/** Every evaluation run that measured a given test case (newest first). */
export function useTestCaseRuns(projectId: string, datasetId: string, testCaseId: string | null) {
  return useQuery({
    queryKey: ["datasets", projectId, datasetId, "test-case-runs", testCaseId],
    queryFn: () =>
      getJson<{ data: TestCaseRunRow[] }>(
        `/api/projects/${projectId}/datasets/${datasetId}/test-cases/${encodeURIComponent(testCaseId!)}/runs`,
      ),
    enabled: !!projectId && !!datasetId && !!testCaseId,
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
    started_after?: string;
    started_before?: string;
    page?: number;
    limit?: number;
  } = {},
) {
  const params = new URLSearchParams();
  if (query.evaluation_id) params.set("evaluation_id", query.evaluation_id);
  if (query.dataset_id) params.set("dataset_id", query.dataset_id);
  if (query.status) params.set("status", query.status);
  if (query.search_query) params.set("search_query", query.search_query);
  if (query.started_after) params.set("started_after", query.started_after);
  if (query.started_before) params.set("started_before", query.started_before);
  if (query.page !== undefined) params.set("page", String(query.page));
  if (query.limit !== undefined) params.set("limit", String(query.limit));
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
      query.started_after ?? null,
      query.started_before ?? null,
      query.page ?? 0,
      query.limit ?? null,
    ],
    queryFn: () =>
      getJson<{ data: RunRow[]; meta: Meta }>(
        `/api/projects/${projectId}/evaluations/runs${qs ? `?${qs}` : ""}`,
      ),
    enabled: !!projectId,
    placeholderData: (prev, prevQuery) => (prevQuery?.queryKey[2] === projectId ? prev : undefined),
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

/**
 * Fetch the full detail (run + per-case results) for several runs at once — the
 * data behind the N-run comparison page. Shares the exact per-run queryKey with
 * `useEvaluationRun`, so a run already loaded elsewhere is served from cache.
 */
export function useEvaluationRunDetails(projectId: string, runIds: string[]) {
  return useQueries({
    queries: runIds.map((runId) => ({
      queryKey: ["evaluations", "run", projectId, runId],
      queryFn: () =>
        getJson<RunDetailResponse>(`/api/projects/${projectId}/evaluations/runs/${runId}`),
      enabled: !!projectId && !!runId,
    })),
  });
}

export interface TraceEvaluationResultRow {
  id: string;
  runId: string;
  testCaseId: string;
  traceId: string | null;
  status: EvalResultStatus;
  scores: ScoreRow[];
  run: {
    id: string;
    runNumber: number;
    candidateVersion: string;
    datasetId: string;
    datasetVersionId: string;
    evaluation: { id: string; name: string };
    datasetVersion: { label: string };
  };
}

/** Evaluation results a trace produced — the trace -> evaluation-run link. */
export function useTraceEvaluationResults(projectId: string, traceId: string) {
  return useQuery({
    queryKey: ["evaluations", "trace-results", projectId, traceId],
    queryFn: () =>
      getJson<{ data: TraceEvaluationResultRow[] }>(
        `/api/projects/${projectId}/traces/${traceId}/evaluation-results`,
      ),
    enabled: !!projectId && !!traceId,
  });
}

export interface TraceTestCaseRow {
  testCaseId: string;
  datasetId: string;
  /** SDK-addressable dataset id ("ds_…"); null for UI-authored datasets, which
   *  are addressed by the cuid `datasetId` instead (both resolve server-side). */
  datasetClientId: string | null;
  datasetName: string;
  sourceSpanId: string | null;
  review: string;
  datasetVersionLabel: string;
  datasetUpdatedAt: string;
  caseCount: number;
}

/**
 * Dataset test cases captured from a given trace, keyed by source span. Powers
 * the "In <dataset>" chip that marks a span already saved as a test case.
 */
export function useTraceTestCases(projectId: string, traceId: string) {
  return useQuery({
    queryKey: ["evaluations", "trace-test-cases", projectId, traceId],
    queryFn: () =>
      getJson<{ data: TraceTestCaseRow[] }>(
        `/api/projects/${projectId}/traces/${traceId}/test-cases`,
      ),
    enabled: !!projectId && !!traceId,
    // Warmed when the trace opens (see the traces page) and reused as spans are
    // selected, so the "Dataset:" chip appears without a per-span round trip.
    staleTime: 60_000,
  });
}

/** Delete one or more evaluation runs (cascades their results + scores). */
export function useDeleteRuns(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (runIds: string[]) =>
      Promise.all(
        runIds.map((id) =>
          sendJson<{ deleted: boolean }>(
            `/api/projects/${projectId}/evaluations/runs/${id}`,
            "DELETE",
            undefined,
          ),
        ),
      ),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["evaluations", "runs"] }),
  });
}

export interface ScorerRegistryRow {
  name: string;
  version: string;
  /** Stable SEMANTIC identity across SDK languages (manifest `key`, or `name` when absent).
   *  Lets the UI group Python + TypeScript implementations of the same scorer. */
  key: string;
  scoreCount: number;
  errorCount: number;
  errorRate: number;
  /** Inferred from which value column the scores populate. */
  valueType: "numeric" | "boolean" | "categorical" | "mixed" | "unknown";
  /** Declared metadata from the run's scorers JSON (when the SDK sends it). */
  declaredValueType: "numeric" | "boolean" | "categorical" | null;
  direction: "higher_is_better" | "lower_is_better" | "none" | null;
  threshold: number | null;
  /** Numeric summary over successfully-scored numeric values (else null). */
  numeric: { mean: number; min: number; max: number; count: number } | null;
  /** Fraction of scores marked passed (else null when the scorer sets no `passed`). */
  passRate: number | null;
  /** Boolean (true/false) or categorical value counts, most-common first. */
  distribution: Array<{ label: string; count: number }> | null;
  runCount: number;
  evaluationCount: number;
  lastUsed: string | null;
  recentErrors: Array<{ message: string; at: string }>;
  /** Always "SDK": the catalog only shows what the SDK reported. */
  source: "SDK";
  // SDK-reported scorer DEFINITION.
  // Every field is optional — absent → "Not provided by SDK", never inferred.
  scorerType: "llm_judge" | "code" | null;
  outputType: "score" | "classification" | null;
  description: string | null;
  /** Inputs the scorer reads (e.g. "expected"); null = the SDK didn't declare them. */
  requiredInputs: string[] | null;
  metadata: unknown | null;
  model: string | null;
  messages: Array<{ role: string; content: string }> | null;
  language: "python" | "typescript" | null;
  sourceCode: string | null;
}

/** One scorer family (all versions of a name) + a family-level usage summary. */
export interface ScorerFamilyResponse {
  name: string;
  versions: ScorerRegistryRow[];
  usage: {
    runCount: number;
    evaluationCount: number;
    scoreCount: number;
    errorCount: number;
    lastUsed: string | null;
  };
  source: "SDK";
}

/** Read-only scorer registry, aggregated from reported runs. */
export function useScorers(projectId: string) {
  return useQuery({
    queryKey: ["evaluations", "scorers", projectId],
    queryFn: () =>
      getJson<{ data: ScorerRegistryRow[] }>(`/api/projects/${projectId}/evaluations/scorers`),
    enabled: !!projectId,
  });
}

/** One scorer family (its versions + usage), for the scorer detail. */
export function useScorer(projectId: string, name: string | null) {
  return useQuery({
    queryKey: ["evaluations", "scorer", projectId, name],
    queryFn: () =>
      getJson<ScorerFamilyResponse>(
        `/api/projects/${projectId}/evaluations/scorers/${encodeURIComponent(name!)}`,
      ),
    enabled: !!projectId && !!name,
  });
}
