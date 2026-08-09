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
// Payload caps
//
// Every field of the API-key ingest surface is bounded here: route handlers have
// no body-size limit of their own, so an unbounded field is buffered in full and
// then persisted verbatim. Small fields are capped inline at their declaration
// (ids 64/128, `description`/`string_value` 2000, `explanation`/`error` 5000,
// `task_error` 10000); the large payload fields share the caps below.
// ---------------------------------------------------------------------------

/** Max characters of a stored text payload (`input`, `*_output`, dataset case values). */
export const EVAL_PAYLOAD_TEXT_MAX = 1_000_000;
/** Max characters of a free-form `metadata` object once serialized to JSON. */
export const EVAL_METADATA_MAX = 64_000;
/** Max scorers declared on one run, and max scores sent with one result. */
export const EVAL_SCORER_LIST_MAX = 200;
/** Max prompt messages, and max characters of each, on an llm_judge descriptor. */
export const SCORER_MESSAGES_MAX = 50;
export const SCORER_MESSAGE_CONTENT_MAX = 20_000;
/** Max characters of a code scorer's `source` snippet. */
export const SCORER_SOURCE_MAX = 50_000;
/** Max number (and each length) of `required_inputs` a scorer may declare. */
export const SCORER_REQUIRED_INPUTS_MAX = 20;
export const SCORER_REQUIRED_INPUT_LEN_MAX = 100;

/** Whether a value serializes to at most `max` characters (`false` if unserializable). */
function withinJsonSize(value: unknown, max: number): boolean {
  try {
    return (JSON.stringify(value) ?? "").length <= max;
  } catch {
    return false;
  }
}

/** Any JSON value, bounded by its serialized size. */
const boundedJson = (max: number) =>
  z.unknown().refine((v) => withinJsonSize(v, max), {
    message: `value must serialize to at most ${max} characters`,
  });

/** Free-form JSON object, bounded by its serialized size. */
const MetadataSchema = z
  .record(z.string(), z.unknown())
  .refine((v) => withinJsonSize(v, EVAL_METADATA_MAX), {
    message: `metadata must serialize to at most ${EVAL_METADATA_MAX} characters`,
  });

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
  content: z.string().max(SCORER_MESSAGE_CONTENT_MAX),
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
 *
 * The three display-only vocabularies (`scorer_type`, `output_type`, `language`)
 * degrade to null on an unrecognised value instead of rejecting, mirroring how
 * undeclared keys are dropped: an SDK newer than the control plane must not fail
 * run registration — and lose the run's every result and score — over a field
 * that only decides how the Scorer detail renders. The known values stay listed
 * in SCORER_TYPES / SCORER_OUTPUT_TYPES / SCORER_LANGUAGES above. This tolerance
 * deliberately stops here: the vocabularies that drive persistence and
 * aggregation (run/result status, `change`, value type, direction) still reject.
 */
