/**
 * Client-side shapes for the server-backed evaluation feature. Timestamps arrive
 * as ISO strings over JSON, so these mirror the Prisma rows with string dates.
 */
import type { RunComparison, ResultComparison } from "@/lib/eval/comparison";

export type { RunComparison, ResultComparison, Classification } from "@/lib/eval/comparison";

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
>;

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
  scorers: Array<{ name: string; version: string }> | null;
  model: string | null;
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
