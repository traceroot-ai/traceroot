/**
 * Offline-evaluation contract — the shared, typed shapes for both the
 * user-session CRUD routes and the API-key SDK reporting routes.
 *
 * This is the stable handoff for the SDK team: the request/response schemas an
 * SDK calls to report a run. See `docs/offline-eval-sdk-contract.md`. The server
 * owns all row ids and `run_number`; the SDK owns `candidate_version`, the
 * optional `client_run_id` idempotency key, and the OTel `trace_id`.
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// Status vocabularies (string enums, validated here, documented in the schema)
// ---------------------------------------------------------------------------

export const EVAL_RUN_STATUSES = [
  "running",
  "completed",
  "completed_with_errors",
  "failed",
  "incomplete",
] as const;
export const EvalRunStatusSchema = z.enum(EVAL_RUN_STATUSES);
export type EvalRunStatus = (typeof EVAL_RUN_STATUSES)[number];

export const EVAL_RESULT_STATUSES = ["passed", "failed", "errored", "not_scored"] as const;
export const EvalResultStatusSchema = z.enum(EVAL_RESULT_STATUSES);
export type EvalResultStatus = (typeof EVAL_RESULT_STATUSES)[number];

export const RESULT_CHANGES = ["improved", "regressed", "unchanged"] as const;
export const ResultChangeSchema = z.enum(RESULT_CHANGES);

export const REVIEW_STATUSES = ["needs_review", "ready"] as const;
export const ReviewStatusSchema = z.enum(REVIEW_STATUSES);

export const CAPTURE_REASONS = ["manual", "error", "failed_tool", "negative_feedback"] as const;
export const CaptureReasonSchema = z.enum(CAPTURE_REASONS);

export const HUMAN_VERDICTS = ["pass", "fail", "unsure"] as const;
export const HumanVerdictSchema = z.enum(HUMAN_VERDICTS);

// ---------------------------------------------------------------------------
// Scorer descriptor — name + version recorded on every run and score
// ---------------------------------------------------------------------------

export const ScorerRefSchema = z.object({
  name: z.string().min(1).max(200),
  version: z.string().min(1).max(50),
});
export type ScorerRef = z.infer<typeof ScorerRefSchema>;

/** One scorer's outcome on one result. `error` set = the scorer failed to judge. */
export const ScoreInputSchema = z
  .object({
    scorer_name: z.string().min(1).max(200),
    scorer_version: z.string().min(1).max(50),
    numeric_value: z.number().nullable().optional(),
    bool_value: z.boolean().nullable().optional(),
    string_value: z.string().max(2000).nullable().optional(),
    passed: z.boolean().nullable().optional(),
    explanation: z.string().max(5000).nullable().optional(),
    error: z.string().max(5000).nullable().optional(),
  })
  .strict();
export type ScoreInput = z.infer<typeof ScoreInputSchema>;

// ---------------------------------------------------------------------------
// SDK reporting requests
// ---------------------------------------------------------------------------

/**
 * Register/start a run. Idempotent on `client_run_id` within an evaluation:
 * re-sending the same key returns the existing run. The evaluation lineage is
 * resolved (create-if-absent) from `evaluation_name` + `dataset_id`.
 */
export const RegisterRunRequestSchema = z
  .object({
    evaluation_name: z.string().min(1).max(200),
    dataset_id: z.string().min(1).max(64),
    /** Omit to pin the dataset's current published version. */
    dataset_version_id: z.string().min(1).max(64).nullable().optional(),
    candidate_version: z.string().min(1).max(200),
    main_score_name: z.string().min(1).max(200).nullable().optional(),
    environment: z.string().min(1).max(64).default("evaluation"),
    scorers: z.array(ScorerRefSchema).default([]),
    /** SDK-supplied idempotency key. */
    client_run_id: z.string().min(1).max(128).nullable().optional(),
    baseline_run_id: z.string().min(1).max(64).nullable().optional(),
    case_count: z.number().int().nonnegative().nullable().optional(),
  })
  .strict();
export type RegisterRunRequest = z.infer<typeof RegisterRunRequestSchema>;

