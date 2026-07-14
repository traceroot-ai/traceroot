"""Typed request/response models for the public offline-evaluation reporting API.

These mirror the finalized Next.js/Zod contract in
``frontend/packages/core/src/eval-contract.ts`` field-for-field, so the gateway
can (a) validate SDK payloads before forwarding and (b) publish a useful,
codegen-friendly OpenAPI schema. Persistence stays in the Prisma-owned Next.js
handlers — the gateway forwards the (validated) body on and never duplicates it.

Parity rules with the Zod source:
- Zod ``.strict()`` objects reject unknown keys → ``ConfigDict(extra="forbid")``.
- ``ScorerRefSchema`` is a plain (non-strict) ``z.object`` that strips unknown
  keys → default ``extra="ignore"`` (no forbid) on ``ScorerRef``.
- ``z.string().min(1).max(n)`` → ``Field(min_length=1, max_length=n)``.
- ``z.number().int().nonnegative()`` → ``int`` with ``ge=0``; ``z.number()`` → ``float``.
- ``.nullable().optional()`` → ``T | None = None``; ``.default(x)`` → default ``x``.

A cross-language drift test (``tests/rest/test_eval_contract_parity.py`` +
``eval-contract-parity.drift.test.ts``) feeds the same representative payloads to
both layers and asserts identical accept/reject verdicts.
"""

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

# --- Status vocabularies (mirror the z.enum unions) -------------------------

EvalRunStatus = Literal[
    "running", "completed", "completed_with_errors", "failed", "incomplete", "cancelled"
]
EvalResultStatus = Literal["passed", "failed", "errored", "not_scored"]
ResultChange = Literal["improved", "regressed", "unchanged"]
ScorerValueType = Literal["numeric", "boolean", "categorical"]
ScorerDirection = Literal["higher_is_better", "lower_is_better", "none"]


class ErrorResponse(BaseModel):
    """The canonical public error envelope (matches the gateway's normalized shape)."""

    detail: str


# --- Scorer + score descriptors ---------------------------------------------


class ScorerRef(BaseModel):
    """A scorer's descriptor. ``name`` + ``version`` are the comparison identity;
    the richer metadata is optional and back-compatible (an old SDK sending only
    ``{name, version}`` stays valid). Mirrors the non-strict ``ScorerRefSchema``,
    so unknown keys are ignored rather than rejected.
    """

    name: str = Field(min_length=1, max_length=200)
    version: str = Field(min_length=1, max_length=50)
    value_type: ScorerValueType | None = None
    direction: ScorerDirection | None = None
    threshold: float | None = None


class ScoreInput(BaseModel):
    """One scorer's outcome on one result. ``error`` set = the scorer failed to judge."""

    model_config = ConfigDict(extra="forbid")

    scorer_name: str = Field(min_length=1, max_length=200)
    scorer_version: str = Field(min_length=1, max_length=50)
    numeric_value: float | None = None
    bool_value: bool | None = None
    string_value: str | None = Field(default=None, max_length=2000)
    passed: bool | None = None
    explanation: str | None = Field(default=None, max_length=5000)
    error: str | None = Field(default=None, max_length=5000)


# --- (a) Register / start a run ---------------------------------------------


class RegisterRunRequest(BaseModel):
    """Register/start a run. Idempotent on ``client_run_id`` within an evaluation."""

    model_config = ConfigDict(extra="forbid")

    evaluation_name: str = Field(min_length=1, max_length=200)
    dataset_id: str = Field(min_length=1, max_length=64)
    # Omit to pin the dataset's current published version.
    dataset_version_id: str | None = Field(default=None, min_length=1, max_length=64)
    candidate_version: str = Field(min_length=1, max_length=200)
    main_score_name: str | None = Field(default=None, min_length=1, max_length=200)
    environment: str = Field(default="evaluation", min_length=1, max_length=64)
    scorers: list[ScorerRef] = Field(default_factory=list)
    # SDK-supplied idempotency key.
    client_run_id: str | None = Field(default=None, min_length=1, max_length=128)
    baseline_run_id: str | None = Field(default=None, min_length=1, max_length=64)
    case_count: int | None = Field(default=None, ge=0)
    # Free-form run provenance (model, prompt, config, git repo/ref/commit, …).
    metadata: dict[str, Any] | None = None


class RegisterRunResponse(BaseModel):
    evaluation_id: str
    evaluation_run_id: str
    run_number: int
    dataset_version_id: str
    # UI-relative path "/projects/<projectId>/evaluations/<runId>"; the SDK joins it to
    # its own host_url to print a clickable run link. The gateway proxies the upstream
    # body verbatim, so this is documentation/parity only — no logic here builds it.
    run_path: str


# --- (b) Upsert one test-case result with scores ----------------------------


class UpsertResultRequest(BaseModel):
    """Upsert one test-case result. Idempotent on (``run_id``, ``test_case_id``).
    ``trace_id`` may be null now and set on a later call (out-of-order arrival).
    Sending ``scores`` replaces the result's scores.
    """

    model_config = ConfigDict(extra="forbid")

    test_case_id: str = Field(min_length=1, max_length=64)
    trace_id: str | None = Field(default=None, min_length=1, max_length=64)
    input: str
    expected_output: str | None = None
    candidate_output: str | None = None
    baseline_output: str | None = None
    status: EvalResultStatus
    main_score: float | None = None
    change: ResultChange | None = None
    task_error: str | None = Field(default=None, max_length=10000)
    duration_ms: int | None = Field(default=None, ge=0)
    cost: float | None = Field(default=None, ge=0)
    scores: list[ScoreInput] = Field(default_factory=list)


class UpsertResultResponse(BaseModel):
    evaluation_result_id: str


# --- (c) Complete / finalize a run ------------------------------------------


class CompleteRunRequest(BaseModel):
    """Complete/fail a run, reporting final completeness counts."""

    model_config = ConfigDict(extra="forbid")

    status: EvalRunStatus
    main_score: float | None = None
    case_count: int | None = Field(default=None, ge=0)
    scored_count: int | None = Field(default=None, ge=0)
    task_error_count: int | None = Field(default=None, ge=0)
    scorer_error_count: int | None = Field(default=None, ge=0)


class CompleteRunResponse(BaseModel):
    evaluation_run_id: str
    # Echoes the persisted run status.
    status: EvalRunStatus
