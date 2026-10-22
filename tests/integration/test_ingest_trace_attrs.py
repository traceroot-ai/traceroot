"""Trace user and session survive a root span that arrives in a later batch.

``update_current_trace`` stamps ``traceroot.trace.*`` on the CURRENT span, so when it runs
inside a nested function the user and session ids sit on a child span. Children end, and
are exported, before their root, so a long agent run reaches ingest as a child-only batch
followed by a batch carrying the root. ``traces`` is a ReplacingMergeTree on
``ch_update_time``: the root batch's trace row replaces the child batch's, before and after
a merge, so it must not drop the ids the earlier row already holds.

Runs the real ingest task against the throwaway server, then reads back through the same
reader the trace detail and the Users page use.
"""

from __future__ import annotations

import base64
from datetime import UTC, datetime

import pytest

import worker.ingest_tasks as ingest_tasks
from db.clickhouse.client import ClickHouseClient
from rest.services.trace_reader import TraceReaderService

from .conftest import Gateway, _insert

pytestmark = pytest.mark.integration

PROJECT = "it_trace_attrs"
# Its own tenant, so its users do not show up in the Users-page assertions above.
NEWEST_PROJECT = "it_trace_attrs_newest"
TRACE_ID = base64.b64encode(b"\x5a" * 16).decode()
ROOT_SPAN = base64.b64encode(b"\x01" * 8).decode()
CHILD_SPAN = base64.b64encode(b"\x02" * 8).decode()
HEX_TRACE_ID = "5a" * 16
START_NS = 1_768_435_200_000_000_000  # 2026-01-15 00:00 UTC
# A month no other suite seeds, so merging it cannot collapse their versions.
PARTITION = 202601


def _attr(key: str, value: str) -> dict:
    return {"key": key, "value": {"stringValue": value}}


def _batch(span: dict) -> dict:
    return {
        "resourceSpans": [
            {"scopeSpans": [{"scope": {"name": "traceroot"}, "spans": [span]}]},
        ]
    }


CHILD_BATCH = _batch(
    {
        "traceId": TRACE_ID,
        "spanId": CHILD_SPAN,
        "parentSpanId": ROOT_SPAN,
        "name": "load_user",
        "startTimeUnixNano": str(START_NS + 100_000_000),
        "endTimeUnixNano": str(START_NS + 200_000_000),
        "attributes": [
            _attr("traceroot.span.type", "SPAN"),
            _attr("traceroot.trace.user_id", "u-42"),
            _attr("traceroot.trace.session_id", "sess-1"),
        ],
    }
)
ROOT_BATCH = _batch(
    {
        "traceId": TRACE_ID,
        "spanId": ROOT_SPAN,
        "name": "handle_request",
        "startTimeUnixNano": str(START_NS),
        "endTimeUnixNano": str(START_NS + 9_000_000_000),
        "attributes": [_attr("traceroot.span.type", "AGENT")],
    }
)


class _S3:
    def __init__(self, objects: dict[str, dict]):
        self._objects = objects

    def download_json(self, key: str) -> dict:
        return self._objects[key]


@pytest.fixture(scope="module")
def ingested(gateway: Gateway) -> Gateway:
    client = ClickHouseClient(gateway.admin)
    s3 = _S3({"child.json": CHILD_BATCH, "root.json": ROOT_BATCH})
    patch = pytest.MonkeyPatch()
    patch.setattr("db.clickhouse.client.get_clickhouse_client", lambda: client)
    patch.setattr("rest.services.s3.get_s3_service", lambda: s3)
    patch.setattr("worker.detector_tasks.enqueue_detector_runs", lambda *a, **k: None)
    patch.setattr(ingest_tasks, "_publish_live_spans", lambda *a, **k: None)
    try:
        # BatchSpanProcessor order: the child ends first, so it is exported first.
        ingest_tasks.process_s3_traces("child.json", PROJECT)
        ingest_tasks.process_s3_traces("root.json", PROJECT)
    finally:
        patch.undo()
    return gateway