export const ScorerRefSchema = z.object({
  name: z.string().min(1).max(200),
  version: z.string().min(1).max(50),
  value_type: ScorerValueTypeSchema.nullable().optional(),
  direction: ScorerDirectionSchema.nullable().optional(),
  threshold: z.number().nullable().optional(),
  // SDK-reported definition (all optional; absent or unrecognised → "—" in the detail).
  scorer_type: ScorerTypeSchema.nullable().optional().catch(null),
  output_type: ScorerOutputTypeSchema.nullable().optional().catch(null),
  description: z.string().max(2000).nullable().optional(),
  // The inputs the scorer actually reads (e.g. "input", "output", "expected"). Free
  // strings, SDK-reported — the UI interprets the ones it knows (notably whether the
  // reference answer "expected" is used) and leaves the rest as declared. Absent =
  // unknown, never "needs nothing".
  required_inputs: z
    .array(z.string().min(1).max(SCORER_REQUIRED_INPUT_LEN_MAX))
    .max(SCORER_REQUIRED_INPUTS_MAX)
    .nullable()
    .optional(),
  metadata: boundedJson(EVAL_METADATA_MAX).nullable().optional(),
  // llm_judge
  model: z.string().max(200).nullable().optional(),
  messages: z.array(ScorerMessageSchema).max(SCORER_MESSAGES_MAX).nullable().optional(),
  // code
  language: ScorerLanguageSchema.nullable().optional().catch(null),
  source: z.string().max(SCORER_SOURCE_MAX).nullable().optional(),
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
 * Structured, machine-collected run provenance — the verifiable execution
 * context around the run. Distinct from free-form `metadata`: every field is
 * typed, optional, and reported by the SDK from what it can actually observe
 * (git/CI/SDK identity). Unknown values are omitted or null and are never
 * inferred; a missing block never rejects a run. `candidate_version` stays the
 * user-facing label — provenance is not a substitute for it and is never
 * treated as a verified identity beyond what the SDK reported.
 */
export const RunProvenanceSchema = z
  .object({
    git_repository: z.string().max(500).nullable().optional(),
    git_ref: z.string().max(500).nullable().optional(),
    git_commit: z.string().max(200).nullable().optional(),
    git_dirty: z.boolean().nullable().optional(),
    ci_provider: z.string().max(100).nullable().optional(),
    ci_build_id: z.string().max(200).nullable().optional(),
    sdk_language: z.string().max(50).nullable().optional(),
    sdk_version: z.string().max(50).nullable().optional(),
    /**
     * Declared candidate identity — surfaced only if the SDK reports it, never
     * inferred from `candidate_version` or any label.
     */
    declared_model: z.string().max(200).nullable().optional(),
    declared_prompt_version: z.string().max(200).nullable().optional(),
  });
// Non-strict (strips unknown keys), mirroring ScorerRef and the permissive
// gateway: a newer SDK adding a provenance field must not 422 the whole run.
export type RunProvenance = z.infer<typeof RunProvenanceSchema>;

/**
 * Register/start a run. Idempotent on `client_run_id` within an evaluation:
 * re-sending the same key returns the existing run. The evaluation lineage is
 * resolved (create-if-absent) from `evaluation_name` + `dataset_id`.
 */
export const RegisterRunRequestSchema = z
  .object({
    evaluation_name: z.string().min(1).max(200),
    /**
     * Stable semantic identity of the evaluation, DECOUPLED from the display
     * `evaluation_name`. Runs sharing `(project, evaluation_key)` group under one
     * evaluation definition regardless of SDK language (Python + TypeScript), while two
     * evaluations may share a display name under different keys. Additive + back-compatible:
     * an older SDK omits it and the platform falls back to grouping by `evaluation_name`.
     */
    evaluation_key: z.string().min(1).max(200).nullable().optional(),
    dataset_id: z.string().min(1).max(64),
    /** Omit to pin the dataset's current published version. */
    dataset_version_id: z.string().min(1).max(64).nullable().optional(),
    candidate_version: z.string().min(1).max(200),
    main_score_name: z.string().min(1).max(200).nullable().optional(),
    environment: z.string().min(1).max(64).default("evaluation"),
    scorers: z.array(ScorerRefSchema).max(EVAL_SCORER_LIST_MAX).default([]),
    /** SDK-supplied idempotency key. */
    client_run_id: z.string().min(1).max(128).nullable().optional(),
    baseline_run_id: z.string().min(1).max(64).nullable().optional(),
    case_count: z.number().int().nonnegative().nullable().optional(),
    /**
     * Typed execution provenance (git/CI/SDK identity, declared candidate
     * model/prompt). Optional; absence never rejects a run. See
     * {@link RunProvenanceSchema}.
     */
    provenance: RunProvenanceSchema.nullable().optional(),
    /**
     * Free-form run metadata — arbitrary user key/values, kept verbatim. Distinct
     * from `provenance` (typed) — presented as informational secondary detail,
     * never an evaluation error, and never a source of secrets.
     */
    metadata: MetadataSchema.nullable().optional(),
  })
  .strict();
export type RegisterRunRequest = z.infer<typeof RegisterRunRequestSchema>;

/**
 * The response bodies are schemas, not bare interfaces, so the structural parity
 * guard can introspect them the same way it introspects the requests — a response
 * field added on one layer only is otherwise invisible to every test. The gateway
 * proxies the upstream body verbatim, so these are the published contract and the
 * inferred types below stay the single definition the handlers write against.
 */
export const RegisterRunResponseSchema = z.object({
  evaluation_id: z.string(),
  evaluation_run_id: z.string(),
  run_number: z.number().int(),
  dataset_version_id: z.string(),
  /**
   * UI-relative path to the run, `/projects/<projectId>/evaluations/<runId>`. The
   * backend owns the route shape. Kept for back-compat; prefer `run_url` for the
   * printed link — joining `run_path` to the SDK's `host_url` only resolves when the
   * API and UI share an origin (breaks in split-origin dev, where host_url is the API).
   */
  run_path: z.string(),
  /**
   * Absolute, clickable run URL — `run_path` resolved against the control plane's
   * configured public app origin (`NEXT_PUBLIC_APP_URL`). Correct regardless of how
   * the API and UI origins are split, so the SDK should print this verbatim rather
   * than reconstructing the link from `host_url`.
   */
  run_url: z.string(),
});
export type RegisterRunResponse = z.infer<typeof RegisterRunResponseSchema>;

/**
 * Upsert one test-case result. Idempotent on (`run_id`, `test_case_id`).
 * `trace_id` may be null now and set on a later call (out-of-order arrival).
 *
 * `scores` is genuinely optional and carries three distinct meanings, because the
 * out-of-order flow this schema invites (POST the result with its scores, then
 * re-POST later just to attach the OTel `trace_id`) must not destroy them:
 *   - absent    → leave the result's existing scores untouched
 *   - `[]`      → clear the result's scores
 *   - non-empty → replace the result's scores with these
 * Handlers must branch on `undefined` vs `[]`; do not re-add a `.default([])`
 * here, which would collapse the first two cases into a silent delete.
 *
 * Every optional field is a *partial* update: a key the caller omits keeps its
 * stored value, while an explicit `null` clears it. So the SDK can link a trace
 * with `{test_case_id, input, status, trace_id}` without dropping the cost or the
 * scores it reported earlier. Omitting a field and sending `null` must therefore
 * stay distinguishable — no `.default()` on anything the server persists.
 */
export const UpsertResultRequestSchema = z
  .object({
    test_case_id: z.string().min(1).max(64),
    trace_id: z.string().min(1).max(64).nullable().optional(),
    input: z.string().max(EVAL_PAYLOAD_TEXT_MAX),
    expected_output: z.string().max(EVAL_PAYLOAD_TEXT_MAX).nullable().optional(),
    candidate_output: z.string().max(EVAL_PAYLOAD_TEXT_MAX).nullable().optional(),
    baseline_output: z.string().max(EVAL_PAYLOAD_TEXT_MAX).nullable().optional(),
    status: EvalResultStatusSchema,
    main_score: z.number().nullable().optional(),
    change: ResultChangeSchema.nullable().optional(),
    task_error: z.string().max(10000).nullable().optional(),
    duration_ms: z.number().int().nonnegative().nullable().optional(),
    cost: z.number().nonnegative().nullable().optional(),
    /**
     * Present = replace the result's scores with exactly this list (`[]` clears
     * them). Absent = leave the stored scores alone, so a partial follow-up call
     * never wipes scores merged in through the per-scorer endpoint. Rejects a
     * repeated (`scorer_name`, `scorer_version`) — one row per scorer per result
     * is a unique constraint, and a duplicate would fail the write instead.
     */
    scores: z
      .array(ScoreInputSchema)
      .max(EVAL_SCORER_LIST_MAX)
      .refine(
        (scores) =>
          new Set(scores.map((s) => JSON.stringify([s.scorer_name, s.scorer_version]))).size ===
          scores.length,
        { message: "scores contains a duplicate (scorer_name, scorer_version)" },
      )
      .optional(),
  })
  .strict();
export type UpsertResultRequest = z.infer<typeof UpsertResultRequestSchema>;

export const UpsertResultResponseSchema = z.object({
  evaluation_result_id: z.string(),
});
export type UpsertResultResponse = z.infer<typeof UpsertResultResponseSchema>;

/** Complete/fail a run, reporting final completeness counts. */
export const CompleteRunRequestSchema = z
  .object({
    status: EvalRunStatusSchema,
    main_score: z.number().nullable().optional(),
    /**
     * The run-level main-score metric name, RESOLVED at completion. Lets an SDK
     * register a run before any scorer's emitted metric name is known and name it
     * here once it is. Optional and additive — an older SDK omits it and keeps the
     * name it chose at registration (or none). When registration already fixed a
     * name, this must match it (a mismatch is a conflict); for a successfully scored
     * run the resolved name must exist among the run's emitted scores.
     */
    main_score_name: z.string().min(1).max(200).nullable().optional(),
    case_count: z.number().int().nonnegative().nullable().optional(),
    scored_count: z.number().int().nonnegative().nullable().optional(),
    task_error_count: z.number().int().nonnegative().nullable().optional(),
    scorer_error_count: z.number().int().nonnegative().nullable().optional(),
  })
  .strict();
export type CompleteRunRequest = z.infer<typeof CompleteRunRequestSchema>;

export const CompleteRunResponseSchema = z.object({
  evaluation_run_id: z.string(),
  /** Echoes the persisted run status. */
  status: EvalRunStatusSchema,
});
export type CompleteRunResponse = z.infer<typeof CompleteRunResponseSchema>;

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
    input: z.string().max(EVAL_PAYLOAD_TEXT_MAX),
    expected: z.string().max(EVAL_PAYLOAD_TEXT_MAX).nullable().optional(),
    metadata: MetadataSchema.nullable().optional(),
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
    input: z.string().max(EVAL_PAYLOAD_TEXT_MAX).optional(),
    expected: z.string().max(EVAL_PAYLOAD_TEXT_MAX).nullable().optional(),
    metadata: MetadataSchema.nullable().optional(),
    review: ReviewStatusSchema.optional(),
  })
  .strict();
