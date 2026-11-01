"""Span and trace rows are versioned by when the API received their batch.

``ch_update_time`` is the ReplacingMergeTree version. These tests run the real
ingest task and the real row building over a fake driver that keeps every
inserted row, then apply what FINAL keeps: per key, the row with the latest
version, and on a tie the one inserted last.
"""

from datetime import UTC, datetime
from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient

from db.clickhouse.client import ClickHouseClient
from rest.main import app
from rest.routers.public.traces import AuthResult, authenticate_api_key
from tests.fixtures.otel_payloads import make_attr, make_otel_payload, make_span
from worker.ingest_tasks import process_s3_traces
from worker.row_versions import PLACEHOLDER_TRACE_VERSION, receive_time, version_trace_rows

TRACE_HEX = "aa" * 16
ROOT_HEX = "bb" * 8
CHILD_HEX = "cc" * 8
EARLIER = "2026-10-29T12:00:00.100000+00:00"
LATER = "2026-10-29T12:00:05.200000+00:00"


class RecordingClickHouse:
    """The real ClickHouseClient row building over a driver that keeps every row."""

    def __init__(self):
        self.rows: dict[str, list[dict]] = {"spans": [], "traces": []}
        driver = MagicMock()
        driver.insert.side_effect = self._insert
        # The missing-root probe finds no stored trace.
        driver.query.return_value = MagicMock(result_rows=[])
        self.client = ClickHouseClient(driver)

    def _insert(self, table, rows, column_names):
        self.rows[table].extend(dict(zip(column_names, row)) for row in rows)

    def final(self, table: str, *key: str) -> dict[tuple, dict]:
        kept: dict[tuple, dict] = {}
        for row in self.rows[table]:
            k = tuple(row[c] for c in key)
            if k not in kept or row["ch_update_time"] >= kept[k]["ch_update_time"]:
                kept[k] = row
        return kept


@pytest.fixture()
def ingest(monkeypatch):
    """Run process_s3_traces on in-memory batches against a RecordingClickHouse."""
    batches: dict[str, dict] = {}
    s3 = MagicMock()
    s3.download_json.side_effect = lambda key: batches[key]
    monkeypatch.setattr("rest.services.s3.get_s3_service", lambda: s3)
    ch = RecordingClickHouse()
    monkeypatch.setattr("db.clickhouse.client.get_clickhouse_client", lambda: ch.client)
    monkeypatch.setattr("worker.detector_tasks.enqueue_detector_runs", MagicMock())
    monkeypatch.setattr("worker.ingest_tasks._publish_live_spans", MagicMock())

    def run(spans: list[dict], received_at: str | None = None) -> None:
        key = f"events/otel/proj-1/batch-{len(batches)}.json"
        batches[key] = make_otel_payload(spans)
        kwargs = {} if received_at is None else {"received_at": received_at}
        process_s3_traces(s3_key=key, project_id="proj-1", **kwargs)

    run.ch = ch
    return run


def _root(output: str) -> dict:
    return make_span(
        TRACE_HEX,
        ROOT_HEX,
        name="agent run",
        attributes=[make_attr("traceroot.span.output", output)],
    )


def _child(output: str) -> dict:
    return make_span(
        TRACE_HEX,
        CHILD_HEX,
        name="tool call",
        parent_span_id_hex=ROOT_HEX,
        attributes=[make_attr("traceroot.span.output", output)],
    )


class TestSpansOutOfOrder:
    def test_later_received_version_wins_when_processed_first(self, ingest):
        ingest([_child("newer")], received_at=LATER)
        ingest([_child("older")], received_at=EARLIER)  # an older batch, retried late

        (kept,) = ingest.ch.final("spans", "project_id", "trace_id", "span_id").values()
        assert kept["output"] == "newer"
        assert kept["ch_update_time"] == datetime.fromisoformat(LATER)

    def test_later_received_version_wins_in_order_too(self, ingest):
        ingest([_child("older")], received_at=EARLIER)
        ingest([_child("newer")], received_at=LATER)

        (kept,) = ingest.ch.final("spans", "project_id", "trace_id", "span_id").values()
        assert kept["output"] == "newer"

    def test_without_a_receive_time_the_insert_time_versions_the_row(self, ingest):
        before = datetime.now(UTC)
        ingest([_child("only")])

        (row,) = ingest.ch.rows["spans"]
        assert row["ch_update_time"] >= before
        assert row["ch_update_time"] == row["ch_create_time"]


class TestTracesOutOfOrder:
    def test_later_received_root_wins_when_processed_first(self, ingest):
        ingest([_root("newer")], received_at=LATER)
        ingest([_root("older")], received_at=EARLIER)

        (kept,) = ingest.ch.final("traces", "project_id", "trace_id").values()
        assert kept["output"] == "newer"
        assert kept["ch_update_time"] == datetime.fromisoformat(LATER)

    def test_root_replaces_a_placeholder_received_after_it(self, ingest):
        """A late child batch processed before a delayed root batch writes a placeholder
        trace row with a later receive time. The root-bearing row still replaces it."""
        ingest([_child("late child")], received_at=LATER)
        ingest([_root("root")], received_at=EARLIER)

        placeholder, root_row = ingest.ch.rows["traces"]
        assert placeholder["ch_update_time"] == PLACEHOLDER_TRACE_VERSION
        assert root_row["ch_update_time"] == datetime.fromisoformat(EARLIER)
        (kept,) = ingest.ch.final("traces", "project_id", "trace_id").values()
        assert kept is root_row
        assert kept["name"] == "agent run"

    def test_placeholder_without_a_receive_time_is_still_below_the_root(self, ingest):
        ingest([_child("late child")])
        ingest([_root("root")])

        (kept,) = ingest.ch.final("traces", "project_id", "trace_id").values()
        assert kept["name"] == "agent run"


