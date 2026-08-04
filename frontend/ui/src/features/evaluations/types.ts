/**
 * Client-side shapes for the server-backed evaluation feature. Timestamps arrive
 * as ISO strings over JSON, so these mirror the Prisma rows with string dates.
 */
import type { RunComparison, ResultComparison } from "@/lib/eval/comparison";

export type { RunComparison, ResultComparison, Classification } from "@/lib/eval/comparison";

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
  | "incomplete";

export const EVAL_RUN_STATUS_LABEL: Record<EvalRunStatus, string> = {
  running: "Running",
  completed: "Completed",
  completed_with_errors: "Completed with errors",
  failed: "Failed",
  incomplete: "Incomplete",
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
  verdict: string;
  quality: number | null;
  comment: string | null;
  reviewer: string;
  createTime: string;
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
  changeFromBaseline: number | null;
  errorCount: number;
  /** Derived (list route): regressed test-case count when trustworthy, else null. */
  regressedCaseCount?: number | null;
  /** Derived: whether the candidate-vs-baseline comparison is trustworthy. */
  baselineComparable?: boolean;
  /** Run wall-clock (completedAt − startedAt), null while running. */
  elapsedMs?: number | null;
}

export interface RunDetail extends RunRow {
  baselineComparable: boolean;
  elapsedMs: number | null;
  /** The backend-derived run-level comparison (single source of truth). */
  comparison: RunComparison;
}

export interface RunDetailResponse {
  run: RunDetail;
  results: ResultRow[];
}

/** One run's summary in the compare view (both sides of the A-vs-B comparison). */
export interface CompareRunSummary {
  id: string;
  runNumber: number;
  evaluationId: string;
  evaluationName: string;
  candidateVersion: string;
  datasetVersionId: string;
  datasetVersionLabel: string;
  status: EvalRunStatus;
  mainScore: number | null;
  mainScoreName: string | null;
  caseCount: number;
  scoredCount: number;
  taskErrorCount: number;
  scorerErrorCount: number;
  startedAt: string;
  completedAt: string | null;
  elapsedMs: number | null;
}

/** Raw per-scorer value on one side of a compared case (for the drawer's breakdown). */
export interface CompareRawScore {
  scorerName: string;
  scorerVersion: string;
  numericValue: number | null;
  boolValue: boolean | null;
  stringValue: string | null;
  passed: boolean | null;
  explanation: string | null;
  error: string | null;
}

/** One case row in the compare view — the read contract the redesigned page consumes. */
export interface CompareResultRow {
  testCaseId: string;
  /** Canonical (pinned dataset-version) content — what the engineer authored. */
  input: string;
  expectedOutput: string | null;
  metadata: unknown;
  provenance: {
    sourceTraceId: string | null;
    sourceSpanName: string | null;
    sourceSpanKind: string | null;
    captureReason: string;
  } | null;
  /** False when a run recorded an input different from the pinned dataset case. */
  inputMatchesDataset: boolean;
  candidateStatus: EvalResultStatus | null;
  baselineStatus: EvalResultStatus | null;
  candidateOutput: string | null;
  baselineOutput: string | null;
  candidateTraceId: string | null;
  baselineTraceId: string | null;
  candidateCost: number | null;
  baselineCost: number | null;
  candidateTaskError: string | null;
  baselineTaskError: string | null;
  candidateScores: CompareRawScore[];
  baselineScores: CompareRawScore[];
  /** Whether the candidate output differs from the baseline output; null if neither exists. */
  outputChanged: boolean | null;
  change: "improved" | "regressed" | "unchanged" | null;
  comparison:
    | (ResultRowComparison & {
        baselineOutput: string | null;
        /** Candidate case duration (task + scorers); null → Unknown, never 0. */
        durationMs: number | null;
      })
    | null;
}

export interface CompareRunsResponse {
  candidate: CompareRunSummary;
  baseline: CompareRunSummary;
  comparison: RunComparison;
  results: CompareResultRow[];
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
