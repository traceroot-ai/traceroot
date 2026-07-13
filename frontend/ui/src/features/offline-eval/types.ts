/**
 * Offline Evaluation — domain types (UI prototype).
 *
 * These describe the *vocabulary* the prototype is testing, not a backend
 * contract. Nothing here is persisted; see ./data for the fixtures.
 *
 * The central modelling claim being tested: "scope" is not one field. A case
 * has four independent scopes that teams routinely conflate —
 * see SCOPE_FACETS below.
 */

// ---------------------------------------------------------------------------
// Granularity
// ---------------------------------------------------------------------------

/**
 * What a case can execute or be judged against.
 * `whole_trace` is the recommended default; the rest are component-level.
 */
export type Granularity =
  | "whole_trace"
  | "llm_response"
  | "retrieval"
  | "router_decision"
  | "tool_selection"
  | "tool_arguments"
  | "tool_execution"
  | "function_transform"
  | "guardrail";

export interface GranularityMeta {
  id: Granularity;
  label: string;
  /** One-line description of what re-running this granularity actually does. */
  description: string;
  /** Component-level granularities isolate a single span. */
  isComponent: boolean;
  /** Maps onto the existing span_kind palette in features/traces. */
  spanKind: "trace" | "llm" | "tool" | "agent" | "span";
}

export const GRANULARITIES: GranularityMeta[] = [
  {
    id: "whole_trace",
    label: "Whole trace",
    description: "Reruns the end-to-end workflow from the original input.",
    isComponent: false,
    spanKind: "trace",
  },
  {
    id: "llm_response",
    label: "LLM response",
    description: "Isolates a single model call and judges its output.",
    isComponent: true,
    spanKind: "llm",
  },
  {
    id: "retrieval",
    label: "Retrieval step",
    description: "Isolates the retrieval query and judges the documents returned.",
    isComponent: true,
    spanKind: "span",
  },
  {
    id: "router_decision",
    label: "Router decision",
    description: "Isolates the routing choice and judges the branch selected.",
    isComponent: true,
    spanKind: "span",
  },
  {
    id: "tool_selection",
    label: "Tool selection",
    description: "Judges which tool the model chose, ignoring the arguments.",
    isComponent: true,
    spanKind: "tool",
  },
  {
    id: "tool_arguments",
    label: "Tool arguments",
    description: "Judges the argument payload for an already-chosen tool.",
    isComponent: true,
    spanKind: "tool",
  },
  {
    id: "tool_execution",
    label: "Tool execution",
    description: "Runs the tool itself and judges its return value.",
    isComponent: true,
    spanKind: "tool",
  },
  {
    id: "function_transform",
    label: "Function / transform",
    description: "Isolates a deterministic function and judges its output.",
    isComponent: true,
    spanKind: "span",
  },
  {
    id: "guardrail",
    label: "Guardrail",
    description: "Judges whether a guardrail fired correctly on the input.",
    isComponent: true,
    spanKind: "span",
  },
];

export function granularity(id: Granularity): GranularityMeta {
  const found = GRANULARITIES.find((item) => item.id === id);
  if (!found) throw new Error(`Unknown granularity: ${id}`);
  return found;
}

// ---------------------------------------------------------------------------
// Aggregation contexts (higher-level than a single case)
// ---------------------------------------------------------------------------

export type AggregationLevel = "case" | "session" | "user" | "cohort";

export interface AggregationMeta {
  id: AggregationLevel;
  label: string;
  description: string;
  /**
   * False where we do NOT yet claim automatic evaluation. Session-level
   * evaluation needs an explicit session boundary and an aggregation policy;
   * the UI must not imply this is solved.
   */
  supported: boolean;
  caveat?: string;
}

