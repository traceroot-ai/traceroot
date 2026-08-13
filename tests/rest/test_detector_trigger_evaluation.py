"""How a detector trigger condition answers, per field.

The seven offered fields are fetched at the trace list's grain (see
``test_detector_trigger_field_parity``); this file pins what the evaluator then
does with each shape it gets back — the multi-valued membership fields, the
keyed metadata map, the Decimal cost — and the two behaviour changes that came
with them: environment stopped meaning "the root span's value" and a malformed
condition stopped raising.
"""

from decimal import Decimal

import worker.detector_tasks as detector_tasks
from worker.detector_tasks import _claim_and_enqueue, _eval_condition, _passes_trigger


class _FakeRedis:
    """The NX claim and the sticky-state writes, with no server."""

    def __init__(self) -> None:
        self.store: dict[str, str] = {}

    def set(self, key: str, value: str, nx: bool = False, ex: int | None = None):
        if nx and key in self.store:
            return None
        self.store[key] = value
        return True

    def eval(self, script: str, numkeys: int, key: str, expected: str) -> int:
        if self.store.get(key) == expected:
            del self.store[key]
            return 1
        return 0


# A trace whose spans disagree about environment — the case that separates
# membership from the old root-span reading.
MIXED = {"environment": ["prod", "staging"], "model_name": ["gpt-4", "gpt-4o-mini"]}
UNIFORM = {"environment": ["prod"], "model_name": ["gpt-4"]}


# --- Span membership: model and environment ---


def test_environment_matches_when_any_span_carries_it():
    """Membership, not the root span's value: the trace list's Environment filter
    answers "the trace has a span in prod", so a detector on the same trace must."""
    assert _eval_condition(MIXED, {"field": "environment", "op": "=", "value": "prod"}) is True
    assert _eval_condition(MIXED, {"field": "environment", "op": "=", "value": "dev"}) is False


def test_environment_is_not_equal_only_when_no_span_carries_it():
    """The half of the semantics change a uniform trace cannot show: a trace with
    one staging span is no longer "not prod" just because its root span was
    staging. Reading != as "the root span differs" would fire this detector on a
    trace that did run in prod."""
    assert _eval_condition(MIXED, {"field": "environment", "op": "!=", "value": "prod"}) is False
    assert _eval_condition(MIXED, {"field": "environment", "op": "!=", "value": "dev"}) is True


def test_a_uniform_environment_trace_answers_as_it_did_before_the_change():
    """The compatibility half: every trace whose spans agree keeps the answer the
    root-span reading gave, so existing detectors are untouched by the change."""
    assert _eval_condition(UNIFORM, {"field": "environment", "op": "=", "value": "prod"}) is True
    assert _eval_condition(UNIFORM, {"field": "environment", "op": "!=", "value": "prod"}) is False
    assert _eval_condition(UNIFORM, {"field": "environment", "op": "!=", "value": "dev"}) is True


def test_model_matches_any_model_the_trace_used():
    """Model is membership for the same reason: one trace routinely spans several
    models, and only the root span's model would hide the rest."""
    assert (
        _eval_condition(MIXED, {"field": "model_name", "op": "=", "value": "gpt-4o-mini"}) is True
    )
    assert _eval_condition(MIXED, {"field": "model_name", "op": "!=", "value": "gpt-4"}) is False


# --- Keyed metadata ---


def test_metadata_matches_a_key_carried_at_either_scope():
    """Trace-scope and span-scope keys are merged into one key space, so a user
    filtering on a tag they can see need not know which scope set it."""
    summary = {"metadata": {"tenant": ["acme"], "tier": ["gold"]}}
    assert (
        _eval_condition(summary, {"field": "metadata", "key": "tenant", "op": "=", "value": "acme"})
        is True
    )
    assert (
        _eval_condition(summary, {"field": "metadata", "key": "tier", "op": "=", "value": "gold"})
        is True
    )


def test_metadata_contains_is_case_insensitive_and_false_for_an_unknown_key():
    """``contains`` lowers to ILIKE on the trace list; matching case-sensitively
    here would answer differently from the list the user built the filter in.
    A key nothing carries simply matches nothing."""
    summary = {"metadata": {"tenant": ["Acme Corp"]}}
    condition = {"field": "metadata", "key": "tenant", "op": "contains", "value": "acme"}
    assert _eval_condition(summary, condition) is True
    assert _eval_condition(summary, {**condition, "key": "unset"}) is False


# --- Numeric fields ---


def test_a_decimal_cost_compares_against_the_number_the_form_stored():
    """Cost comes back from ClickHouse as a Decimal while the condition holds a
    JSON number, so an uncoerced comparison would make an equality on cost
    permanently false and an ordering raise."""
    summary = {"cost": Decimal("0.25"), "total_tokens": 1200, "duration_ms": 4500, "errors": 2}
    assert _eval_condition(summary, {"field": "cost", "op": "=", "value": 0.25}) is True
    assert _eval_condition(summary, {"field": "cost", "op": ">", "value": 0.1}) is True
    assert _eval_condition(summary, {"field": "duration_ms", "op": ">=", "value": 4500}) is True
    assert _eval_condition(summary, {"field": "errors", "op": "<", "value": 2}) is False


# --- Malformed conditions ---


def test_a_malformed_condition_evaluates_false_instead_of_raising():
    """Conditions are read straight out of Postgres, and rows written before the
    registry validation existed can hold any JSON the old array-only check let
    through. A raise here does not disable one condition, it drops the whole
    trace's detector evaluation (see the test below)."""
    malformed = [
        {"field": "cost", "op": ">", "value": "not a number"},
        {"field": "cost", "op": ">", "value": None},
        {"field": "environment", "op": "matches", "value": "prod"},
        {"field": ["environment"], "op": "=", "value": "prod"},
        "environment=prod",
        None,
    ]
    for condition in malformed:
        assert _passes_trigger(UNIFORM, [condition]) is False, (
            f"condition {condition!r} did not evaluate False"
        )


def test_one_detectors_malformed_condition_does_not_cost_another_detector(monkeypatch):
    """The reason the evaluator must not raise: every detector for a trace is
    evaluated inside one claim, so a single bad condition on a detector nobody is
    looking at takes every other detector's finding for that trace with it."""
    enqueued: list[dict] = []
    monkeypatch.setattr(
        detector_tasks, "_add_bullmq_job", lambda job_id, data: enqueued.append(data)
    )

    detectors = [
        {"id": "legacy", "sample_rate": 100, "conditions": [None]},
        {
            "id": "healthy",
            "sample_rate": 100,
            "conditions": [{"field": "environment", "op": "=", "value": "prod"}],
        },
    ]
    _claim_and_enqueue(_FakeRedis(), "proj-1", "trace-1", detectors, UNIFORM)

    assert enqueued == [{"traceId": "trace-1", "detectorIds": ["healthy"], "projectId": "proj-1"}]
