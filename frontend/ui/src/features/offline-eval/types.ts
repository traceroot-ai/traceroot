/**
 * Offline Evaluation — domain types (UI prototype).
 *
 * v1 loop: an existing trace → select a span → save it as a test case →
 * dataset → run an evaluation → compare → inspect the resulting trace → review.
 * Plus a small Scorers section.
 *
 * This version deliberately reuses the *real* trace types (`Span`,
 * `TraceDetail`) rather than a parallel shape, so the trace-inspection UI is the
 * genuine TraceRoot component fed with hardcoded data — not a lookalike.
 */

import type { Span, TraceDetail } from "@/types/api";
import type { SpanKind } from "@traceroot/core";

export type { Span, TraceDetail };
export type { SpanKind };

// ---------------------------------------------------------------------------
// Status vocabulary — plain, and no "Golden"
// ---------------------------------------------------------------------------

/** How a single result turned out. */
export type ResultStatus = "passed" | "failed" | "needs_review";

/**
 * How much the team trusts a test case. Advisory only — Ready never blocks a
 * case from evaluations here; it communicates trust. New cases start needs_review.
 */
export type ReviewStatus = "needs_review" | "ready";

/** Why a span was captured into a dataset — read-only context for the reviewer. */
export type CaptureReason = "manual" | "error" | "failed_tool" | "negative_feedback";

export const CAPTURE_REASON_LABEL: Record<CaptureReason, string> = {
  manual: "Captured manually",
  error: "Span ended with an error",
  failed_tool: "Failed tool call",
  negative_feedback: "Negative user feedback",
};

export const RESULT_STATUS_LABEL: Record<ResultStatus, string> = {
  passed: "Passed",
  failed: "Failed",
  needs_review: "Needs review",
};

export const REVIEW_STATUS_LABEL: Record<ReviewStatus, string> = {
  needs_review: "Needs review",
  ready: "Ready",
};

export const REVIEW_STATUS_HELP: Record<ReviewStatus, string> = {
  needs_review: "Nobody has verified this case is reusable yet.",
  ready: "A reviewer verified this case; later runs may optionally use Ready cases only.",
};

/**
 * Human-readable label for a span kind. The real kinds are LLM / AGENT / TOOL /
 * SPAN; "retrieval" and "root" are conveyed by the span's name, not a new kind.
 */
export const SPAN_KIND_LABEL: Record<SpanKind, string> = {
  LLM: "LLM call",
  AGENT: "Agent step",
  TOOL: "Tool call",
  SPAN: "Step",
  EVALUATION: "Evaluation",
  TASK: "Task",
  SCORER: "Scorer",
};

// ---------------------------------------------------------------------------
// Human review — the one thing people create in the UI
// ---------------------------------------------------------------------------

export type HumanVerdict = "pass" | "fail" | "unsure";

export const HUMAN_VERDICT_LABEL: Record<HumanVerdict, string> = {
  pass: "Pass",
  fail: "Fail",
  unsure: "Unsure",
};

/**
 * One person's judgment of one observed result.
 *
 * `correctedExpected` is kept separate from the verdict on purpose: judging what
 * happened once and changing what future runs are compared against are two
 * different decisions.
 */
export interface HumanReview {
  verdict: HumanVerdict;
  quality?: number;
  correctedExpected?: string;
  comment?: string;
  reviewer: string;
  at: string;
}

// ---------------------------------------------------------------------------
// Traces (real TraceDetail, plus the display fields a list needs)
// ---------------------------------------------------------------------------

/**
 * A trace in the prototype: the genuine `TraceDetail` (rendered by the real
 * SpanTreeView / SpanInfoPanel) plus the summary fields a list shows.
 */
export interface ProtoTrace {
  detail: TraceDetail;
  /** Short plain summary of the top-level input, for the list. */
  inputSummary: string;
  /** Short plain summary of the outcome, for the list. */
  resultSummary: string;
  status: ResultStatus;
  mainScore: number | null;
  mainScoreName: string;
  humanReview?: HumanReview;
}

export type TraceFilter = "all" | "passed" | "failed" | "needs_review" | "has_error";