export const AGGREGATION_LEVELS: AggregationMeta[] = [
  {
    id: "case",
    label: "Case",
    description: "One dataset row. The unit that is executed and scored.",
    supported: true,
  },
  {
    id: "session",
    label: "Session",
    description: "Multiple traces belonging to one conversation.",
    supported: false,
    caveat:
      "Requires an explicit session boundary and an aggregation policy (last turn? worst turn? mean?). Grouping works today; automatic session-level scoring does not.",
  },
  {
    id: "user",
    label: "User",
    description: "All traces attributed to one end user.",
    supported: false,
    caveat: "Available as a grouping for results. There is no user-level scorer.",
  },
  {
    id: "cohort",
    label: "Cohort",
    description: "Traces matching a metadata filter, e.g. intent=billing.",
    supported: true,
  },
];

// ---------------------------------------------------------------------------
// The four scope facets — the distinction this prototype exists to test
// ---------------------------------------------------------------------------

export type ScopeFacetId = "execution" | "evidence" | "scoring" | "aggregation";

export interface ScopeFacetMeta {
  id: ScopeFacetId;
  label: string;
  question: string;
  description: string;
}

export const SCOPE_FACETS: ScopeFacetMeta[] = [
  {
    id: "execution",
    label: "Execution scope",
    question: "What is rerun?",
    description: "The unit the candidate fix actually re-executes.",
  },
  {
    id: "evidence",
    label: "Evidence scope",
    question: "Where did this come from?",
    description: "The production trace or span the case was captured from.",
  },
  {
    id: "scoring",
    label: "Scoring scope",
    question: "What is judged?",
    description: "The part of the result a scorer reads. Need not equal what was rerun.",
  },
  {
    id: "aggregation",
    label: "Aggregation scope",
    question: "How are results grouped?",
    description: "How individual case scores roll up into a reported number.",
  },
];

/** The concrete four-scope assignment carried by a dataset case. */
export interface CaseScope {
  execution: Granularity;
  evidence: { traceId: string; spanId?: string; spanName?: string };
  scoring: Granularity;
  aggregation: AggregationLevel;
}

// ---------------------------------------------------------------------------
// Golden status
// ---------------------------------------------------------------------------

/**
 * Golden means a human (or trusted process) validated the case AND its success
 * criteria. Copying a production trace does not make a case golden — new cases
 * land in `needs_review`.
 */
export type GoldenStatus = "draft" | "needs_review" | "golden";

export interface GoldenStatusMeta {
  id: GoldenStatus;
  label: string;
  description: string;
  variant: "default" | "warning" | "success";
}

export const GOLDEN_STATUSES: GoldenStatusMeta[] = [
  {
    id: "draft",
    label: "Draft",
    description: "Being edited. Not yet proposed as a test case.",
    variant: "default",
  },
  {
    id: "needs_review",
    label: "Needs review",
    description: "Captured but not yet validated by a human. The default for imported traces.",
    variant: "warning",
  },
  {
    id: "golden",
    label: "Golden",
    description: "A human validated both the case and its success criteria.",
    variant: "success",
  },
];

export function goldenStatus(id: GoldenStatus): GoldenStatusMeta {
  const found = GOLDEN_STATUSES.find((item) => item.id === id);
  if (!found) throw new Error(`Unknown golden status: ${id}`);
  return found;
}

// ---------------------------------------------------------------------------
// Dataset
// ---------------------------------------------------------------------------

export type CaseOrigin =
  | { kind: "production_trace"; traceId: string; detectorIssueId?: string }
  | { kind: "manual" }
  | { kind: "duplicated"; fromCaseId: string }
  | { kind: "regression"; experimentId: string };

export interface DatasetCase {
  id: string;
  /** The stimulus fed to the system under test. */
  input: string;
  /**
   * Optional: some scorers judge the output directly (e.g. a rubric judge)
   * and need no single reference answer.
   */
  expected: string | null;
  /** Why `expected` is absent, shown in place of an empty cell. */
  expectedAbsentReason?: string;
  metadata: Record<string, string>;
  origin: CaseOrigin;
  scope: CaseScope;
  golden: GoldenStatus;
  lastScore: number | null;
  addedAt: string;
  addedBy: string;
  activity: ActivityEntry[];
}

