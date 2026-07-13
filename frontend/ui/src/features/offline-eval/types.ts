/**
 * Offline Evaluation — domain types (UI prototype).
 *
 * v1 scope is deliberately small: Traces → Datasets → Experiments, plus Scorers
 * and human review. There are no detectors, cohorts, CI gates, or session-level
 * evaluation here.
 *
 * Vocabulary rule: the four object names (Trace, Dataset, Experiment, Scorer)
 * stay, because they are what the SDK calls things. Everything else reads in
 * plain language — "test case", "reference answer", "quality check", "review".
 */

// ---------------------------------------------------------------------------
// Scope — what a test case actually runs
// ---------------------------------------------------------------------------

/**
 * `whole_workflow` is the normal case. The rest isolate one operation and are
 * only reachable by picking a specific step inside a trace.
 */
export type Scope =
  | "whole_workflow"
  | "llm_response"
  | "retrieval_step"
  | "routing_decision"
  | "tool_selection"
  | "tool_arguments"
  | "tool_execution"
  | "application_function";

export interface ScopeMeta {
  id: Scope;
  label: string;
  /** One plain sentence describing what rerunning this scope does. */
  description: string;
  /** Maps onto the span palette already used by features/traces. */
  spanKind: "trace" | "llm" | "tool" | "span";
}

export const SCOPES: ScopeMeta[] = [
  {
    id: "whole_workflow",
    label: "Whole workflow",
    description: "Runs the whole thing again, start to finish, from this input.",
    spanKind: "trace",
  },
  {
    id: "llm_response",
    label: "LLM response",
    description: "Runs just this model call and judges what it wrote.",
    spanKind: "llm",
  },
  {
    id: "retrieval_step",
    label: "Retrieval step",
    description: "Runs just the search and judges the documents it found.",
    spanKind: "span",
  },
  {
    id: "routing_decision",
    label: "Routing decision",
    description: "Runs just the routing choice and judges where it sent the request.",
    spanKind: "span",
  },
  {
    id: "tool_selection",
    label: "Tool selection",
    description: "Judges which tool was picked, ignoring the arguments.",
    spanKind: "tool",
  },
  {
    id: "tool_arguments",
    label: "Tool arguments",
    description: "Judges the values passed to a tool that was already picked.",
    spanKind: "tool",
  },
  {
    id: "tool_execution",
    label: "Tool execution",
    description: "Runs the tool itself and judges what it returned.",
    spanKind: "tool",
  },
  {
    id: "application_function",
    label: "Application function",
    description: "Runs one function in your code and judges its output.",
    spanKind: "span",
  },
];

export function scopeMeta(id: Scope): ScopeMeta {
  const found = SCOPES.find((item) => item.id === id);
  if (!found) throw new Error(`Unknown scope: ${id}`);
  return found;
}

// ---------------------------------------------------------------------------
// Status vocabulary — exactly four labels, used everywhere
// ---------------------------------------------------------------------------

/** How a single result turned out. */
export type ResultStatus = "passed" | "failed" | "needs_review";

/** How much the team trusts a test case. New cases start at `needs_review`. */
export type ReviewStatus = "needs_review" | "golden";

export const RESULT_STATUS_LABEL: Record<ResultStatus, string> = {
  passed: "Passed",
  failed: "Failed",
  needs_review: "Needs review",
};

export const REVIEW_STATUS_LABEL: Record<ReviewStatus, string> = {
  needs_review: "Needs review",
  golden: "Golden",
};