export type UpdateTestCaseRequest = z.infer<typeof UpdateTestCaseRequestSchema>;

/** The three explicit evaluation-result → dataset actions the UI can request. */
export const ResultDatasetActionSchema = z.enum([
  "update_existing_case",
  "save_new_case",
  "duplicate_as_variant",
]);
export type ResultDatasetAction = z.infer<typeof ResultDatasetActionSchema>;

/**
 * Save an evaluation result into a dataset. Candidate output is NEVER used as the
 * expected output unless `use_candidate_as_expected` is set (or an explicit
 * `expected` is supplied). Re-saving a result into its ORIGINATING dataset as a new
 * case is refused with a conflict that directs the client to update instead — only
 * `duplicate_as_variant` intentionally creates a second logical case.
 */
export const SaveResultToDatasetRequestSchema = z
  .object({
    action: ResultDatasetActionSchema,
    /** Target dataset for save_new_case / duplicate_as_variant. For
     *  update_existing_case it is ignored (the originating dataset is used). */
    dataset_id: z.string().min(1).max(64).nullable().optional(),
    /** Case input; defaults to the result's recorded input when omitted. */
    input: z.string().max(EVAL_PAYLOAD_TEXT_MAX).nullable().optional(),
    /** Explicit expected output. */
    expected: z.string().max(EVAL_PAYLOAD_TEXT_MAX).nullable().optional(),
    /** Explicit opt-in to set expected = the result's candidate output. */
    use_candidate_as_expected: z.boolean().optional(),
    metadata: MetadataSchema.nullable().optional(),
    /** Idempotency for retried requests (a replay returns the version already published). */
    idempotency_key: z.string().min(1).max(128).nullable().optional(),
  })
  .strict();