export interface ActivityEntry {
  at: string;
  actor: string;
  message: string;
}

export interface DatasetSummary {
  id: string;
  name: string;
  description: string;
  /** Display label for the dataset's dominant scope, e.g. "Whole trace", "Mixed trace/LLM". */
  scopeLabel: string;
  /** Present when the dataset is single-scope; absent for mixed datasets. */
  scope: Granularity | null;
  caseCount: number;
  version: string;
  owner: string;
  counts: Record<GoldenStatus, number>;
  originSummary: string;
  updatedAt: string;
  /** Detector issue this dataset traces back to, when it was scoped from one. */
  sourceDetectorIssueId?: string;
}

export interface DatasetVersion {
  version: string;
  createdAt: string;
  author: string;
  note: string;
  caseCount: number;
}

export interface DatasetRunRef {
  experimentId: string;
  experimentName: string;
  datasetVersion: string;
  ranAt: string;
  caseCount: number;
  primaryMetric: string;
  primaryValue: number;
}

// ---------------------------------------------------------------------------
// Candidate fix
// ---------------------------------------------------------------------------

/** The changed system configuration under test, before acceptance. */
export type CandidateFixKind =
  | "prompt"
  | "model"
  | "retrieval"
  | "tool_schema"
  | "routing"
  | "guardrail"
  | "app_code";

export interface CandidateFixKindMeta {
  id: CandidateFixKind;
  label: string;
  example: string;
}

export const CANDIDATE_FIX_KINDS: CandidateFixKindMeta[] = [
  { id: "prompt", label: "Revised prompt", example: "Prompt v19 candidate" },
  { id: "model", label: "Different model", example: "claude-opus-4-8" },
  { id: "retrieval", label: "Retrieval change", example: "top_k 4 → 8, rerank on" },
  { id: "tool_schema", label: "Tool-schema change", example: "lookup_invoice: add account_id" },
  { id: "routing", label: "Routing change", example: "intent threshold 0.6 → 0.75" },
  { id: "guardrail", label: "Guardrail change", example: "PII filter on tool args" },
  { id: "app_code", label: "Application-code fix", example: "fix/billing-routing" },
];

export interface CandidateFix {
  id: string;
  name: string;
  kind: CandidateFixKind;
  summary: string;
  branch?: string;
}

// ---------------------------------------------------------------------------
// Detector issue / RCA
// ---------------------------------------------------------------------------

export type Severity = "high" | "medium" | "low";

export interface MetricMovement {
  metric: string;
  baselineValue: number;
  currentValue: number;
  unit: "percent" | "ms" | "usd";
  /** Higher-is-better vs lower-is-better changes how a delta is read. */
  direction: "higher_is_better" | "lower_is_better";
  recoveryTarget: number;
}

export interface CohortFilter {
  key: string;
  value: string;
}

export interface RepresentativeTrace {
  traceId: string;
  summary: string;
  failedAs: string;
  durationMs: number;
  cost: number;
  timestamp: string;
}

export interface FailingCluster {
  label: string;
  share: number;
  exampleInput: string;
  note: string;
}

export interface RelatedSpan {
  spanId: string;
  name: string;
  kind: "llm" | "tool" | "span" | "agent";
  role: string;
  /** True for the span RCA points at as the probable locus. */
  isPrimary: boolean;
}

export interface DetectorIssue {
  id: string;
  title: string;
  severity: Severity;
  detectorName: string;
  detectedAt: string;
  affectedTraceCount: number;
  metric: MetricMovement;
  cohort: CohortFilter[];
  representativeTraces: RepresentativeTrace[];
  topCluster: FailingCluster;
  sourceEvidence: string;
  /** What RCA suggests rerunning. */
  recommendedGranularity: Granularity;
  /**
   * What RCA suggests judging. Separate from `recommendedGranularity` because
   * the two genuinely differ: DET-2841 reruns the whole trace but scores only
   * the routing decision.
   */
  recommendedScoringGranularity: Granularity;
  recommendedRationale: string;
  /**
   * Affected traces that survive dedupe into distinct cases. Smaller than
   * `affectedTraceCount` — 214 traces collapse to 24 failing shapes.
   */
  proposedCaseCount: number;
  relatedSpans: RelatedSpan[];
  baseline: CandidateFix;
  guardrailNote: string;
  /** Set once a verification dataset has been scoped from this issue. */
  verificationDatasetId?: string;
  stage: ContinuityStage;
}