class TestRowVersionHelpers:
    def test_receive_time_parses_iso_with_microseconds(self):
        assert receive_time(EARLIER) == datetime(2026, 10, 29, 12, 0, 0, 100000, tzinfo=UTC)

    @pytest.mark.parametrize("missing", [None, ""])
    def test_missing_receive_time_is_none(self, missing):
        assert receive_time(missing) is None

    def test_only_rows_without_their_root_are_placeholders(self):
        traces = [{"trace_id": "with-root"}, {"trace_id": "without-root"}]
        assert version_trace_rows(traces, {"with-root"}) is traces
        assert "ch_update_time" not in traces[0]
        assert traces[1]["ch_update_time"] == PLACEHOLDER_TRACE_VERSION


@pytest.fixture()
def sinks(monkeypatch):
    """S3 serving one JSON batch, and every downstream sink mocked."""
    s3 = MagicMock()
    s3.download_json.return_value = make_otel_payload([make_span(TRACE_HEX, ROOT_HEX)])
    monkeypatch.setattr("rest.services.s3.get_s3_service", lambda: s3)
    ch = MagicMock()
    monkeypatch.setattr("db.clickhouse.client.get_clickhouse_client", lambda: ch)
    monkeypatch.setattr("worker.detector_tasks.enqueue_detector_runs", MagicMock())
    monkeypatch.setattr("worker.ingest_tasks._publish_live_spans", MagicMock())
    return ch


def test_task_passes_the_receive_time_to_both_inserts(sinks):
    process_s3_traces(s3_key="events/otel/proj-1/k.json", project_id="proj-1", received_at=LATER)
    expected = datetime.fromisoformat(LATER)
    assert sinks.insert_spans_batch.call_args.kwargs["version_time"] == expected
    assert sinks.insert_traces_batch.call_args.kwargs["version_time"] == expected


def test_task_without_a_receive_time_passes_none(sinks):
    result = process_s3_traces(s3_key="events/otel/proj-1/k.json", project_id="proj-1")
    assert result["spans"] == 1
    assert sinks.insert_spans_batch.call_args.kwargs["version_time"] is None
    assert sinks.insert_traces_batch.call_args.kwargs["version_time"] is None


class TestApiQueuesTheReceiveTime:
    @pytest.fixture()
    def api(self, monkeypatch):
        app.dependency_overrides[authenticate_api_key] = lambda: AuthResult(
            project_id="proj-1",
            workspace_id="ws-1",
            billing_plan="pro",
            ingestion_blocked=False,
        )
        monkeypatch.setattr("rest.routers.public.traces.get_s3_service", MagicMock)
        task = MagicMock()
        monkeypatch.setattr("rest.routers.public.traces.process_s3_traces", task)
        yield TestClient(app), task
        app.dependency_overrides.clear()

    def test_received_at_is_queued_as_iso_utc(self, api):
        client, task = api
        before = datetime.now(UTC)
        response = client.post(
            "/api/v1/public/traces",
            content=b"protobuf",
            headers={"Content-Type": "application/x-protobuf"},
        )
        after = datetime.now(UTC)

        assert response.status_code == 200
        received_at = task.delay.call_args.kwargs["received_at"]
        parsed = datetime.fromisoformat(received_at)
        assert parsed.utcoffset().total_seconds() == 0
        assert before <= parsed <= after
        # The S3 key is partitioned by the same instant.
        key = task.delay.call_args.kwargs["s3_key"]
        assert key.split("/")[3:7] == [
            f"{parsed.year}",
            f"{parsed.month:02d}",
            f"{parsed.day:02d}",
            f"{parsed.hour:02d}",
        ]

    def test_queued_receive_time_versions_the_rows(self, api, ingest):
        """What the API queues is what the worker writes as ch_update_time."""
        client, task = api
        client.post(
            "/api/v1/public/traces",
            content=b"protobuf",
            headers={"Content-Type": "application/x-protobuf"},
        )
        received_at = task.delay.call_args.kwargs["received_at"]

        ingest([_child("payload")], received_at=received_at)

        (row,) = ingest.ch.rows["spans"]
        assert row["ch_update_time"] == datetime.fromisoformat(received_at)


def test_internal_self_trace_route_keeps_insert_time_versions(monkeypatch):
    """The internal route decodes and inserts in-process; it never passes a version."""
    from opentelemetry.proto.collector.trace.v1.trace_service_pb2 import (
        ExportTraceServiceRequest,
    )

    from shared.config import settings

    monkeypatch.setattr(settings, "internal_api_secret", "test-secret")
    ch = MagicMock()
    monkeypatch.setattr("rest.routers.internal.ingest.get_clickhouse_client", lambda: ch)
    request = ExportTraceServiceRequest()
    span = request.resource_spans.add().scope_spans.add().spans.add()
    span.trace_id = bytes.fromhex(TRACE_HEX)
    span.span_id = bytes.fromhex(ROOT_HEX)
    span.name = "detector-run"
    span.start_time_unix_nano = 1_700_000_000_000_000_000
    span.end_time_unix_nano = 1_700_000_001_000_000_000

    response = TestClient(app).post(
        "/api/v1/internal/traces?project_id=proj-1",
        content=request.SerializeToString(),
        headers={"X-Internal-Secret": "test-secret"},
    )

    assert response.status_code == 200
    assert ch.insert_spans_batch.call_args.kwargs == {}
    assert ch.insert_traces_batch.call_args.kwargs == {}
