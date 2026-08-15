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
- ``z.array(X).max(n)`` → ``list[X]`` with ``max_length=n``.
- A display-only enum with ``.catch(null)`` → ``Literal[...] | None`` plus a
  ``mode="before"`` validator that degrades an unrecognised value to ``None``.

A cross-language drift test (``tests/rest/test_eval_contract_parity.py`` +
``eval-contract-parity.drift.test.ts``) feeds the same representative payloads to
both layers and asserts identical accept/reject verdicts.
"""

import json
from typing import Any, Literal, get_args

from pydantic import BaseModel, ConfigDict, Field, ValidationInfo, field_validator

# --- Payload caps (mirror the shared caps at the top of the Zod contract) ----

#: Max characters of a stored text payload (``input``, ``*_output``).
EVAL_PAYLOAD_TEXT_MAX = 1_000_000
#: Max characters of a free-form ``metadata`` object once serialized to JSON.
EVAL_METADATA_MAX = 64_000
#: Max scorers declared on one run, and max scores sent with one result.
EVAL_SCORER_LIST_MAX = 200
#: Max prompt messages, and max characters of each, on an llm_judge descriptor.
SCORER_MESSAGES_MAX = 50
SCORER_MESSAGE_CONTENT_MAX = 20_000
#: Max characters of a code scorer's ``source`` snippet.
SCORER_SOURCE_MAX = 50_000


def _check_json_size(value: Any, max_chars: int, field: str) -> Any:
    """Mirror of the Zod ``withinJsonSize`` refinement on free-form JSON fields."""
    if value is None:
        return value
    try:
        serialized = json.dumps(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{field} must be JSON-serializable") from exc
    if len(serialized) > max_chars:
        raise ValueError(f"{field} must serialize to at most {max_chars} characters")
    return value


# --- Status vocabularies (mirror the z.enum unions) -------------------------

EvalRunStatus = Literal[
    "running", "completed", "completed_with_errors", "failed", "incomplete", "cancelled"
]
EvalResultStatus = Literal["passed", "failed", "errored", "not_scored"]
ResultChange = Literal["improved", "regressed", "unchanged"]
ScorerValueType = Literal["numeric", "boolean", "categorical"]
ScorerDirection = Literal["higher_is_better", "lower_is_better", "none"]
ScorerType = Literal["llm_judge", "code"]
ScorerOutputType = Literal["score", "classification"]
ScorerLanguage = Literal["python", "typescript"]


class ErrorResponse(BaseModel):
    """The canonical public error envelope (matches the gateway's normalized shape)."""

    detail: str


# --- Scorer + score descriptors ---------------------------------------------


class ScorerMessage(BaseModel):
    """One prompt message of an LLM-judge scorer's definition."""

    role: str = Field(min_length=1, max_length=50)
    content: str = Field(max_length=SCORER_MESSAGE_CONTENT_MAX)


#: The display-only vocabularies that degrade instead of rejecting (see ScorerRef).
_DISPLAY_ONLY_VARIANTS: dict[str, frozenset[str]] = {
    "scorer_type": frozenset(get_args(ScorerType)),
    "output_type": frozenset(get_args(ScorerOutputType)),
    "language": frozenset(get_args(ScorerLanguage)),
}


class ScorerRef(BaseModel):
    """A scorer's descriptor. ``name`` + ``version`` are the comparison identity;
    the richer metadata is optional and back-compatible (an old SDK sending only
    ``{name, version}`` stays valid). Mirrors the non-strict ``ScorerRefSchema``,
    so unknown keys are ignored rather than rejected.

    The DEFINITION fields (``scorer_type``, prompt/source, config) let the read-only
    Scorer detail render an LLM judge's model + messages or a code scorer's snippet.

    ``scorer_type`` / ``output_type`` / ``language`` are display-only, so an
    unrecognised value from a newer SDK degrades to ``None`` rather than failing
    run registration (which would lose the run's every result and score) —
    matching ``.catch(null)`` on the Zod side. The vocabularies that drive
    persistence and aggregation still reject.
    """

    name: str = Field(min_length=1, max_length=200)
    version: str = Field(min_length=1, max_length=50)
    value_type: ScorerValueType | None = None
    direction: ScorerDirection | None = None
    threshold: float | None = None
    # SDK-reported definition (all optional; absent or unrecognised → "—" in the detail).
    scorer_type: ScorerType | None = None
    output_type: ScorerOutputType | None = None
    description: str | None = Field(default=None, max_length=2000)
    metadata: Any | None = None
    # llm_judge
    model: str | None = Field(default=None, max_length=200)
    messages: list[ScorerMessage] | None = Field(default=None, max_length=SCORER_MESSAGES_MAX)
    # code
    language: ScorerLanguage | None = None
    source: str | None = Field(default=None, max_length=SCORER_SOURCE_MAX)

    @field_validator("scorer_type", "output_type", "language", mode="before")
    @classmethod
    def _degrade_unknown_variant(cls, v: Any, info: ValidationInfo) -> Any:
        allowed = _DISPLAY_ONLY_VARIANTS[str(info.field_name)]
        return v if isinstance(v, str) and v in allowed else None

    @field_validator("metadata", mode="before")
    @classmethod
    def _check_metadata_size(cls, v: Any) -> Any:
        return _check_json_size(v, EVAL_METADATA_MAX, "metadata")


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
    scorers: list[ScorerRef] = Field(default_factory=list, max_length=EVAL_SCORER_LIST_MAX)
    # SDK-supplied idempotency key.
    client_run_id: str | None = Field(default=None, min_length=1, max_length=128)
    baseline_run_id: str | None = Field(default=None, min_length=1, max_length=64)
    case_count: int | None = Field(default=None, ge=0)
    # Free-form run provenance (model, prompt, config, git repo/ref/commit, …).
    metadata: dict[str, Any] | None = None

    @field_validator("metadata", mode="before")
    @classmethod
    def _check_metadata_size(cls, v: Any) -> Any:
        return _check_json_size(v, EVAL_METADATA_MAX, "metadata")


class RegisterRunResponse(BaseModel):
    evaluation_id: str
    evaluation_run_id: str
    run_number: int
    dataset_version_id: str
    # UI-relative path "/projects/<projectId>/evaluations/<runId>". Kept for back-compat;
    # prefer run_url for the printed link.
    run_path: str
    # Absolute clickable run URL — run_path resolved against the control plane's public
    # app origin. Correct regardless of how the API/UI origins are split, so the SDK
    # should print this verbatim rather than joining run_path to its own host_url. The
    # gateway proxies the upstream body verbatim, so this is documentation/parity only.
    run_url: str


# --- (b) Upsert one test-case result with scores ----------------------------


class UpsertResultRequest(BaseModel):
    """Upsert one test-case result. Idempotent on (``run_id``, ``test_case_id``).
    ``trace_id`` may be null now and set on a later call (out-of-order arrival).

    ``scores`` is genuinely optional and carries three distinct meanings, so the
    out-of-order flow (POST the result with its scores, then re-POST later just to
    attach the OTel ``trace_id``) cannot destroy them: absent → leave the existing
    scores untouched, ``[]`` → clear them, non-empty → replace them. Do not give
    this a ``default_factory=list``, which would collapse the first two cases.

    Every optional field is a *partial* update: a key the caller omits keeps its
    stored value, while an explicit null clears it. Sending ``scores`` replaces
    the result's scores (``[]`` clears them); omitting it leaves them alone.
    """

    model_config = ConfigDict(extra="forbid")

    test_case_id: str = Field(min_length=1, max_length=64)
    trace_id: str | None = Field(default=None, min_length=1, max_length=64)
    input: str = Field(max_length=EVAL_PAYLOAD_TEXT_MAX)
    expected_output: str | None = Field(default=None, max_length=EVAL_PAYLOAD_TEXT_MAX)
    candidate_output: str | None = Field(default=None, max_length=EVAL_PAYLOAD_TEXT_MAX)
    baseline_output: str | None = Field(default=None, max_length=EVAL_PAYLOAD_TEXT_MAX)
    status: EvalResultStatus
    main_score: float | None = None
    change: ResultChange | None = None
    task_error: str | None = Field(default=None, max_length=10000)
    duration_ms: int | None = Field(default=None, ge=0)
    cost: float | None = Field(default=None, ge=0)
    # None (absent) and [] (explicit clear) mean different things to the writer, so
    # this deliberately has no default_factory.
    scores: list[ScoreInput] | None = Field(default=None, max_length=EVAL_SCORER_LIST_MAX)


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
