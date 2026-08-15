/**
 * Client-side shapes for the server-backed evaluation feature. Timestamps arrive
 * as ISO strings over JSON, so these mirror the Prisma rows with string dates.
 */
import type { RunComparison, ResultComparison } from "@/lib/eval/comparison";

export type { RunComparison, ResultComparison } from "@/lib/eval/comparison";

/**
 * Typed execution provenance surfaced on a run — mirrors the SDK's
 * `RunProvenance` contract. Every field is optional/nullable; unknowns are null
 * and never inferred. Distinct from free-form `metadata`.
 */
export interface RunProvenance {
  git_repository: string | null;
  git_ref: string | null;
  git_commit: string | null;
  git_dirty: boolean | null;
  ci_provider: string | null;
  ci_build_id: string | null;
  sdk_language: string | null;
  sdk_version: string | null;
  declared_model: string | null;
  declared_prompt_version: string | null;
}

/** The per-result comparison block the run-detail route embeds on each result. */
export type ResultRowComparison = Pick<
  ResultComparison,
  | "caseChange"
  | "pairing"
  | "mainScore"
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
  /** Recorded production output — kept on the row until the dataset-detail rework
   *  that drops it (removed in the dataset-detail PR alongside the schema column). */
  recordedOutput: string | null;
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

export interface HumanScoreRow {
  id: string;
  /** Named review dimension (default "overall"); one canonical review per (result, dimension). */
  dimension: string;
  verdict: string;
  quality: number | null;
  comment: string | null;
  reviewer: string;
  /** Review lifecycle status (V1: "reviewed"). */
  status: string;
  createTime: string;
  updateTime: string;
}

/** Run-level human-review summary, derived read-only from reviews + automated status. */
export interface HumanReviewSummary {
  /** Dimensions with at least one review in the run — the active/configured set. */
  dimensions: string[];
  reviewedCount: number;
  pendingCount: number;
  passCount: number;
  failCount: number;
  /** Reviews whose human pass/fail verdict disagrees with the automated pass/fail. */
  disagreementCount: number;
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
  mainScore: number | null;
  change: "improved" | "regressed" | "unchanged" | null;
  taskError: string | null;
  durationMs: number | null;
  cost: number | null;
  createTime: string;
  scores: ScoreRow[];
  humanScores: HumanScoreRow[];
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
  mainScore: number | null;
  mainScoreName: string | null;
  caseCount: number;
  scoredCount: number;
  taskErrorCount: number;
  scorerErrorCount: number;
  /**
   * Per-status result counts, derived from the stored result rows (not from the
   * SDK's counters). Pass rate = passedCount / (passedCount + failedCount);
   * errored + not-scored are excluded from both sides. See
   * docs/offline-eval-run-pass-rate-design.md.
   */
  passedCount: number;
  failedCount: number;
  erroredCount: number;
  notScoredCount: number;
  scorers: Array<{ name: string; version: string }> | null;
  /** Typed execution provenance (git/CI/SDK identity, declared candidate model/prompt); null when the SDK reported none. */
  provenance: RunProvenance | null;
  /** Free-form user run metadata (arbitrary key/values); may be null. */
  metadata: Record<string, unknown> | null;
  startedAt: string;
  completedAt: string | null;
  evaluationName: string;
  datasetName: string | null;
  datasetVersionLabel: string;
  /** Dataset-version create time + number, for the UI's time-sortable snowflake id
   *  (list route only; optional so the run-detail/compare DTOs needn't supply them). */
  datasetVersionCreatedAt?: string;
  datasetVersionNumber?: number;
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
}

export interface RunDetail extends RunRow {
  baselineComparable: boolean;
  elapsedMs: number | null;
  /** The backend-derived run-level comparison (single source of truth). */
  comparison: RunComparison;
  /** Derived human-review summary; automated signals are never affected by it. */
  humanReview: HumanReviewSummary;
}

export interface RunDetailResponse {
  run: RunDetail;
  results: ResultRow[];
}

export interface EvaluationRow {
  id: string;
  name: string;
  datasetId: string;
  mainScoreName: string;
  datasetName: string | null;
  runCount: number;
  latestRun: {
    id: string;
    runNumber: number;
    candidateVersion: string;
    status: EvalRunStatus;
    mainScore: number | null;
    startedAt: string;
    datasetVersionId: string;
  } | null;
}