export const TRACE_FILTERS: Array<{ id: TraceFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "passed", label: "Passed" },
  { id: "failed", label: "Failed" },
  { id: "needs_review", label: "Needs review" },
  { id: "has_error", label: "Has error" },
];

// ---------------------------------------------------------------------------
// Datasets & test cases
// ---------------------------------------------------------------------------

export interface Dataset {
  id: string;
  name: string;
  description: string;
  caseCount: number;
  reviewedCount: number;
  /** Names of evaluations that have run against this dataset. */
  evaluationNames: string[];
  updatedAt: string;
  /** Optional free-form tags, shown only in a collapsed section. */
  tags: string[];
}

/**
 * Where a test case came from. Always a span inside a parent trace — the whole
 * trace is retained as context, but the case *is* the selected span.
 */
export interface CaseSource {
  traceId: string;
  spanId: string;
  spanName: string;
  spanKind: SpanKind;
}

export interface TestCase {
  id: string;
  /** The selected span's input becomes the proposed test input. */
  input: string;
  /**
   * Optional. Null means a scorer judges the produced output directly rather
   * than comparing it to one exact answer.
   */
  expected: string | null;
  /** What the span actually produced in production. Read-only, never = expected. */
  recordedOutput: string | null;
  /** Why this span was captured — read-only context for the reviewer. */
  captureReason: CaptureReason;
  source: CaseSource;
  review: ReviewStatus;
  latestScore: number | null;
  latestStatus: ResultStatus | null;
  metadata: Record<string, string>;
  addedAt: string;
  addedBy: string;
  humanReview?: HumanReview;
}

export interface DatasetVersion {
  version: string;
  createdAt: string;
  author: string;
  note: string;
  caseCount: number;
}

export interface DatasetActivity {
  at: string;
  actor: string;
  message: string;
}

// ---------------------------------------------------------------------------
// Evaluations (the run — the term chosen for this product)
// ---------------------------------------------------------------------------

export type EvaluationStatus =
  | "running"
  | "completed"
  | "completed_with_errors"
  | "failed"
  | "incomplete";

export const EVALUATION_STATUS_LABEL: Record<EvaluationStatus, string> = {
  running: "Running",
  completed: "Completed",
  completed_with_errors: "Completed with errors",
  failed: "Failed",
  incomplete: "Incomplete",
};

/**
 * How one result turned out. Distinct from a dataset case's status: "Not scored"
 * is not a zero, and "Errored" says the run broke rather than judged badly.
 */
export type EvalResultStatus = "passed" | "failed" | "errored" | "not_scored";

export const EVAL_RESULT_STATUS_LABEL: Record<EvalResultStatus, string> = {
  passed: "Passed",
  // "Did not pass" (scored below the scorer's bar), not "Failed" — a low score
  // reads as a broken run otherwise. A crash is "Errored", kept distinct.
  failed: "Did not pass",
  errored: "Errored",
  not_scored: "Not scored",
};

/** Per-run totals reported by the SDK, shown low on the run detail page. */
export interface EvaluationMetrics {
  /** Wall-clock duration of the run. */
  durationMs: number;
  /** Summed duration of every span in the run. */
  totalDurationMs: number;
  /** Summed duration of the LLM spans only. */
  llmDurationMs: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  spanErrors: number;
  /** Estimated dollar cost of the run. */
  cost: number;
}

/**
 * One evaluation run: a candidate version measured against a dataset snapshot.
 *
 * `name` is the stable purpose ("Billing routing") and stays constant across
 * runs; `candidateVersion` is what changed ("prompt-v19", a git sha). They are
 * deliberately separate — the name is how runs are matched to a baseline.
 */
