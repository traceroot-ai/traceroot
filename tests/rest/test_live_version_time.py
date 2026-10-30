"""The live view times its quiet window from when span rows were inserted.

``ch_update_time`` is a span row's version, and an insert can set it earlier
than the insert itself. ``ch_create_time`` is always the insert time, so it is
the column that says whether rows for a trace are still arriving.

These tests run the real completion-state query function over a ClickHouse
double that holds one trace's span rows, then stream through the real
endpoint with Redis mocked.
"""

import asyncio
import json
import re
from datetime import UTC, datetime, timedelta
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi.testclient import TestClient

from rest.main import app
from rest.routers import live as live_router
from rest.routers.deps import ProjectAccessInfo, get_project_access

PROJECT_ID = "project-123"
TRACE_ID = "trace-abc"
ENDPOINT = f"/api/v1/projects/{PROJECT_ID}/traces/{TRACE_ID}/live"


def _utcnow_naive() -> datetime:
    """ClickHouse returns naive UTC datetimes; mirror that in test values."""
    return datetime.now(UTC).replace(tzinfo=None)


def _span(
    span_id: str,
    *,
    version: datetime,
    inserted: datetime,
    parent: str | None = None,
    end: datetime | None = None,
) -> dict:
    return {
        "span_id": span_id,
        "parent_span_id": parent,
        "span_end_time": end,
        "ch_update_time": version,
        "ch_create_time": inserted,
    }


def _flat(sql: str) -> str:
    return " ".join(sql.split())


class SpanRows:
    """A ClickHouse client double holding one trace's span rows.

    Answers the completion-state query as ClickHouse does for these rows: the
    root end time from the latest version of each span, and the last ingest
    time as the max, over every row, of the column the query's ``max()`` reads.
    """

    def __init__(self, *rows: dict):
        self.rows = list(rows)
        self.sql: str | None = None
        self.parameters: dict | None = None

    def query(self, sql: str, parameters: dict) -> MagicMock:
        self.sql = _flat(sql)
        self.parameters = parameters
        latest: dict[str, dict] = {}
        for row in sorted(self.rows, key=lambda r: r["ch_update_time"]):
            latest[row["span_id"]] = row
        root_end = max(
            (
                r["span_end_time"]
                for r in latest.values()
                if r["parent_span_id"] is None and r["span_end_time"] is not None
            ),
            default=None,
        )
        (column,) = re.findall(r"\bmax\((\w+)\)", self.sql)
        last_ingest = max(r[column] for r in self.rows)
        return MagicMock(result_rows=[(root_end, last_ingest)])


class QueuedPubSub:
    """Async pubsub double: hands out queued messages, then waits out the timeout."""

    def __init__(self, *messages: dict):
        self.messages = list(messages)
        self.get_message_calls = 0
        self.subscribe = AsyncMock()
        self.unsubscribe = AsyncMock()
        self.close = AsyncMock()

    async def get_message(self, *, ignore_subscribe_messages=True, timeout=0):
        self.get_message_calls += 1
        if self.messages:
            return self.messages.pop(0)
        await asyncio.sleep(timeout)
        return None


def _late_batch() -> dict:
    payload = {"type": "spans", "spans": [{"span_id": "late", "trace_id": TRACE_ID}]}
    return {"type": "message", "data": json.dumps(payload)}


@pytest.fixture(autouse=True)
def _mock_retention_lookup():
    service = MagicMock()
    service.get_trace_start_time.return_value = _utcnow_naive()
    with patch("rest.routers.live.get_trace_reader_service", return_value=service):
        yield


@pytest.fixture()
def client():
    async def mock_access(project_id: str, x_user_id=None):
        return ProjectAccessInfo(
            project_id=project_id,
            user_id="u1",
            role="ADMIN",
            workspace_id="ws-test",
            billing_plan="enterprise",
        )

    app.dependency_overrides[get_project_access] = mock_access
    yield TestClient(app)
    app.dependency_overrides.clear()


