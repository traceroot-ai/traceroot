"""Typed request/response models for the public offline-evaluation reporting API.

These mirror the finalized Next.js/Zod contract in
``frontend/packages/core/src/eval-contract.ts`` field-for-field, so the gateway
can (a) validate SDK payloads before forwarding and (b) publish a useful,
codegen-friendly OpenAPI schema. Persistence stays in the Prisma-owned Next.js
handlers — the gateway forwards the (validated) body on and never duplicates it.

Parity rules with the Zod source:
- ``z.string().min(1).max(n)`` → ``Field(min_length=1, max_length=n)``.
- ``z.number().int().nonnegative()`` → ``JsonNonNegativeInt``; ``z.number()`` →
  ``JsonFloat``; ``z.boolean()`` → ``JsonBool`` (see the JSON-strict scalars below —
  plain ``int``/``float``/``bool`` would coerce where Zod does not).
- ``.nullable().optional()`` → ``T | None = None``; ``.default(x)`` → default ``x``.
- ``z.array(X).max(n)`` → ``list[X]`` with ``max_length=n``.
- A display-only enum with ``.catch(null)`` → ``Literal[...] | None`` plus a
  ``mode="before"`` validator that degrades an unrecognised value to ``None``.

Unknown keys: the Zod request schemas are ``.strict()``, but these models are
deliberately NOT ``extra="forbid"``. They run in the *gateway*, which is contracted
to forward bodies verbatim to the Prisma-owned Next.js handler that actually
persists — and FastAPI validates the request model before the handler body runs, so
a forbid here would 422 a field the gateway does not yet model and it would never
reach persistence at all. That also breaks rolling deploys: a newer SDK's optional
field would be rejected by every gateway instance older than it, while the Next.js
handler it is talking to would have accepted it. Strictness stays on the Zod side,
where the authoritative writer lives; the caps, vocabularies and shapes below are
still enforced here so a malformed payload never reaches the control plane.

A cross-language drift test (``tests/rest/test_eval_contract_parity.py`` +
``eval-contract-parity.drift.test.ts``) feeds the same representative payloads to
both layers and asserts identical accept/reject verdicts, and compares every model
here against the shared structural roster (``eval-contract-shape.json``) so that a
field added or re-bounded on one layer only fails without needing a fixture for it.
"""

import json
from typing import Annotated, Any, Literal, get_args

from pydantic import BaseModel, BeforeValidator, Field, ValidationInfo, field_validator

# --- JSON-strict scalars ----------------------------------------------------
#
# Pydantic's default (lax) mode coerces across JSON types — ``"0.5"`` validates as
# a float, ``"3"`` and ``true`` as an int, ``"yes"`` and ``1`` as a bool. Zod's
# ``z.number()`` / ``z.boolean()`` do none of that. Left alone, the gateway would
# ACCEPT a body the control plane then 400s on, which is the exact two-hop failure
# this contract pairing exists to prevent (the gateway forwards the raw, un-normalized
# bytes upstream, so its coercion never even reaches the writer).
#
# Blanket ``ConfigDict(strict=True)`` is the wrong tool: it also rejects ``24.0`` on
# an int field, which Zod's ``z.number().int()`` accepts — JSON has no int/float
# distinction, so ``24.0`` and ``24`` are the same wire value. These per-field types
# reject only the cross-type coercions, keeping the integral-float case valid.


def _json_number(v: Any) -> Any:
    """Reject the values ``z.number()`` rejects: JSON strings and booleans."""
    if isinstance(v, (bool, str)):
        raise ValueError("must be a JSON number (a string or boolean is not coerced)")
    return v


def _json_int(v: Any) -> Any:
    """As ``_json_number``, but also accept an integral float (``24.0`` == ``24`` on the wire)."""
    if isinstance(v, (bool, str)):
        raise ValueError("must be a JSON number (a string or boolean is not coerced)")
    if isinstance(v, float) and v.is_integer():
        return int(v)
    return v


def _json_bool(v: Any) -> Any:
    """Reject the values ``z.boolean()`` rejects: everything that is not a JSON boolean."""
    if not isinstance(v, bool):
        raise ValueError("must be a JSON boolean (a string or number is not coerced)")
    return v