export interface Evaluation {
  /**
   * Immutable identity of ONE execution. This is what a run URL points at; a run
   * is never edited, so there is no evaluation-version field.
   */
  runId: string;
  /** Stable identity of the evaluation purpose, constant across its runs. */
  evaluationId: string;
  /** Monotonic run counter within one evaluation, for display as "Run #27". */
  runNumber: number;
  /** Stable suite name. Never the candidate version. */
  name: string;
  /** What was being tested this time: "prompt-v19" or a commit. */
  candidateVersion: string;
  /** Stable dataset identity. */
  datasetId: string;
  datasetName: string;
  /** Immutable dataset snapshot this run measured against. */
  datasetVersionId: string;
  /** Human-readable label for that snapshot, e.g. "v12". */
  datasetVersion: string;
  /** Where the run executed — the SDK reports this. */
  environment: string;
  status: EvaluationStatus;
  mainScore: number | null;
  mainScoreName: string;
  /** Percentage-point change vs the baseline. Null when there is no baseline. */
  changeFromBaseline: number | null;
  baselineId: string | null;
  baselineName: string | null;
  regressionCount: number;
  ranAt: string;
  /** Test cases in the dataset snapshot — the denominator. */
  caseCount: number;
  /** How many of them actually produced a score. Never silently equals caseCount. */
  scoredCount: number;
  /** The candidate application failed for this many cases. */
  taskErrorCount: number;
  /** The candidate produced output, but a scorer failed to judge it. */
  scorerErrorCount: number;
  scorerIds: string[];
  /** Per-run totals (duration, tokens, cost) — shown low on the detail page. */
  metrics: EvaluationMetrics;
  details: {
    task: string;
    model: string;
    trials: number;
  };
}

export type ResultChange = "improved" | "regressed" | "unchanged";

/** One scorer's verdict on one result. `score` is null when the scorer failed. */
export interface ScorerOutcome {
  scorerId: string;
  score: number | null;
  /** Short plain reason from the scorer. */
  explanation?: string;
  /** Set when this scorer failed to judge an output the candidate did produce. */
  error?: string;
}

export interface EvaluationResult {
  /** Identity of this one test-case result within this one run. */
  resultId: string;
  /** Stable identity of the source dataset test case. Baselines match on this. */
  datasetItemId: string;
  input: string;
  expected: string | null;
  /** Null when the candidate application errored before producing anything. */
  currentOutput: string | null;
  /** Null when this run has no baseline. */
  baselineOutput: string | null;
  /** Main score. Null when not scored (errored, or no scorer produced a value). */
  score: number | null;
  baselineScore: number | null;
  status: EvalResultStatus;
  /** Null when there is no baseline to compare against. */
  change: ResultChange | null;
  /** Every scorer that ran, including the ones that failed. */
  scores: ScorerOutcome[];
  /** Set when the candidate application itself failed for this case. */
  taskError?: string;
  durationMs: number;
  cost: number;
  /** The trace this result produced — opens the real trace detail. */
  traceId: string;
  humanReview?: HumanReview;
}

export type ResultFilter = "all" | "regressions" | "failed" | "needs_review";

export const RESULT_FILTERS: Array<{ id: ResultFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "regressions", label: "Regressions" },
  { id: "failed", label: "Failed" },
  { id: "needs_review", label: "Needs review" },
];

// ---------------------------------------------------------------------------
// Scorers
// ---------------------------------------------------------------------------

/** Friendly types. */
export type ScorerType = "rule" | "ai_judge" | "human_review";

export const SCORER_TYPE_LABEL: Record<ScorerType, string> = {
  rule: "Rule / code",
  ai_judge: "LLM judge",
  human_review: "Human review",
};

export const SCORER_TYPE_HELP: Record<ScorerType, string> = {
  rule: "Plain code. Same input, same answer, every time.",
  ai_judge: "A model reads the output and grades it against a rubric.",
  human_review: "A person decides. Used when nothing automatic is good enough.",
};

export interface Scorer {
  id: string;
  name: string;
  /** One plain sentence: what it measures. */
  measures: string;
  type: ScorerType;
  /** e.g. "Pass / fail", "0–1", "1–5". */
  scoreFormat: string;
  /** How the number should be read. */
  interpretation: string;
  version: string;
  higherIsBetter: boolean;
  /** What the scorer judges: the whole run's output, or one span. */
  scope: "Evaluation item" | "Span";
  /** Share of results where this scorer failed to produce a score, 0–1. */
  errorRate: number;
  /** Names of evaluations using this scorer. */
  usedByEvaluationNames: string[];
}