export type SaveResultToDatasetRequest = z.infer<typeof SaveResultToDatasetRequestSchema>;

export const CreateHumanScoreRequestSchema = z
  .object({
    /** Named review dimension; defaults to the single "overall" dimension. */
    dimension: z.string().min(1).max(100).default("overall"),
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

/**
 * Size ceilings for a publish. A count cap alone is not a limit: 1000 changes each
 * carrying an unbounded `input` is still unbounded, and the body is fully buffered
 * and parsed before any per-item check can run. So the request is refused on the
 * wire at DATASET_VERSION_MAX_BYTES, and each value is bounded individually here.
 */
export const DATASET_VERSION_MAX_BYTES = 8 * 1024 * 1024;
export const DATASET_CASE_MAX_BYTES = 256 * 1024;

/** UTF-8 size of a value's JSON form — what the request weighs and the column stores. */
export function serializedByteLength(value: unknown): number {
  const json = JSON.stringify(value ?? null);
  if (json === undefined) return 0;
  return new TextEncoder().encode(json).length;
}

/** A2 — upsert a dataset by its client-generated id (idempotent, no version). */
export const PublicUpsertDatasetRequestSchema = z
  .object({
    dataset_id: z.string().min(1).max(64),
    name: z.string().min(1).max(200),
    description: z.string().max(2000).nullable().optional(),
    metadata: MetadataSchema.nullable().optional(),
  })
  .strict();
export type PublicUpsertDatasetRequest = z.infer<typeof PublicUpsertDatasetRequestSchema>;

/** A3 — dataset metadata only; never mutates a published version. */
export const PublicUpdateDatasetRequestSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    description: z.string().max(2000).nullable().optional(),
    metadata: MetadataSchema.nullable().optional(),
  })
  .strict();
export type PublicUpdateDatasetRequest = z.infer<typeof PublicUpdateDatasetRequestSchema>;

const UpsertCaseChangeSchema = z.object({
  op: z.literal("upsert"),
  test_case_id: z.string().min(1).max(64),
  /**
   * Required — `upsert` is a full-case replace/add, and `TestCase.input` is
   * NOT NULL, so a missing key here would create a permanent case with an empty
   * input rather than 400. Both modifiers are load-bearing: `z.unknown()` on its
   * own accepts an absent key (which is also why `expected` below needs no
   * `.optional()` to be optional), the `.refine` rejects it with a readable
   * message, and `.nonoptional()` makes it required in the inferred type too.
   */
  input: boundedJson(EVAL_PAYLOAD_TEXT_MAX)
    .refine((v) => v !== undefined, { message: "input is required" })
    .nonoptional(),
  expected: boundedJson(EVAL_PAYLOAD_TEXT_MAX).optional(),
  metadata: MetadataSchema.nullable().optional(),
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
