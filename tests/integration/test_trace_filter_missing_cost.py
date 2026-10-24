"""Live check that Cost and Tokens filters agree with what the trace list shows (#2736).

Ingest leaves ``cost`` and ``total_tokens`` NULL on spans that carry none (a tool span, an
LLM span on a model with no price). The list renders such a trace as $0 / 0 tokens, so a
filter on the same numbers has to treat it the same way, and so does a detector trigger,
which mirrors the filter's aggregate, and so does a dashboard widget over the traces view.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from db.clickhouse.client import ClickHouseClient
from rest.schemas.dashboards import WidgetSpec
from rest.services import trace_reader
from rest.services.filters.translate import parse_filters_param
from rest.services.widget_query import compile_widget_query
from worker import detector_tasks

from .conftest import _insert, _span, _trace

pytestmark = pytest.mark.integration

PROJECT = "proj_missing_cost"
# Alone in its month so no other case shares the window.
START = datetime(2026, 3, 10, 10, 0, 0, tzinfo=UTC)


@pytest.fixture(scope="module")
def client(gateway):
    traces, spans = [], []
    for i, (trace_id, kind, tokens, cost) in enumerate(
        (
            ("tool_only", "TOOL", None, None),
            ("unpriced_llm", "LLM", 150, None),
            ("priced", "LLM", 150, 0.002),
        )
    ):
        start = START + timedelta(minutes=i)
        traces.append(_trace(PROJECT, trace_id, start))
        span = _span(PROJECT, f"{trace_id}-s0", trace_id, start, kind=kind)
        span["input_tokens"] = None if tokens is None else 100
        span["output_tokens"] = None if tokens is None else 50
        span["total_tokens"] = tokens
        span["cost"] = cost
        spans.append(span)
    _insert(gateway.admin, "traces", traces)
    _insert(gateway.admin, "spans", spans)
    return ClickHouseClient(gateway.admin)


@pytest.fixture
def reader(client, monkeypatch):
    monkeypatch.setattr(trace_reader, "get_clickhouse_client", lambda: client)
    return trace_reader.TraceReaderService()


def _listed(reader, filters=None):
    result = reader.list_traces(
        PROJECT,
        start_after=START - timedelta(hours=1),
        end_before=START + timedelta(hours=1),
        filters=parse_filters_param(filters) if filters else None,
    )
    ids = {row["trace_id"] for row in result["data"]}
    assert result["meta"]["total"] == len(ids)
    return ids


def test_list_shows_missing_cost_and_tokens_as_zero(reader):
    rows = reader.list_traces(
        PROJECT, start_after=START - timedelta(hours=1), end_before=START + timedelta(hours=1)
    )["data"]
    costs = {row["trace_id"]: row["total_cost"] for row in rows}
    assert costs == {"tool_only": 0.0, "unpriced_llm": 0.0, "priced": 0.002}


@pytest.mark.parametrize(
    ("filters", "expected"),
    [
        ('[{"field":"cost","op":"eq","value":0}]', {"tool_only", "unpriced_llm"}),
        ('[{"field":"cost","op":"lt","value":0.01}]', {"tool_only", "unpriced_llm", "priced"}),
        ('[{"field":"cost","op":"lte","value":0}]', {"tool_only", "unpriced_llm"}),
        ('[{"field":"cost","op":"gt","value":0}]', {"priced"}),
        ('[{"field":"total_tokens","op":"eq","value":0}]', {"tool_only"}),
        (
            '[{"field":"total_tokens","op":"lt","value":1000}]',
            {"tool_only", "unpriced_llm", "priced"},
        ),
        ('[{"field":"total_tokens","op":"gte","value":150}]', {"unpriced_llm", "priced"}),
    ],
)
def test_cost_and_token_filters_match_the_list(reader, filters, expected):
    assert _listed(reader, filters) == expected


@pytest.mark.parametrize(
    ("condition", "expected"),
    [
        ({"field": "cost", "op": "=", "value": 0}, {"tool_only", "unpriced_llm"}),
        ({"field": "cost", "op": "<", "value": 0.01}, {"tool_only", "unpriced_llm", "priced"}),
        ({"field": "total_tokens", "op": "=", "value": 0}, {"tool_only"}),
        (
            {"field": "total_tokens", "op": "<", "value": 1000},
            {"tool_only", "unpriced_llm", "priced"},
        ),
    ],
)
def test_detector_triggers_match_the_filter(client, monkeypatch, condition, expected):
    monkeypatch.setattr("db.clickhouse.client.get_clickhouse_client", lambda: client)
    summaries = detector_tasks._get_trace_summaries(
        PROJECT, ["tool_only", "unpriced_llm", "priced"]
    )
    fired = {t for t, s in summaries.items() if detector_tasks._eval_condition(s, condition)}
    assert fired == expected


def _widget_value(gateway, filters, metric):
    spec = WidgetSpec.model_validate(
        {"view": "traces", "filters": filters, "metric": metric, "display": {"type": "number"}}
    )
    # A day either side: the compiler binds naive UTC datetimes, which the driver reads in
    # the client's local zone, so a tight window would shift by the runner's offset.
    sql, params = compile_widget_query(
        spec,
        project_id=PROJECT,
        start_time=START.replace(tzinfo=None) - timedelta(days=1),
        end_time=START.replace(tzinfo=None) + timedelta(days=1),
    )
    result = gateway.admin.query(sql, parameters=params)
    return result.result_rows[0][result.column_names.index("value")]


@pytest.mark.parametrize(
    ("filters", "expected"),
    [
        ([{"field": "cost", "op": "<", "value": 0.01}], 3),
        ([{"field": "total_tokens", "op": "<", "value": 1}], 1),
    ],
)
def test_widget_traces_view_counts_missing_values_as_zero(client, gateway, filters, expected):
    count = {"measure": "count", "agg": "count"}
    assert _widget_value(gateway, filters, count) == expected


def test_widget_average_cost_per_trace_includes_zero_cost_traces(client, gateway):
    """The list shows three traces at $0, $0 and $0.002, so their average is $0.002 / 3."""
    avg = _widget_value(gateway, [], {"measure": "cost", "agg": "avg"})
    assert avg == pytest.approx(0.002 / 3)