/** Plain sentence for each review status, shown instead of jargon tooltips. */
export const REVIEW_STATUS_HELP: Record<ReviewStatus, string> = {
  needs_review: "Nobody has confirmed this case or its reference answer yet.",
  golden: "Someone checked this case and trusts it to judge future runs.",
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
 * `correctedReference` is deliberately separate from the verdict: judging what
 * happened once and changing what future runs are compared against are two
 * different decisions, and conflating them is how a dataset quietly rots.
 */
export interface HumanReview {
  verdict: HumanVerdict;
  /** Optional 1–5 quality score. */
  quality?: number;
  correctedReference?: string;
  comment?: string;
  markGolden?: boolean;
  reviewer: string;
  at: string;
}

/** What the review panel is judging — the same panel serves all three. */
export type ReviewSubject =
  | { kind: "trace"; traceId: string }
  | { kind: "case"; datasetId: string; caseId: string }
  | { kind: "result"; experimentId: string; caseId: string };

// ---------------------------------------------------------------------------
// Traces
// ---------------------------------------------------------------------------

export interface TraceRow {
  traceId: string;
  /** Plain summary of what the user asked for — the "Input" column. */
  input: string;
  /** Plain summary of what the app did — the "Result" column. */
  result: string;
  /** The one score shown by default. Null when nothing scored this trace. */
  mainScore: number | null;
  mainScoreName: string;
  status: ResultStatus;
  hasError: boolean;
  errorMessage?: string;
  durationMs: number;
  at: string;
  /** Revealed only after the trace is opened. */
  details: {
    model: string;
    cost: number;
    inputTokens: number;
    outputTokens: number;
    userId: string;
    sessionId: string;
  };
  humanReview?: HumanReview;
}

/**
 * A step inside a trace.
 *
 * `name` is the human-readable label shown by default ("Generate response");
 * `technicalName` is the real span name, shown as a quiet secondary label so
 * the tree stays learnable without hiding what actually ran.
 */
export interface Step {
  stepId: string;
  name: string;
  technicalName: string;
  kind: "trace" | "llm" | "tool" | "span";
  scope: Scope;
  durationMs: number;
  status: "ok" | "error";
  input: string;
  output: string;
  /** Shown only under Details. */
  details: Record<string, string>;
  children: Step[];
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
// Datasets
// ---------------------------------------------------------------------------

export interface Dataset {
  id: string;
  name: string;
  /** One plain sentence: what this collection is for. */
  purpose: string;
  caseCount: number;
  goldenCount: number;
  /** Name of the most recent experiment run against it, if any. */
  lastExperiment: string | null;
  lastExperimentId: string | null;
  updatedAt: string;
  version: string;
}

export type CaseSource =
  | { kind: "trace"; traceId: string }
  | { kind: "sdk" }
  | { kind: "variation"; ofCaseId: string };

export interface TestCase {
  id: string;
  input: string;
  /**
   * Optional. Null means no single right answer exists and a quality check
   * judges the output directly — not that the field is missing.
   */
  reference: string | null;
  scope: Scope;
  review: ReviewStatus;
  latestScore: number | null;
  latestStatus: ResultStatus | null;
  source: CaseSource;
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
// Experiments
// ---------------------------------------------------------------------------

export type ExperimentStatus = "completed" | "running" | "failed";

export const EXPERIMENT_STATUS_LABEL: Record<ExperimentStatus, string> = {
  completed: "Completed",
  running: "Running",
  failed: "Failed",
};

export interface Experiment {
  id: string;
  name: string;
  datasetId: string;
  datasetName: string;
  datasetVersion: string;
  status: ExperimentStatus;
  /** The single headline number. */
  mainScore: number | null;
  mainScoreName: string;
  /** Percentage-point change vs the baseline run. Null when nothing to compare. */
  changeFromBaseline: number | null;
  /** The run this one is compared against. */
  baselineId: string | null;
  baselineName: string | null;
  ranAt: string;
  caseCount: number;
  /** Everything technical, revealed only under the Details tab. */
  details: {
    model: string;
    trials: number;
    durationMs: number;
    cost: number;
    gitBranch: string;
    gitCommit: string;
    scorerIds: string[];
  };
}

export type ResultChange = "improved" | "regressed" | "unchanged";

export interface ExperimentResult {
  caseId: string;
  input: string;
  reference: string | null;
  candidateOutput: string;
  baselineOutput: string;
  score: number;
  baselineScore: number;
  status: ResultStatus;
  change: ResultChange;
  /** Short plain-language reason from the quality check. */
  explanation: string;
  humanReview?: HumanReview;
}

export type ResultFilter = "all" | "improved" | "regressed" | "passed" | "failed" | "needs_review";

export const RESULT_FILTERS: Array<{ id: ResultFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "improved", label: "Improved" },
  { id: "regressed", label: "Regressed" },
  { id: "passed", label: "Passed" },
  { id: "failed", label: "Failed" },
  { id: "needs_review", label: "Needs review" },
];

// ---------------------------------------------------------------------------
// Scorers
// ---------------------------------------------------------------------------

/** Friendly types. "Rule" beats "heuristic/code" for someone reading this cold. */
export type ScorerType = "rule" | "ai_judge" | "human_review";

export const SCORER_TYPE_LABEL: Record<ScorerType, string> = {
  rule: "Rule",
  ai_judge: "AI judge",
  human_review: "Human review",
};

export const SCORER_TYPE_HELP: Record<ScorerType, string> = {
  rule: "Plain code. Same input, same answer, every time.",
  ai_judge: "A model reads the output and grades it against a rubric.",
  human_review: "A person decides. Used when nothing automatic is good enough.",
};

export interface ScorerVersion {
  version: string;
  createdAt: string;
  note: string;
}

export interface Scorer {
  id: string;
  name: string;
  /** One plain sentence: what it measures. */
  measures: string;
  type: ScorerType;
  scopes: Scope[];
  version: string;
  higherIsBetter: boolean;
  /** What the scorer reads. */
  inputs: string[];
  versions: ScorerVersion[];
  usedByDatasetIds: string[];
  usedByExperimentIds: string[];
  /** Minimal SDK definition, shown behind "View SDK definition". */
  sdkExample: string;
}
