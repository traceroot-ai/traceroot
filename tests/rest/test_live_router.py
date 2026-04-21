"""Unit tests for the live trace SSE streaming endpoint.

All tests mock ClickHouse and Redis — no external services needed.

Key invariants under test:
- Already-complete traces emit trace_complete immediately (regression for the
  Celery concurrency race condition where demo_session arrived in ClickHouse
  before sibling spans, causing the old frontend isTraceComplete gate to
  disable SSE entirely).
- Redis subscription happens BEFORE the ClickHouse check so no concurrent
  span events are missed.
- Concurrent span events queued in Redis during the ClickHouse check are
  forwarded before trace_complete on the already-complete path.
"""

import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi.testclient import TestClient

from rest.main import app
from rest.routers.deps import ProjectAccessInfo, get_project_access

PROJECT_ID = "project-123"
TRACE_ID = "trace-abc"
ENDPOINT = f"/api/v1/projects/{PROJECT_ID}/traces/{TRACE_ID}/live"


class MockPubSub:
    """Async pubsub that yields a fixed sequence of messages then returns None."""

    def __init__(self, messages: list):
        self._messages = list(messages)
        self._idx = 0
        self.subscribe = AsyncMock()
        self.unsubscribe = AsyncMock()
        self.close = AsyncMock()

    async def get_message(self, *, ignore_subscribe_messages=True, timeout=0):
        if self._idx < len(self._messages):
            msg = self._messages[self._idx]
            self._idx += 1
            return msg
        return None


def redis_message(payload: dict) -> dict:
    return {"type": "message", "data": json.dumps(payload)}


@pytest.fixture()
def client():
    async def mock_access(project_id: str, x_user_id=None):
        return ProjectAccessInfo(project_id=project_id, user_id="u1", role="ADMIN")

    app.dependency_overrides[get_project_access] = mock_access
    yield TestClient(app)


def parse_sse_events(text: str) -> list[str]:
    """Return all `event: X` lines from an SSE response body."""
    return [line for line in text.splitlines() if line.startswith("event:")]


class TestAlreadyCompleteTrace:
    def test_emits_trace_complete_immediately(self, client):
        """Regression: when ClickHouse has a root span with end_time, the endpoint
        must emit trace_complete without waiting — prevents the case where the old
        isTraceComplete frontend gate would disable SSE and leave the tree broken."""
        pubsub = MockPubSub([])
        mock_redis = MagicMock()
        mock_redis.pubsub.return_value = pubsub

        with (
            patch("rest.routers.live._is_trace_complete_in_clickhouse", return_value=True),
            patch("shared.redis.get_async_redis_client", return_value=mock_redis),
        ):
            resp = client.get(ENDPOINT)

        assert resp.status_code == 200
        events = parse_sse_events(resp.text)
        assert events == ["event: trace_complete"]

    def test_drains_concurrent_redis_spans_before_trace_complete(self, client):
        """Spans published to Redis between subscribe and ClickHouse check must be
        forwarded to the client before trace_complete is emitted.

        This covers the concurrent-task edge case: Celery worker A publishes spans
        to Redis while live.py is doing the ClickHouse check — those spans are
        already in ClickHouse (process_s3_traces writes before publishing), so they
        must arrive at the client before the final invalidateQueries refetch."""
        spans_msg = redis_message({"type": "spans", "spans": [{"span_id": "s1"}]})
        pubsub = MockPubSub([spans_msg])
        mock_redis = MagicMock()
        mock_redis.pubsub.return_value = pubsub

        with (
            patch("rest.routers.live._is_trace_complete_in_clickhouse", return_value=True),
            patch("shared.redis.get_async_redis_client", return_value=mock_redis),
        ):
            resp = client.get(ENDPOINT)

        events = parse_sse_events(resp.text)
        assert events[0] == "event: spans"
        assert events[-1] == "event: trace_complete"

    def test_does_not_forward_non_span_events_during_drain(self, client):
        """On the already-complete path, only 'spans' events should be drained from
        Redis — other event types (e.g. a redundant trace_complete) are skipped so
        that the client receives exactly one trace_complete."""
        redundant_complete = redis_message({"type": "trace_complete"})
        pubsub = MockPubSub([redundant_complete])
        mock_redis = MagicMock()
        mock_redis.pubsub.return_value = pubsub

        with (
            patch("rest.routers.live._is_trace_complete_in_clickhouse", return_value=True),
            patch("shared.redis.get_async_redis_client", return_value=mock_redis),
        ):
            resp = client.get(ENDPOINT)

        events = parse_sse_events(resp.text)
        assert events.count("event: trace_complete") == 1


class TestLiveTrace:
    def test_relays_span_events_then_trace_complete(self, client):
        """Live traces: Redis span events are forwarded in order, and the stream
        closes when trace_complete arrives."""
        spans_msg = redis_message({"type": "spans", "spans": [{"span_id": "s1"}]})
        complete_msg = redis_message({"type": "trace_complete"})
        pubsub = MockPubSub([spans_msg, complete_msg])
        mock_redis = MagicMock()
        mock_redis.pubsub.return_value = pubsub

        with (
            patch("rest.routers.live._is_trace_complete_in_clickhouse", return_value=False),
            patch("shared.redis.get_async_redis_client", return_value=mock_redis),
        ):
            resp = client.get(ENDPOINT)

        events = parse_sse_events(resp.text)
        assert events[0] == "event: spans"
        assert events[-1] == "event: trace_complete"

    def test_multiple_span_batches_before_complete(self, client):
        """Multiple span batches (from different Celery tasks) are all forwarded."""
        batch1 = redis_message({"type": "spans", "spans": [{"span_id": "s1"}]})
        batch2 = redis_message({"type": "spans", "spans": [{"span_id": "s2"}]})
        complete_msg = redis_message({"type": "trace_complete"})
        pubsub = MockPubSub([batch1, batch2, complete_msg])
        mock_redis = MagicMock()
        mock_redis.pubsub.return_value = pubsub

        with (
            patch("rest.routers.live._is_trace_complete_in_clickhouse", return_value=False),
            patch("shared.redis.get_async_redis_client", return_value=mock_redis),
        ):
            resp = client.get(ENDPOINT)

        events = parse_sse_events(resp.text)
        assert events.count("event: spans") == 2
        assert events[-1] == "event: trace_complete"


class TestSubscribeBeforeCheckInvariant:
    def test_redis_subscribe_happens_before_clickhouse_check(self, client):
        """Verifies the subscribe-first invariant: the Redis subscription must be
        established before ClickHouse is queried so that concurrent Celery span
        events published during the check are not missed."""
        call_order = []

        async def tracked_subscribe(channel):
            call_order.append("subscribe")

        def tracked_check(project_id, trace_id):
            call_order.append("clickhouse_check")
            return True

        pubsub = MockPubSub([])
        pubsub.subscribe.side_effect = tracked_subscribe
        mock_redis = MagicMock()
        mock_redis.pubsub.return_value = pubsub

        with (
            patch("rest.routers.live._is_trace_complete_in_clickhouse", side_effect=tracked_check),
            patch("shared.redis.get_async_redis_client", return_value=mock_redis),
        ):
            client.get(ENDPOINT)

        assert call_order.index("subscribe") < call_order.index("clickhouse_check")
