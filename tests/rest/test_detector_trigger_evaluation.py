"""How a detector trigger condition answers, per field, and the summary shapes
the fetch hands the evaluator to answer against.
"""

from datetime import datetime, timedelta
from decimal import Decimal

import worker.detector_tasks as detector_tasks
from worker.detector_tasks import (
    _claim_and_enqueue,
    _eval_condition,
    _get_trace_summaries,
    _merge_metadata_values,
    _passes_trigger,
)


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
        {"field": "environment", "op": "matches", "value": "prod"},
        {"field": ["environment"], "op": "=", "value": "prod"},
        "environment=prod",
        None,
    ]
    for condition in malformed:
        assert _passes_trigger(UNIFORM, [condition]) is False, (
            f"condition {condition!r} did not evaluate False"
        )


def test_a_value_the_field_cannot_be_compared_to_evaluates_false():
    """The same guarantee on the numeric path, which only a summary that carries
    the field reaches — against one that does not, every condition here would stop
    at the missing-field branch and never touch a comparison. `10**400` is the
    OverflowError case: JSON has no bound on an integer literal, so a stored value
    can be outside float range, and it must answer like the other two rather than
    raise past equality as well as ordering."""
    carrying_cost = {**UNIFORM, "cost": Decimal("0.25")}
    uncomparable = [
        {"field": "cost", "op": ">", "value": "not a number"},
        {"field": "cost", "op": ">", "value": None},
        {"field": "cost", "op": ">", "value": 10**400},
        {"field": "cost", "op": "=", "value": 10**400},
        {"field": "cost", "op": "matches", "value": 0.25},
    ]
    for condition in uncomparable:
        assert _passes_trigger(carrying_cost, [condition]) is False, (
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


# --- Merging the two metadata scopes ---


def test_a_key_set_at_both_scopes_carries_each_distinct_value_once():
    """One key space over both scopes is what lets a condition name a key without
    naming the scope that set it. Values are a set in meaning but a list in shape,
    so the same value reaching the merge from both scopes must not double."""
    merged = _merge_metadata_values(
        {"tenant": "acme", "region": "us-east"},
        [{"tenant": "acme", "tier": "gold"}, {"tier": "silver"}],
    )
    assert merged == {
        "tenant": ["acme"],
        "region": ["us-east"],
        "tier": ["gold", "silver"],
    }


def test_a_trace_with_no_trace_scope_row_merges_its_span_scope_keys_anyway():
    """The trace-scope read is skipped entirely for most batches and can miss a
    trace even when it runs, so span-scope keys have to answer on their own."""
    assert _merge_metadata_values(None, [{"tier": "gold"}]) == {"tier": ["gold"]}


# --- Fetching the summary ---


class _FakeQueryResult:
    def __init__(self, rows: list) -> None:
        self.result_rows = rows


class _RecordingClickHouse:
    """Answers queries in the order they were queued and keeps what was bound."""

    def __init__(self, *results: list) -> None:
        self._results = list(results)
        self.calls: list[tuple[str, dict]] = []

    def query(self, query: str, parameters: dict | None = None, settings: dict | None = None):
        self.calls.append((query, parameters or {}))
        return _FakeQueryResult(self._results.pop(0))


# One span aggregate row, in the column order the SELECT lists.
def _span_row(trace_id: str, span_start, metadata_maps: list[dict]) -> list:
    return [
        trace_id,
        ["prod", "staging"],
        ["gpt-4"],
        Decimal("0.25"),
        1200,
        4500,
        2,
        metadata_maps,
        span_start,
    ]


def _fake_clickhouse(monkeypatch, *results: list) -> _RecordingClickHouse:
    import db.clickhouse.client as clickhouse_client

    ch = _RecordingClickHouse(*results)
    monkeypatch.setattr(clickhouse_client, "get_clickhouse_client", lambda: ch)
    return ch


def test_the_summary_names_every_field_a_trigger_can_be_built_on(monkeypatch):
    """The aggregate comes back positionally, so a column added to the SELECT
    without moving the reads below it silently shifts every later field onto its
    neighbour's value."""
    ch = _fake_clickhouse(
        monkeypatch,
        [_span_row("t1", datetime(2026, 8, 1, 12, 0), [{"tier": "gold"}])],
        [["t1", {"tenant": "acme"}]],
    )

    summaries = _get_trace_summaries("proj-1", ["t1"])

    assert summaries == {
        "t1": {
            "environment": ["prod", "staging"],
            "model_name": ["gpt-4"],
            "cost": Decimal("0.25"),
            "total_tokens": 1200,
            "duration_ms": 4500,
            "errors": 2,
            "metadata": {"tenant": ["acme"], "tier": ["gold"]},
        }
    }
    assert ch.calls[1][1]["trace_ids"] == ["t1"]


def test_the_trace_scope_read_is_bounded_by_the_data_not_the_clock(monkeypatch):
    """`traces` sorts trace_id behind the date, so the read needs a lower bound to
    prune anything — but a wall-clock one drops the trace-scope keys of every trace
    a backfill or a replay carries, which is all of them. Each traces row copies its
    trace_start_time from one of the trace's spans, so the batch's earliest span
    start prunes without ever excluding a row the batch needs."""
    long_ago = datetime.now() - timedelta(days=90)
    ch = _fake_clickhouse(
        monkeypatch,
        [
            _span_row("t1", long_ago + timedelta(minutes=5), [{}]),
            _span_row("t2", long_ago, [{}]),
        ],
        [["t1", {"tenant": "acme"}]],
    )

    summaries = _get_trace_summaries("proj-1", ["t1", "t2"])

    traces_sql, traces_params = ch.calls[1]
    assert traces_params["first_span_start"] == long_ago
    assert "now()" not in traces_sql
    assert summaries["t1"]["metadata"] == {"tenant": ["acme"]}


def test_no_metadata_condition_means_the_traces_table_is_never_read(monkeypatch):
    """The gate exists to keep a second table off the ingest path for the detectors
    that do not need it, which is most of them."""
    ch = _fake_clickhouse(
        monkeypatch,
        [_span_row("t1", datetime(2026, 8, 1, 12, 0), [{"tier": "gold"}])],
    )

    summaries = _get_trace_summaries("proj-1", ["t1"], include_trace_metadata=False)

    assert len(ch.calls) == 1
    assert summaries["t1"]["metadata"] == {"tier": ["gold"]}
