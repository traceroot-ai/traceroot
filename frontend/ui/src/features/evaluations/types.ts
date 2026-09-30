/**
 * Client-side shapes for the server-backed evaluation feature. Timestamps arrive
 * as ISO strings over JSON, so these mirror the Prisma rows with string dates.
 */
import type { RunComparison, ResultComparison } from "@/lib/eval/comparison";
import type { RunCoverage } from "@/lib/eval/coverage";

export type { RunComparison, ResultComparison } from "@/lib/eval/comparison";

/** The per-result comparison block the run-detail route embeds on each result. */
export type ResultRowComparison = Pick<
  ResultComparison,
  | "pairing"
  | "baselineDurationMs"
  | "durationDeltaMs"
  | "scorerCells"
  | "regressedCellCount"
  | "comparableCellCount"
> & {
  /** The baseline case's trace id (for diffing tokens/cost/latency); null if none. */
  baselineTraceId: string | null;
};

export type ReviewStatus = "needs_review" | "ready";
export type EvalResultStatus = "passed" | "failed" | "errored" | "not_scored";
export type EvalRunStatus =
  | "running"
  | "completed"
  | "completed_with_errors"
  | "failed"
  | "incomplete"
  | "cancelled";

export const EVAL_RUN_STATUS_LABEL: Record<EvalRunStatus, string> = {
  running: "Running",
  completed: "Completed",
  completed_with_errors: "Completed with errors",
  failed: "Failed",
  incomplete: "Incomplete",
  cancelled: "Cancelled",
};

export interface DatasetRow {
  id: string;
  // The SDK-facing id ("ds_…"); null for datasets authored in the UI. This is the
  // dataset's semantic id — `id` (a cuid) is only a URL/PK detail.
  clientDatasetId: string | null;
  projectId: string;
  name: string;
  description: string | null;
  currentVersionId: string | null;
  createTime: string;
  updateTime: string;
  caseCount: number;
  versionCount: number;
}

export interface DatasetVersionRow {
  id: string;
  datasetId: string;
  projectId: string;
  versionNumber: number;
  label: string;
  note: string | null;
  createdBy: string | null;
  createTime: string;
}

export interface TestCaseRow {
  id: string;
  testCaseId: string;
  datasetVersionId: string;
  datasetId: string;
  projectId: string;
  input: string;
  expected: string | null;
  metadata: unknown;
  review: ReviewStatus;
  captureReason: string;
  sourceTraceId: string | null;
  sourceSpanId: string | null;
  sourceSpanName: string | null;
  sourceSpanKind: string | null;
  addedBy: string | null;
  createTime: string;
}

export interface DatasetDetailResponse {
  dataset: DatasetRow;
  currentVersion: DatasetVersionRow | null;
  /** The version whose cases are returned (the requested one, or current). */
  selectedVersion: DatasetVersionRow | null;
  /** True when `selectedVersion` is the dataset's current version. */
  isCurrentVersion: boolean;
  testCases: TestCaseRow[];
  versions: DatasetVersionRow[];
}

export interface ScoreRow {
  id: string;
  scorerName: string;
  scorerVersion: string;
  numericValue: number | null;
  boolValue: boolean | null;
  stringValue: string | null;
  passed: boolean | null;
  explanation: string | null;
  error: string | null;
}

export interface ResultRow {
  id: string;
  runId: string;
  evaluationId: string;
  testCaseId: string;
  traceId: string | null;
  input: string;
  expectedOutput: string | null;
  candidateOutput: string | null;
  baselineOutput: string | null;
  status: EvalResultStatus;
  change: "improved" | "regressed" | "unchanged" | null;
  taskError: string | null;
  durationMs: number | null;
  cost: number | null;
  createTime: string;
  scores: ScoreRow[];
  /** Backend-derived candidate-vs-baseline comparison for this result. */
  comparison: ResultRowComparison | null;
}

export interface RunRow {
  id: string;
  evaluationId: string;
  datasetId: string;
  datasetVersionId: string;
  runNumber: number;
  candidateVersion: string;
  environment: string;
  status: EvalRunStatus;
  baselineRunId: string | null;
  caseCount: number;
  /**
   * Which slice of the pinned dataset version this run measured. Derived server-side
   * from the run's stored selection so every surface reads it identically; `unknown`
   * for a run that predates coverage or an SDK that does not report it, and never
   * silently promoted to `full`.
   */
  coverage: RunCoverage;
  scoredCount: number;
  taskErrorCount: number;
  scorerErrorCount: number;
  /**
   * Per-status result counts, derived from the stored result rows (not from the
   * SDK's counters).
   */
  erroredCount: number;
  notScoredCount: number;
  scorers: Array<{ name: string; version: string }> | null;
  /** Free-form user run metadata (arbitrary key/values); may be null. */
  metadata: Record<string, unknown> | null;
  startedAt: string;
  completedAt: string | null;
  evaluationName: string;
  datasetName: string | null;
  datasetVersionLabel: string;
  changeFromBaseline: number | null;
  errorCount: number;
  /** Derived (list route): regressed test-case count when trustworthy, else null. */
  regressedCaseCount?: number | null;
  /** Derived: whether the candidate-vs-baseline comparison is trustworthy. */
  baselineComparable?: boolean;
  /** Run wall-clock (completedAt − startedAt), null while running. */
  elapsedMs?: number | null;
  /** Derived (list route): total SDK-reported case cost; null when none reported. */
  cost?: number | null;
  /**
   * Derived (list and detail routes): mean cost and duration per case, each over the results that
   * reported that value; null when none did. Computed server-side so no client divides
   * by the declared `caseCount`, which is not the population the sums were taken over.
   */
  avgCost?: number | null;
  avgDurationMs?: number | null;
  /** How many results `avgCost` / `avgDurationMs` were each taken over. */
  costObservedCount?: number;
  durationObservedCount?: number;
}

export interface RunDetail extends RunRow {
  baselineComparable: boolean;
  elapsedMs: number | null;
  /** The backend-derived run-level comparison (single source of truth). */
  comparison: RunComparison;
  /**
   * How many result rows this run actually has. Distinct from `caseCount`, which is
   * what the run DECLARED; `resultsTruncated` is judged against this.
   */
  resultCount: number;
  /**
   * True when the API capped `results` — the run produced more rows than were
   * returned, so the table and the comparison derived from it are a partial view.
   * Strictly about the RESPONSE: a deliberately-subsetted run is complete and reports
   * false here; its slice is described by `coverage` instead.
   */
  resultsTruncated: boolean;
}

export interface RunDetailResponse {
  run: RunDetail;
  results: ResultRow[];
}

export interface EvaluationRow {
  id: string;
  name: string;
  datasetId: string;
  datasetName: string | null;
  runCount: number;
  latestRun: {
    id: string;
    runNumber: number;
    candidateVersion: string;
    status: EvalRunStatus;
    startedAt: string;
    datasetVersionId: string;
  } | null;
}
