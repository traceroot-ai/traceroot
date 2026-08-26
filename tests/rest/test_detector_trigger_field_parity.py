"""Drift tests between the detector trigger-field registry and the evaluator.

A detector's Filter section offers seven fields. The list of them lives in
TypeScript (``trigger-fields.ts`` — the trigger editor renders from it and both
detector routes validate against it), while the code that answers a condition
lives in Python (``worker.detector_tasks``). Neither side can import the other,
and a field offered on one side but not fetched by the other fails silently:
the evaluator reads ``trace_summary.get(field)``, and a missing field answers
True only for ``!=`` and False for everything else — a detector that is
configured, enabled, and never fires.

Grain is asserted against the trace-list filter registry
(``rest.services.filters.columns``) rather than restated here, because a
detector filter has to answer the same question the trace list's filter
answers; divergence between the two would be its own bug.

Every parse below asserts what it found. A regex that silently matches nothing
would make its assertion vacuous, which reads as coverage while protecting
nothing.
"""

import re
from datetime import datetime
from decimal import Decimal
from pathlib import Path

import pytest

from rest.services.filters.columns import FILTER_COLUMNS, FILTER_COLUMNS_BY_NAME, FilterLevel
from worker.detector_tasks import _get_trace_summaries

_REPO_ROOT = Path(__file__).resolve().parents[2]

TRIGGER_FIELDS_TS = (
    _REPO_ROOT / "frontend" / "ui" / "src" / "features" / "detectors" / "trigger-fields.ts"
)

requires_frontend = pytest.mark.skipif(
    not TRIGGER_FIELDS_TS.exists(),
    reason="frontend sources not present in this checkout",
)

_FIELD_ENTRY_RE = re.compile(r"field:\s*\"(\w+)\"\s*,\s*label:\s*\"([^\"]+)\"")


def _parse_offered_fields() -> list[tuple[str, str]]:
    """The (field, label) pairs the UI offers, in render order.

    Raises ValueError when the declaration is gone, which is the loud failure a
    renamed or moved registry deserves: a soft "no match" would leave every
    assertion downstream comparing two empty collections.
    """
    source = TRIGGER_FIELDS_TS.read_text()
    start = source.index("export const TRIGGER_FIELD_DEFS")
    end = source.index("\n];", start)
    return [(m[1], m[2]) for m in _FIELD_ENTRY_RE.finditer(source[start:end])]


class _FakeResult:
    def __init__(self, rows: list[tuple]) -> None:
        self.result_rows = rows


class _RecordingClickHouse:
    """Answers the two queries ``_get_trace_summaries`` issues and keeps the SQL."""

    def __init__(self, span_rows: list[tuple], trace_rows: list[tuple]) -> None:
        self._span_rows = span_rows
        self._trace_rows = trace_rows
        self.queries: list[str] = []

    def query(self, sql: str, parameters: dict | None = None) -> _FakeResult:
        self.queries.append(sql)
        return _FakeResult(self._trace_rows if "FROM traces" in sql else self._span_rows)


# One row per query, every column a distinguishable value, so a summary built
# from the wrong column index is visible rather than plausible.
_SPAN_ROW = (
    "trace-1",
    ["prod", "staging"],
    ["gpt-4"],
    Decimal("0.25"),
    1200,
    4500,
    2,
    [{"tier": "gold"}],
    datetime(2026, 8, 1, 12, 0),
)
_TRACE_ROW = ("trace-1", {"tenant": "acme"})


def _fetch(monkeypatch) -> tuple[dict, _RecordingClickHouse]:
    import db.clickhouse.client as ch_mod

    fake = _RecordingClickHouse([_SPAN_ROW], [_TRACE_ROW])
    monkeypatch.setattr(ch_mod, "get_clickhouse_client", lambda: fake)
    return _get_trace_summaries("proj-1", ["trace-1"]), fake


def _spans_query(fake: _RecordingClickHouse) -> str:
    spans_queries = [q for q in fake.queries if "FROM spans" in q]
    assert len(spans_queries) == 1, "the span-scope fetch is no longer a single query"
    return spans_queries[0]


# --- Which fields exist on both sides ---