// ---------------------------------------------------------------------------
// Continuity stages — the spine of the product story
// ---------------------------------------------------------------------------

export type ContinuityStage =
  | "detected"
  | "scoped"
  | "dataset"
  | "experiment"
  | "compared"
  | "gated";

export interface ContinuityStageMeta {
  id: ContinuityStage;
  label: string;
  description: string;
}

export const CONTINUITY_STAGES: ContinuityStageMeta[] = [
  { id: "detected", label: "Detected", description: "A detector flagged a metric movement." },
  { id: "scoped", label: "Scoped", description: "The affected cohort and metric are pinned." },
  { id: "dataset", label: "Dataset", description: "Failing traces became reusable test cases." },
  { id: "experiment", label: "Experiment", description: "A candidate fix ran against the cases." },
  { id: "compared", label: "Compared", description: "Candidate measured against the baseline." },
  { id: "gated", label: "Gated", description: "The bar is enforced on every future change." },
];

export function stageIndex(stage: ContinuityStage): number {
  return CONTINUITY_STAGES.findIndex((item) => item.id === stage);
}

// ---------------------------------------------------------------------------
// Scorers
// ---------------------------------------------------------------------------

export type ScorerType = "llm_judge" | "heuristic" | "code";

export interface ScorerVersion {
  version: string;
  createdAt: string;
  note: string;
}

export interface Scorer {
  id: string;
  name: string;
  version: string;
  type: ScorerType;
  purpose: string;
  acceptedInputs: string[];
  scopes: Granularity[];
  aggregation: AggregationLevel;
  direction: "higher_is_better" | "lower_is_better";
  threshold: number | null;
  unit: "percent" | "score";
  versions: ScorerVersion[];
  linkedDetectorIssueIds: string[];
  usedByExperimentIds: string[];
  /** Draft scorers are explicitly not ready; the UI must show why. */
  isDraft: boolean;
  experimentalNote?: string;
}

// ---------------------------------------------------------------------------
// Experiments
// ---------------------------------------------------------------------------

export type ExperimentStatus = "completed" | "running" | "draft" | "failed";

export interface ExperimentScores {
  routingAccuracy: number | null;
  helpfulness: number | null;
}

export interface Experiment {
  id: string;
  name: string;
  status: ExperimentStatus;
  /** True for the run currently accepted as the comparison baseline. */
  isBaseline: boolean;
  candidate: CandidateFix;
  datasetId: string;
  datasetName: string;
  datasetVersion: string;
  caseCount: number;
  scores: ExperimentScores;
  durationMs: number;
  cost: number;
  trials: number;
  ranAt: string;
  sourceDetectorIssueId?: string;
  metadata: Record<string, string>;
  scorerIds: string[];
}

/** How the experiments list and comparison results can be grouped. */
export type GroupingKey = "overall" | "intent" | "scope" | "source_detector";

export interface GroupingMeta {
  id: GroupingKey;
  label: string;
}

export const GROUPINGS: GroupingMeta[] = [
  { id: "overall", label: "Overall" },
  { id: "intent", label: "Intent" },
  { id: "scope", label: "Scope" },
  { id: "source_detector", label: "Source detector" },
];

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

export type RowOutcome = "improved" | "regressed" | "unchanged" | "needs_review";