#: ``z.number()`` — a JSON number, never a coerced string/boolean.
JsonFloat = Annotated[float, BeforeValidator(_json_number)]
#: ``z.boolean()`` — a JSON boolean, never a coerced string/number.
JsonBool = Annotated[bool, BeforeValidator(_json_bool)]
#: ``Number.MAX_SAFE_INTEGER``. Zod's ``z.number().int()`` is ``Number.isSafeInteger``,
#: so the control plane rejects anything past this — an unbounded ``int`` here would
#: accept a count the control plane then 400s on. Python has no such ceiling of its own.
JSON_SAFE_INT_MAX = 9_007_199_254_740_991
# The bounds must precede the validator in the Annotated chain: applied after it,
# pydantic cannot fold `ge`/`le` into the integer/number core schema and publishes raw
# `"ge": 0` keywords instead of JSON Schema's `"minimum": 0`.
#: ``z.number().int().nonnegative()``.
JsonNonNegativeInt = Annotated[int, Field(ge=0, le=JSON_SAFE_INT_MAX), BeforeValidator(_json_int)]
#: ``z.number().nonnegative()``.
JsonNonNegativeFloat = Annotated[float, Field(ge=0), BeforeValidator(_json_number)]

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
    threshold: JsonFloat | None = None
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

    scorer_name: str = Field(min_length=1, max_length=200)
    scorer_version: str = Field(min_length=1, max_length=50)
    numeric_value: JsonFloat | None = None
    bool_value: JsonBool | None = None
    string_value: str | None = Field(default=None, max_length=2000)
    passed: JsonBool | None = None
    explanation: str | None = Field(default=None, max_length=5000)
    error: str | None = Field(default=None, max_length=5000)


# --- (a) Register / start a run ---------------------------------------------


class RunProvenance(BaseModel):
    """Typed execution provenance (git/CI/SDK identity + declared candidate
    model/prompt). Mirrors ``RunProvenanceSchema`` on the Zod side. Every field is
    optional and reported by the SDK from what it can actually observe; unknown
    values are absent/null and never inferred. Distinct from free-form ``metadata``
    and never a substitute for the user-facing ``candidate_version`` label.
    """

    git_repository: str | None = Field(default=None, max_length=500)
    git_ref: str | None = Field(default=None, max_length=500)
    git_commit: str | None = Field(default=None, max_length=200)
    git_dirty: bool | None = None
    ci_provider: str | None = Field(default=None, max_length=100)
    ci_build_id: str | None = Field(default=None, max_length=200)
    sdk_language: str | None = Field(default=None, max_length=50)
    sdk_version: str | None = Field(default=None, max_length=50)
    # Declared candidate identity — surfaced only if the SDK reports it, never
    # inferred from candidate_version or any label.
    declared_model: str | None = Field(default=None, max_length=200)
    declared_prompt_version: str | None = Field(default=None, max_length=200)


class RegisterRunRequest(BaseModel):
    """Register/start a run. Idempotent on ``client_run_id`` within an evaluation."""

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
    case_count: JsonNonNegativeInt | None = None
    # Typed execution provenance (git/CI/SDK identity, declared candidate model/prompt).
    provenance: RunProvenance | None = None
    # Free-form run metadata — arbitrary user key/values, kept verbatim.
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

    test_case_id: str = Field(min_length=1, max_length=64)
    trace_id: str | None = Field(default=None, min_length=1, max_length=64)
    input: str = Field(max_length=EVAL_PAYLOAD_TEXT_MAX)
    expected_output: str | None = Field(default=None, max_length=EVAL_PAYLOAD_TEXT_MAX)
    candidate_output: str | None = Field(default=None, max_length=EVAL_PAYLOAD_TEXT_MAX)
    baseline_output: str | None = Field(default=None, max_length=EVAL_PAYLOAD_TEXT_MAX)
    status: EvalResultStatus
    main_score: JsonFloat | None = None
    change: ResultChange | None = None
    task_error: str | None = Field(default=None, max_length=10000)
    duration_ms: JsonNonNegativeInt | None = None
    cost: JsonNonNegativeFloat | None = None
    # None (absent) and [] (explicit clear) mean different things to the writer, so
    # this deliberately has no default_factory. The annotation is NOT ``| None``: the
    # Zod field is ``.optional()`` and not ``.nullable()``, so an explicit
    # ``"scores": null`` is a 400 upstream and must not be accepted (and forwarded)
    # here. Absence is carried by the default, which pydantic never validates, so the
    # attribute is still ``None`` when the key was omitted.
    scores: list[ScoreInput] = Field(default=None, max_length=EVAL_SCORER_LIST_MAX)


class UpsertResultResponse(BaseModel):
    evaluation_result_id: str


# --- (c) Complete / finalize a run ------------------------------------------


class CompleteRunRequest(BaseModel):
    """Complete/fail a run, reporting final completeness counts."""

    status: EvalRunStatus
    main_score: JsonFloat | None = None
    case_count: JsonNonNegativeInt | None = None
    scored_count: JsonNonNegativeInt | None = None
    task_error_count: JsonNonNegativeInt | None = None
    scorer_error_count: JsonNonNegativeInt | None = None


class CompleteRunResponse(BaseModel):
    evaluation_run_id: str
    # Echoes the persisted run status.
    status: EvalRunStatus