@requires_frontend
def test_every_offered_field_is_fetched_by_the_evaluator(monkeypatch):
    """The defect this feature was built to avoid: a field the UI offers but the
    fetch never selects is not a degraded filter, it is a detector that never
    fires (or, on ``!=``, one that fires on everything)."""
    summary = _fetch(monkeypatch)[0]["trace-1"]
    missing = [field for field, _ in _parse_offered_fields() if field not in summary]
    assert missing == [], (
        f"trigger-fields.ts offers {missing}, which _get_trace_summaries does not fetch; "
        "conditions on those fields would silently never match"
    )


@requires_frontend
def test_the_offered_field_registry_was_actually_parsed():
    """A regex that silently matched nothing would make the parity check above
    vacuous, so the shape of the parse is asserted rather than assumed."""
    offered = _parse_offered_fields()
    assert len(offered) == 7
    assert offered[0] == ("model_name", "Model")


@requires_frontend
def test_the_offered_fields_are_the_trace_list_fields_without_trace_id():
    """Detectors filter at the trace list's vocabulary minus Trace ID: a single
    known trace id is not a meaningful trigger for a detector that watches live
    traces. Order is compared too, because it is the field dropdown's order on
    both surfaces."""
    # Minus the columns the registry marks as list-only: the evaluator does not
    # fetch them, so offering them would be a trigger that never fires.
    trace_list = [
        (c.name, c.label) for c in FILTER_COLUMNS if c.name != "trace_id" and c.detector_trigger
    ]
    assert _parse_offered_fields() == trace_list
    assert [c.name for c in FILTER_COLUMNS if not c.detector_trigger] == [
        "span_kind",
        "status",
        "name",
    ]
    assert "trace_id" not in [field for field, _ in _parse_offered_fields()]
    # Guards the exclusion above against becoming vacuous if the trace list
    # itself ever drops the field.
    assert "trace_id" in FILTER_COLUMNS_BY_NAME


# --- What each field is worth ---


def test_the_fetch_maps_each_column_onto_the_field_the_evaluator_reads(monkeypatch):
    """Pins the whole summary, not just its keys: a column added or reordered in
    the SELECT shifts every field after it onto the wrong value, which reads as
    a working detector filtering on someone else's number."""
    summaries = _fetch(monkeypatch)[0]
    assert summaries == {
        "trace-1": {
            "environment": ["prod", "staging"],
            "model_name": ["gpt-4"],
            "cost": Decimal("0.25"),
            "total_tokens": 1200,
            "duration_ms": 4500,
            "errors": 2,
            # Trace scope and span scope merged into one key space.
            "metadata": {"tenant": ["acme"], "tier": ["gold"]},
        }
    }


def test_numeric_fields_are_fetched_at_the_trace_lists_aggregate_grain(monkeypatch):
    """Latency is the trace's wall clock (max end minus min start), not a sum of
    span durations, and errors is an ERROR-span count — both derived, neither a
    stored column. Read from the trace-list registry so the two cannot drift."""
    spans_sql = _spans_query(_fetch(monkeypatch)[1])
    aggregates = {
        c.name: c.aggregate_expr
        for c in FILTER_COLUMNS
        if c.level is FilterLevel.SPAN_AGGREGATE and c.aggregate_expr
    }
    assert set(aggregates) == {"cost", "total_tokens", "duration_ms", "errors"}
    for name, expr in aggregates.items():
        assert expr in spans_sql, (
            f"the detector fetch computes '{name}' differently from the trace list, "
            f"which expects {expr}"
        )


def test_model_and_environment_are_fetched_as_span_membership_sets(monkeypatch):
    """Membership, not the root span's value: the trace list answers "some span
    carries this", so a detector on a mixed trace must answer the same."""
    spans_sql = _spans_query(_fetch(monkeypatch)[1])
    membership = [
        c.name
        for c in FILTER_COLUMNS
        if c.level is FilterLevel.SPAN_MEMBERSHIP and c.detector_trigger
    ]
    assert membership == ["model_name", "environment"]
    for name in membership:
        assert f"groupUniqArray({name})" in spans_sql


def test_metadata_is_fetched_from_both_trace_and_span_scope(monkeypatch):
    """The SDK may attach metadata at either scope and the two key spaces are
    disjoint, so reading only spans would drop every trace-level key — the same
    OR the trace list's keyed-map filter lowers to."""
    fake = _fetch(monkeypatch)[1]
    assert "groupArray(metadata_map)" in _spans_query(fake)
    trace_scope = [q for q in fake.queries if "FROM traces" in q]
    assert len(trace_scope) == 1 and "metadata_map" in trace_scope[0]