def _stream(client, ch: SpanRows, pubsub: QueuedPubSub, quiet_seconds: float) -> list[str]:
    redis = MagicMock()
    redis.pubsub.return_value = pubsub
    with (
        patch("rest.routers.live.TRACE_COMPLETE_QUIET_SECONDS", quiet_seconds),
        patch("db.clickhouse.client.get_clickhouse_client", return_value=ch),
        patch("shared.redis.get_async_redis_client", return_value=redis),
    ):
        resp = client.get(ENDPOINT)
    assert resp.status_code == 200
    return [line for line in resp.text.splitlines() if line.startswith("event:")]


class TestCompletionStateQuery:
    def test_last_ingest_time_is_the_insert_time(self):
        now = _utcnow_naive()
        received = now - timedelta(minutes=5)
        ch = SpanRows(_span("root", version=received, inserted=now, end=received))

        with patch("db.clickhouse.client.get_clickhouse_client", return_value=ch):
            root_end, last_ingest = live_router._completion_state_in_clickhouse(
                PROJECT_ID, TRACE_ID
            )

        assert root_end == received
        assert last_ingest == now

    def test_query_reads_the_insert_time_column(self):
        now = _utcnow_naive()
        ch = SpanRows(_span("root", version=now, inserted=now, end=now))

        with patch("db.clickhouse.client.get_clickhouse_client", return_value=ch):
            live_router._completion_state_in_clickhouse(PROJECT_ID, TRACE_ID)

        assert "max(ch_create_time)" in ch.sql
        assert "max(ch_update_time)" not in ch.sql
        assert ch.parameters == {"project_id": PROJECT_ID, "trace_id": TRACE_ID}

    def test_last_ingest_time_counts_versions_that_lost_to_a_newer_one(self):
        """A retried batch can insert an older version after the newer one.
        Its row loses the dedup but was just inserted, so the insert-time max
        reads the trace's rows straight from ``spans``, not the deduped ones."""
        now = _utcnow_naive()
        older = now - timedelta(minutes=5)
        newer = older + timedelta(seconds=1)
        ch = SpanRows(
            _span("root", version=newer, inserted=older, end=newer),
            _span("root", version=older, inserted=now, end=older),
        )

        with patch("db.clickhouse.client.get_clickhouse_client", return_value=ch):
            root_end, last_ingest = live_router._completion_state_in_clickhouse(
                PROJECT_ID, TRACE_ID
            )

        assert root_end == newer
        assert last_ingest == now
        assert (
            "SELECT max(ch_create_time) FROM spans "
            "WHERE project_id = {project_id:String} AND trace_id = {trace_id:String} )"
        ) in ch.sql

    def test_root_end_time_keeps_the_latest_version_of_each_span(self):
        now = _utcnow_naive()
        ch = SpanRows(_span("root", version=now, inserted=now, end=now))

        with patch("db.clickhouse.client.get_clickhouse_client", return_value=ch):
            live_router._completion_state_in_clickhouse(PROJECT_ID, TRACE_ID)

        assert (
            "SELECT maxIf(span_end_time, isNull(parent_span_id)) FROM ( "
            "SELECT parent_span_id, span_end_time FROM spans "
            "WHERE project_id = {project_id:String} AND trace_id = {trace_id:String} "
            "ORDER BY ch_update_time DESC LIMIT 1 BY span_id )"
        ) in ch.sql


class TestQuietWindowFromInsertTime:
    def test_row_received_long_ago_but_inserted_now_keeps_the_quiet_window(self, client):
        """The root ended and its batch was received five minutes ago, but the
        worker only inserted it now: the stream stays open for late spans."""
        now = _utcnow_naive()
        received = now - timedelta(minutes=5)
        ch = SpanRows(_span("root", version=received, inserted=now, end=received))
        pubsub = QueuedPubSub(_late_batch())

        events = _stream(client, ch, pubsub, quiet_seconds=0.2)

        assert events == ["event: spans", "event: trace_complete"]
        assert pubsub.get_message_calls > 0

    def test_row_inserted_long_ago_closes_immediately(self, client):
        long_ago = _utcnow_naive() - timedelta(minutes=5)
        ch = SpanRows(_span("root", version=long_ago, inserted=long_ago, end=long_ago))
        pubsub = QueuedPubSub()

        events = _stream(client, ch, pubsub, quiet_seconds=30)

        assert events == ["event: trace_complete"]
        assert pubsub.get_message_calls == 0
