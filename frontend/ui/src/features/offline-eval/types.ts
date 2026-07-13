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

/** How much the team trusts a test case. New cases start as needs_review. */
export type ReviewStatus = "needs_review" | "reviewed";

export const RESULT_STATUS_LABEL: Record<ResultStatus, string> = {
  passed: "Passed",
  failed: "Failed",
  needs_review: "Needs review",
};

export const REVIEW_STATUS_LABEL: Record<ReviewStatus, string> = {
  needs_review: "Needs review",
  reviewed: "Reviewed",
};

export const REVIEW_STATUS_HELP: Record<ReviewStatus, string> = {
  needs_review: "Nobody has checked this case or its expected output yet.",
  reviewed: "A person checked this case and trusts it to judge future runs.",
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

export type EvaluationStatus = "completed" | "running" | "failed";

export const EVALUATION_STATUS_LABEL: Record<EvaluationStatus, string> = {
  completed: "Completed",
  running: "Running",
  failed: "Failed",
};

export interface Evaluation {
  id: string;
  name: string;
  datasetId: string;
  datasetName: string;
  status: EvaluationStatus;
  mainScore: number | null;
  mainScoreName: string;
  /** Percentage-point change vs the baseline. Null when there is no baseline. */
  changeFromBaseline: number | null;
  baselineId: string | null;
  baselineName: string | null;
  regressionCount: number;
  ranAt: string;
  caseCount: number;
  scorerIds: string[];
  /** Everything technical, revealed only under a Details area. */
  details: {
    task: string;
    appVersion: string;
    model: string;
    trials: number;
    durationMs: number;
    cost: number;
  };
}

export type ResultChange = "improved" | "regressed" | "unchanged";

export interface EvaluationResult {
  caseId: string;
  input: string;
  expected: string | null;
  currentOutput: string;
  baselineOutput: string;
  score: number;
  baselineScore: number;
  status: ResultStatus;
  change: ResultChange;
  /** Short plain reason from the scorer. */
  explanation: string;
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
  /** Names of evaluations using this scorer. */
  usedByEvaluationNames: string[];
}