export interface RegisterRunResponse {
  evaluation_id: string;
  evaluation_run_id: string;
  run_number: number;
  dataset_version_id: string;
}

/**
 * Upsert one test-case result. Idempotent on (`run_id`, `test_case_id`).
 * `trace_id` may be null now and set on a later call (out-of-order arrival).
 * Sending `scores` replaces the result's scores.
 */
export const UpsertResultRequestSchema = z
  .object({
    test_case_id: z.string().min(1).max(64),
    trace_id: z.string().min(1).max(64).nullable().optional(),
    input: z.string(),
    expected_output: z.string().nullable().optional(),
    candidate_output: z.string().nullable().optional(),
    baseline_output: z.string().nullable().optional(),
    status: EvalResultStatusSchema,
    main_score: z.number().nullable().optional(),
    change: ResultChangeSchema.nullable().optional(),
    task_error: z.string().max(10000).nullable().optional(),
    duration_ms: z.number().int().nonnegative().nullable().optional(),
    cost: z.number().nonnegative().nullable().optional(),
    scores: z.array(ScoreInputSchema).default([]),
  })
  .strict();
export type UpsertResultRequest = z.infer<typeof UpsertResultRequestSchema>;

export interface UpsertResultResponse {
  evaluation_result_id: string;
}

/** Complete/fail a run, reporting final completeness counts. */
export const CompleteRunRequestSchema = z
  .object({
    status: EvalRunStatusSchema,
    main_score: z.number().nullable().optional(),
    case_count: z.number().int().nonnegative().nullable().optional(),
    scored_count: z.number().int().nonnegative().nullable().optional(),
    task_error_count: z.number().int().nonnegative().nullable().optional(),
    scorer_error_count: z.number().int().nonnegative().nullable().optional(),
  })
  .strict();
export type CompleteRunRequest = z.infer<typeof CompleteRunRequestSchema>;

// ---------------------------------------------------------------------------
// User-session CRUD requests (Datasets pages)
// ---------------------------------------------------------------------------

export const CreateDatasetRequestSchema = z
  .object({
    name: z.string().min(1).max(200),
    description: z.string().max(2000).nullable().optional(),
  })
  .strict();
export type CreateDatasetRequest = z.infer<typeof CreateDatasetRequestSchema>;

export const UpdateDatasetRequestSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    description: z.string().max(2000).nullable().optional(),
  })
  .strict();

/** Save a trace/span as a new test case (publishes a new dataset version). */
export const CreateTestCaseRequestSchema = z
  .object({
    input: z.string(),
    expected: z.string().nullable().optional(),
    recorded_output: z.string().nullable().optional(),
    metadata: z.record(z.string(), z.unknown()).nullable().optional(),
    review: ReviewStatusSchema.default("needs_review"),
    capture_reason: CaptureReasonSchema.default("manual"),
    source_trace_id: z.string().max(64).nullable().optional(),
    source_span_id: z.string().max(64).nullable().optional(),
    source_span_name: z.string().max(400).nullable().optional(),
    source_span_kind: z.string().max(32).nullable().optional(),
  })
  .strict();
export type CreateTestCaseRequest = z.infer<typeof CreateTestCaseRequestSchema>;

/** Edit a test case → publishes a new dataset version (old snapshots untouched). */
export const UpdateTestCaseRequestSchema = z
  .object({
    input: z.string().optional(),
    expected: z.string().nullable().optional(),
    metadata: z.record(z.string(), z.unknown()).nullable().optional(),
    review: ReviewStatusSchema.optional(),
  })
  .strict();
export type UpdateTestCaseRequest = z.infer<typeof UpdateTestCaseRequestSchema>;

export const CreateHumanScoreRequestSchema = z
  .object({
    verdict: HumanVerdictSchema,
    quality: z.number().int().min(1).max(5).nullable().optional(),
    comment: z.string().max(5000).nullable().optional(),
    reviewer: z.string().min(1).max(200),
  })
  .strict();
export type CreateHumanScoreRequest = z.infer<typeof CreateHumanScoreRequestSchema>;
