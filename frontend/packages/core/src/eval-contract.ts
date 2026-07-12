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
  "cancelled",
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

/** How a scorer's value is typed (inferred from the value when not declared). */
export const SCORER_VALUE_TYPES = ["numeric", "boolean", "categorical"] as const;
export const ScorerValueTypeSchema = z.enum(SCORER_VALUE_TYPES);
export type ScorerValueType = (typeof SCORER_VALUE_TYPES)[number];

/** Whether a higher or lower value is better; categorical scorers have no direction. */
export const SCORER_DIRECTIONS = ["higher_is_better", "lower_is_better", "none"] as const;
export const ScorerDirectionSchema = z.enum(SCORER_DIRECTIONS);
export type ScorerDirection = (typeof SCORER_DIRECTIONS)[number];

/** How a scorer is implemented — drives the read-only Scorer-detail layout. */
export const SCORER_TYPES = ["llm_judge", "code"] as const;
export const ScorerTypeSchema = z.enum(SCORER_TYPES);
export type ScorerType = (typeof SCORER_TYPES)[number];

export const SCORER_OUTPUT_TYPES = ["score", "classification"] as const;
export const ScorerOutputTypeSchema = z.enum(SCORER_OUTPUT_TYPES);

export const SCORER_LANGUAGES = ["python", "typescript"] as const;
export const ScorerLanguageSchema = z.enum(SCORER_LANGUAGES);

/** One prompt message of an LLM-judge scorer's definition. */
export const ScorerMessageSchema = z.object({
  role: z.string().min(1).max(50),
  content: z.string(),
});

/**
 * A scorer's descriptor. `name` + `version` are the identity used for cell
 * comparison; the richer metadata is optional and back-compatible — an old SDK
 * sending only `{name, version}` stays valid, and the backend defaults direction
 * (numeric/boolean → higher-is-better, categorical → none) when it's absent.
 *
 * The DEFINITION fields (`scorer_type`, prompt/source, config) let the read-only
 * Scorer detail render an LLM judge's model + messages or a code scorer's snippet.
 * This is a plain (non-strict) object: unknown keys are stripped, so a field must
 * be declared here to survive into the persisted per-run manifest that the scorer
 * registry reads back (see `lib/eval/scorer-registry.ts`).
 */
export const ScorerRefSchema = z.object({
  name: z.string().min(1).max(200),
  version: z.string().min(1).max(50),
  value_type: ScorerValueTypeSchema.nullable().optional(),
  direction: ScorerDirectionSchema.nullable().optional(),
  threshold: z.number().nullable().optional(),
  // SDK-reported definition (all optional; absent → "—" in the detail).
  scorer_type: ScorerTypeSchema.nullable().optional(),
  output_type: ScorerOutputTypeSchema.nullable().optional(),
  description: z.string().max(2000).nullable().optional(),
  metadata: z.unknown().nullable().optional(),
  // llm_judge
  model: z.string().max(200).nullable().optional(),
  messages: z.array(ScorerMessageSchema).nullable().optional(),
  // code
  language: ScorerLanguageSchema.nullable().optional(),
  source: z.string().nullable().optional(),
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
    /**
     * Structured run provenance (model, prompt, config, git repo/ref/commit, …).
     * Free-form and optional — the current SDK does not send it, and its absence
     * never rejects a run. Presented as informational secondary detail, never as
     * an evaluation error, and never a source of secrets.
     */
    metadata: z.record(z.string(), z.unknown()).nullable().optional(),
  })
  .strict();
export type RegisterRunRequest = z.infer<typeof RegisterRunRequestSchema>;

export interface RegisterRunResponse {
  evaluation_id: string;
  evaluation_run_id: string;
  run_number: number;
  dataset_version_id: string;
  /**
   * UI-relative path to the run, `/projects/<projectId>/evaluations/<runId>`. The
   * backend owns the route shape. Kept for back-compat; prefer `run_url` for the
   * printed link — joining `run_path` to the SDK's `host_url` only resolves when the
   * API and UI share an origin (breaks in split-origin dev, where host_url is the API).
   */
  run_path: string;
  /**
   * Absolute, clickable run URL — `run_path` resolved against the control plane's
   * configured public app origin (`NEXT_PUBLIC_APP_URL`). Correct regardless of how
   * the API and UI origins are split, so the SDK should print this verbatim rather
   * than reconstructing the link from `host_url`.
   */
  run_url: string;
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

// ---------------------------------------------------------------------------
// API-key dataset authoring (SDK owns dataset_id / test_case_id; server owns
// dataset_version_id / version_number). See contract-delta-dataset-and-lifecycle.
//
// input / expected are accepted as any JSON value and stored as text (a non-string
// value is JSON-stringified), matching how the pull endpoints already return them.
// ---------------------------------------------------------------------------

/** Max test-case changes accepted in one A4 publish; over this → 413 so the SDK chunks. */
export const DATASET_VERSION_MAX_CHANGES = 1000;

/** A2 — upsert a dataset by its client-generated id (idempotent, no version). */
export const PublicUpsertDatasetRequestSchema = z
  .object({
    dataset_id: z.string().min(1).max(64),
    name: z.string().min(1).max(200),
    description: z.string().max(2000).nullable().optional(),
    metadata: z.record(z.string(), z.unknown()).nullable().optional(),
  })
  .strict();
export type PublicUpsertDatasetRequest = z.infer<typeof PublicUpsertDatasetRequestSchema>;

/** A3 — dataset metadata only; never mutates a published version. */
export const PublicUpdateDatasetRequestSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    description: z.string().max(2000).nullable().optional(),
    metadata: z.record(z.string(), z.unknown()).nullable().optional(),
  })
  .strict();
export type PublicUpdateDatasetRequest = z.infer<typeof PublicUpdateDatasetRequestSchema>;

const UpsertCaseChangeSchema = z.object({
  op: z.literal("upsert"),
  test_case_id: z.string().min(1).max(64),
  input: z.unknown(),
  expected: z.unknown().optional(),
  metadata: z.record(z.string(), z.unknown()).nullable().optional(),
  source_trace_id: z.string().max(64).nullable().optional(),
  source_span_id: z.string().max(64).nullable().optional(),
});
const ArchiveCaseChangeSchema = z.object({
  op: z.literal("archive"),
  test_case_id: z.string().min(1).max(64),
});
const DeleteCaseChangeSchema = z.object({
  op: z.literal("delete"),
  test_case_id: z.string().min(1).max(64),
});
export const DatasetChangeSchema = z.discriminatedUnion("op", [
  UpsertCaseChangeSchema,
  ArchiveCaseChangeSchema,
  DeleteCaseChangeSchema,
]);
export type DatasetChange = z.infer<typeof DatasetChangeSchema>;

/**
 * A4 — publish ONE immutable dataset version from a batch of changes.
 *
 * `base_version_id` is the version the edit was based on (null on first publish);
 * a mismatch with the dataset's current version is a 409 conflict. `idempotency_key`
 * makes a retried publish return the same version instead of a duplicate. The
 * change cap (DATASET_VERSION_MAX_CHANGES) is enforced in the route as a 413, not
 * here, so the SDK gets the limit back and chunks.
 */
export const PublishDatasetVersionRequestSchema = z
  .object({
    base_version_id: z.string().min(1).max(64).nullable(),
    label: z.string().min(1).max(64).optional(),
    changes: z.array(DatasetChangeSchema).min(1),
    idempotency_key: z.string().min(1).max(128).nullable().optional(),
  })
  .strict();
export type PublishDatasetVersionRequest = z.infer<typeof PublishDatasetVersionRequestSchema>;