def _reader(gateway: Gateway, monkeypatch) -> TraceReaderService:
    monkeypatch.setattr(
        "rest.services.trace_reader.get_clickhouse_client",
        lambda: ClickHouseClient(gateway.admin),
    )
    return TraceReaderService()


def _assert_user_and_session_kept(gateway: Gateway, monkeypatch) -> None:
    reader = _reader(gateway, monkeypatch)
    trace = reader.get_trace(PROJECT, HEX_TRACE_ID)
    assert trace is not None
    assert trace["name"] == "handle_request"
    assert (trace["user_id"], trace["session_id"]) == ("u-42", "sess-1")
    users = reader.list_users(PROJECT)["data"]
    assert [u["user_id"] for u in users] == ["u-42"]


def test_root_batch_keeps_user_and_session_from_an_earlier_child_batch(ingested, monkeypatch):
    """Before any merge: the reader keeps the newest version, the root batch's row."""
    _assert_user_and_session_kept(ingested, monkeypatch)


def test_root_batch_takes_ids_from_the_newest_stored_version(gateway, monkeypatch):
    """With two stored versions, the lookup reads the newest, not whichever comes first."""
    trace_id = "6b" * 16
    start = datetime(2026, 1, 15, 1, 0, tzinfo=UTC)
    # One insert per version: ReplacingMergeTree collapses equal keys within a single
    # insert, so only separate parts leave both versions for the lookup to choose from.
    for user_id, updated in (
        (None, datetime(2026, 1, 15, 1, 0, 1, tzinfo=UTC)),
        ("u-new", datetime(2026, 1, 15, 1, 0, 2, tzinfo=UTC)),
    ):
        _insert(
            gateway.admin,
            "traces",
            [
                {
                    "trace_id": trace_id,
                    "project_id": NEWEST_PROJECT,
                    "trace_start_time": start,
                    "name": "load_user",
                    "user_id": user_id,
                    "ch_update_time": updated,
                }
            ],
        )
    root = _batch(
        {
            "traceId": base64.b64encode(bytes.fromhex(trace_id)).decode(),
            "spanId": ROOT_SPAN,
            "name": "handle_request",
            "startTimeUnixNano": str(int(start.timestamp()) * 10**9),
            "endTimeUnixNano": str((int(start.timestamp()) + 9) * 10**9),
            "attributes": [_attr("traceroot.span.type", "AGENT")],
        }
    )
    client = ClickHouseClient(gateway.admin)
    monkeypatch.setattr("db.clickhouse.client.get_clickhouse_client", lambda: client)
    monkeypatch.setattr("rest.services.s3.get_s3_service", lambda: _S3({"root2.json": root}))
    monkeypatch.setattr("worker.detector_tasks.enqueue_detector_runs", lambda *a, **k: None)
    monkeypatch.setattr(ingest_tasks, "_publish_live_spans", lambda *a, **k: None)

    ingest_tasks.process_s3_traces("root2.json", NEWEST_PROJECT)

    trace = _reader(gateway, monkeypatch).get_trace(NEWEST_PROJECT, trace_id)
    assert trace is not None
    assert trace["user_id"] == "u-new"


def test_user_and_session_survive_a_physical_merge(ingested, monkeypatch):
    """After OPTIMIZE FINAL only the newest version is left on disk."""
    ingested.admin.command(f"OPTIMIZE TABLE traces PARTITION {PARTITION} FINAL")
    rows = ingested.admin.query(
        "SELECT count() FROM traces WHERE project_id = {p:String} AND trace_id = {t:String}",
        parameters={"p": PROJECT, "t": HEX_TRACE_ID},
    ).result_rows[0][0]
    assert rows == 1, "the merge did not collapse the two versions"
    _assert_user_and_session_kept(ingested, monkeypatch)