export interface ComparisonRow {
  caseId: string;
  input: string;
  expected: string | null;
  intent: string;
  scope: Granularity;
  baselineOutput: string;
  candidateOutput: string;
  baselineScore: number;
  candidateScore: number;
  durationDeltaMs: number;
  outcome: RowOutcome;
  reviewed: boolean;
  /** Why a row landed in needs_review — never leave the reader guessing. */
  reviewNote?: string;
  baselineTraceId: string;
  candidateTraceId: string;
}

export interface ComparisonGroupResult {
  key: string;
  label: string;
  baselineValue: number;
  candidateValue: number;
  caseCount: number;
  /** True when this group breaches the guardrail (regression > 2%). */
  breachesGuardrail: boolean;
}

export interface MetricSummary {
  label: string;
  baselineDisplay: string;
  candidateDisplay: string;
  deltaDisplay: string;
  /** Direction of the delta as the *user* should read it, not its arithmetic sign. */
  sentiment: "good" | "bad" | "neutral";
  isPrimary: boolean;
}

export interface ExperimentComparison {
  id: string;
  baselineExperimentId: string;
  candidateExperimentId: string;
  title: string;
  decision: {
    verdict: "meets_target" | "misses_target";
    headline: string;
    detail: string;
  };
  summary: MetricSummary[];
  groups: Record<GroupingKey, ComparisonGroupResult[]>;
  rows: ComparisonRow[];
  sourceDetectorIssueId: string;
}

// ---------------------------------------------------------------------------
// CI gate
// ---------------------------------------------------------------------------

export type GateStatus = "awaiting_approval" | "active" | "draft";

export interface GateCondition {
  id: string;
  label: string;
  detail: string;
  /** Whether the current comparison would satisfy this condition. */
  currentlyMet: boolean;
}

export interface CiGate {
  id: string;
  name: string;
  status: GateStatus;
  baselineLabel: string;
  datasetId: string;
  datasetName: string;
  datasetVersion: string;
  conditions: GateCondition[];
  sourceDetectorIssueId: string;
  scorerIds: string[];
  createdBy: string;
  /** Hardcoded preview of the PR check this gate would post. */
  checkPreview: {
    name: string;
    conclusion: "success" | "failure" | "neutral";
    summary: string;
    lines: string[];
  };
  /** Hardcoded preview of the machine-readable result payload. */
  machineReadable: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Traces (prototype trace explorer)
// ---------------------------------------------------------------------------

export interface TraceScore {
  name: string;
  value: number;
}

export interface TraceFeedback {
  kind: "thumbs_up" | "thumbs_down" | "none";
  comment?: string;
}

export interface TraceRow {
  traceId: string;
  name: string;
  timestamp: string;
  durationMs: number;
  cost: number;
  status: "ok" | "error";
  errorMessage?: string;
  intent: string;
  model: string;
  appVersion: string;
  userId: string;
  sessionId: string;
  scores: TraceScore[];
  feedback: TraceFeedback;
  /** True when this trace is in the DET-2841 affected cohort. */
  inAffectedCohort: boolean;
}

/** A span in the prototype's trace-detail tree. */
export interface ProtoSpan {
  spanId: string;
  name: string;
  kind: "trace" | "llm" | "tool" | "span" | "agent";
  /** Human label for the component role, e.g. "function", "retrieval", "scorer". */
  role: string;
  durationMs: number;
  cost: number | null;
  status: "ok" | "error";
  input: string;
  output: string;
  metadata: Record<string, string>;
  children: ProtoSpan[];
  /** Granularity this span maps to when captured as a component-level case. */
  granularity: Granularity;
}

export interface SavedView {
  id: string;
  label: string;
  description: string;
  filters: Partial<TraceFilterState>;
}

export interface TraceFilterState {
  search: string;
  intent: string;
  model: string;
  appVersion: string;
  status: "all" | "ok" | "error";
  cohortOnly: boolean;
}

export const EMPTY_TRACE_FILTERS: TraceFilterState = {
  search: "",
  intent: "all",
  model: "all",
  appVersion: "all",
  status: "all",
  cohortOnly: false,
};
