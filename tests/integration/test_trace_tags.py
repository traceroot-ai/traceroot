"""Live round trip for trace tags (#1748): OTLP in, tags out, on a real ClickHouse.

Spans go through the real ingest task (``process_s3_traces``: transform, then the real
insert column list) against migrations 001 onward as written, including 018. Only S3,
the detector enqueue and the Redis live stream are stubbed. They are read back through
the same reader and discovery services the list, detail and filter-value endpoints call.
"""

from __future__ import annotations

import json
import time
from datetime import UTC, datetime

import pytest

from db.clickhouse.client import ClickHouseClient
from rest.services.filters.translate import Predicate
from tests.fixtures.otel_payloads import make_otel_payload, make_span

pytestmark = pytest.mark.integration

PROJECT = "proj_tags"
# Alone in its month: no other seeded case writes January 2024.
START_NS = 1705320000000000000  # 2024-01-15 12:00:00 UTC
WINDOW = {
    "start_after": datetime(2024, 1, 1, tzinfo=UTC),
    "end_before": datetime(2024, 2, 1, tzinfo=UTC),
}

TRACE_A = "a1" * 16  # root tagged by @observe, child by update_current_trace + OpenInference
TRACE_B = "b1" * 16  # traceroot-ts: a JSON-string array
TRACE_C = "c1" * 16  # untagged
TRACE_D = "d1" * 16  # re-exported with different tags; only the latest version counts


def _array(key, values):
    return {"key": key, "value": {"arrayValue": {"values": [{"stringValue": v} for v in values]}}}


def _string(key, value):
    return {"key": key, "value": {"stringValue": value}}


def _span(trace, span, offset_s, parent=None, attributes=None):
    start = START_NS + offset_s * 1_000_000_000
    return make_span(
        trace,
        span,
        name=f"{span[:4]}",
        parent_span_id_hex=parent,
        start_nanos=start,
        end_nanos=start + 500_000_000,
        attributes=attributes or [],
    )


def _ingest(monkeypatch, admin, spans):
    from worker import ingest_tasks

    payload = make_otel_payload(spans)

    class _S3:
        def download_json(self, key):
            return payload

    monkeypatch.setattr("rest.services.s3.get_s3_service", lambda: _S3())
    monkeypatch.setattr(
        "db.clickhouse.client.get_clickhouse_client", lambda: ClickHouseClient(admin)
    )
    monkeypatch.setattr("worker.detector_tasks.enqueue_detector_runs", lambda *a, **k: None)
    monkeypatch.setattr(ingest_tasks, "_publish_live_spans", lambda *a, **k: None)
    ingest_tasks.process_s3_traces.run("tags/test.json", PROJECT)


@pytest.fixture(scope="module")
def services(gateway):
    from rest.services.trace_discovery import TraceDiscoveryService
    from rest.services.trace_reader import TraceReaderService

    with pytest.MonkeyPatch.context() as mp:
        _ingest(
            mp,
            gateway.admin,
            [
                _span(TRACE_A, "a2" * 8, 0, attributes=[_array("traceroot.span.tags", ["prod"])]),
                _span(
                    TRACE_A,
                    "a3" * 8,
                    1,
                    parent="a2" * 8,
                    attributes=[
                        _array("traceroot.trace.tags", ["v2", "prod"]),
                        _string("tag.tags", json.dumps(["beta"])),
                    ],
                ),
                _span(
                    TRACE_B,
                    "b2" * 8,
                    2,
                    attributes=[_string("traceroot.span.tags", json.dumps(["staging"]))],
                ),
                _span(TRACE_C, "c2" * 8, 3),
                _span(TRACE_D, "d2" * 8, 4, attributes=[_array("traceroot.span.tags", ["old"])]),
            ],
        )
        # The same span exported again with new tags: a newer ch_update_time version.
        # The pause keeps the two versions' millisecond timestamps apart.
        time.sleep(0.05)
        _ingest(
            mp,
            gateway.admin,
            [_span(TRACE_D, "d2" * 8, 4, attributes=[_array("traceroot.span.tags", ["new"])])],
        )

        client = ClickHouseClient(gateway.admin)
        mp.setattr("rest.services.trace_reader.get_clickhouse_client", lambda: client)
        mp.setattr("rest.services.trace_discovery.get_clickhouse_client", lambda: client)
        reader = TraceReaderService()
        discovery = TraceDiscoveryService()
    return reader, discovery


def _tags_by_trace(result):
    return {row["trace_id"]: row["tags"] for row in result["data"]}


def _list(reader, filters=None):
    return reader.list_traces(project_id=PROJECT, filters=filters, **WINDOW)


def test_stored_column_holds_each_spans_own_tags(services, gateway):
    rows = gateway.admin.query(
        "SELECT span_id, tags FROM spans WHERE project_id = {p:String} "
        "ORDER BY ch_update_time DESC LIMIT 1 BY span_id",
        parameters={"p": PROJECT},
    ).result_rows
    stored = {span_id: list(tags) for span_id, tags in rows}

    assert stored == {
        "a2" * 8: ["prod"],
        "a3" * 8: ["v2", "prod", "beta"],
        "b2" * 8: ["staging"],
        "c2" * 8: [],
        "d2" * 8: ["new"],
    }


def test_list_returns_the_union_over_each_traces_spans(services):
    reader, _ = services

    assert _tags_by_trace(_list(reader)) == {
        TRACE_A: ["beta", "prod", "v2"],
        TRACE_B: ["staging"],
        TRACE_C: [],
        TRACE_D: ["new"],
    }


def test_detail_returns_span_tags_and_the_trace_union(services):
    reader, _ = services

    trace = reader.get_trace(PROJECT, TRACE_A)

    assert trace["tags"] == ["beta", "prod", "v2"]
    assert {s["span_id"]: s["tags"] for s in trace["spans"]} == {
        "a2" * 8: ["prod"],
        "a3" * 8: ["v2", "prod", "beta"],
    }


@pytest.mark.parametrize(
    ("filters", "expected"),
    [
        ([["v2"]], {TRACE_A}),
        # One predicate, several values: any of them.
        ([["staging", "beta"]], {TRACE_A, TRACE_B}),
        # Two predicates: the trace must carry both (on any of its spans).
        ([["prod"], ["beta"]], {TRACE_A}),
        ([["prod"], ["staging"]], set()),
        # A superseded span version's tag no longer matches.
        ([["old"]], set()),
        ([["new"]], {TRACE_D}),
    ],
    ids=["one_tag", "any_of", "all_of_two", "disjoint", "stale_version", "latest_version"],
)
def test_the_tags_filter_narrows_the_page_and_the_count(services, filters, expected):
    reader, _ = services
    predicates = [Predicate(field="tags", op="in", value=values) for values in filters]

    result = _list(reader, predicates)

    assert set(_tags_by_trace(result)) == expected
    assert result["meta"]["total"] == len(expected)


@pytest.mark.parametrize("which", ["reader", "discovery"])
def test_filter_values_offer_single_tags_by_frequency(services, which):
    reader, discovery = services
    service = reader if which == "reader" else discovery

    values = service.get_distinct_span_values(project_id=PROJECT, column="tags", **WINDOW)

    counts = {v["value"]: v["count"] for v in values}
    assert counts == {"prod": 2, "v2": 1, "beta": 1, "staging": 1, "new": 1}
    assert values[0] == {"value": "prod", "count": 2}
