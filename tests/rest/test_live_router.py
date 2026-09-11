"""Unit tests for the live trace SSE streaming endpoint.

All tests mock ClickHouse and Redis — no external services needed.

Key invariants under test:
- Already-complete traces emit trace_complete after a short quiet window so
  root-ended-first traces can still deliver late descendant spans.
- Redis subscription happens BEFORE the ClickHouse check so no concurrent
  span events are missed.
- Concurrent span events queued in Redis during the ClickHouse check are
  forwarded before trace_complete on the already-complete path.
"""

import asyncio
import json
from datetime import UTC, datetime, timedelta, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi.testclient import TestClient

from rest.main import app
from rest.routers import live as live_router
from rest.routers.deps import ProjectAccessInfo, get_project_access

PROJECT_ID = "project-123"
TRACE_ID = "trace-abc"
ENDPOINT = f"/api/v1/projects/{PROJECT_ID}/traces/{TRACE_ID}/live"


class MockPubSub:
    """Async pubsub that yields a fixed sequence of messages then returns None."""

    def __init__(self, messages: list):
        self._messages = list(messages)
        self._idx = 0
        self.get_message_calls = 0
        self.subscribe = AsyncMock()
        self.unsubscribe = AsyncMock()
        self.close = AsyncMock()

    async def get_message(self, *, ignore_subscribe_messages=True, timeout=0):
        self.get_message_calls += 1
        if self._idx < len(self._messages):
            msg = self._messages[self._idx]
            self._idx += 1
            return msg
        if timeout:
            await asyncio.sleep(timeout)
        return None


def _utcnow_naive() -> datetime:
    """ClickHouse returns naive UTC datetimes; mirror that in test values."""
    return datetime.now(UTC).replace(tzinfo=None)


def _aware(dt: datetime) -> datetime:
    """Re-tag a naive-UTC value as timezone-aware UTC — same instant, the
    driver-variance shape the fix must tolerate."""
    return dt.replace(tzinfo=UTC)


def _aware_offset(dt: datetime, *, hours: float) -> datetime:
    """Re-express a naive-UTC instant as aware at a non-UTC offset — same
    real instant, different tzinfo and different wall-clock digits. Used to
    prove the fix does a real conversion (`.astimezone(UTC)`), not a blind
    `.replace(tzinfo=None)` strip: a blind strip would keep this offset's
    local digits and misread them as UTC, shifting the instant by `hours`."""
    return dt.replace(tzinfo=UTC).astimezone(timezone(timedelta(hours=hours)))


def redis_message(payload: dict) -> dict:
    return {"type": "message", "data": json.dumps(payload)}


@pytest.fixture(autouse=True)
def _mock_retention_lookup():
    """All tests mock the lightweight retention timestamp query so it never
    hits real ClickHouse.  Enterprise tests bypass retention regardless of the
    value; retention-specific tests override this with their own patch."""
    mock_service = MagicMock()
    mock_service.get_trace_start_time.return_value = _utcnow_naive()
    with patch(
        "rest.routers.live.get_trace_reader_service",
        return_value=mock_service,
    ):
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


def parse_sse_events(text: str) -> list[str]:
    """Return all `event: X` lines from an SSE response body."""
    return [line for line in text.splitlines() if line.startswith("event:")]


async def collect_stream_chunks(response) -> list[str]:
    chunks = []
    async for chunk in response.body_iterator:
        chunks.append(chunk.decode() if isinstance(chunk, bytes) else chunk)
    return chunks


class ConnectedRequest:
    async def is_disconnected(self):
        return False


class TestAlreadyCompleteTrace:
    def test_emits_trace_complete_after_quiet_window(self, client):
        """A root span with end_time starts the quiet window, then emits completion."""
        pubsub = MockPubSub([])
        mock_redis = MagicMock()
        mock_redis.pubsub.return_value = pubsub

        with (
            patch("rest.routers.live.TRACE_COMPLETE_QUIET_SECONDS", 0.1),
            patch(
                "rest.routers.live._completion_state_in_clickhouse",
                return_value=(_utcnow_naive(), _utcnow_naive()),
            ),
            patch("shared.redis.get_async_redis_client", return_value=mock_redis),
        ):
            resp = client.get(ENDPOINT)

        assert resp.status_code == 200
        events = parse_sse_events(resp.text)
        assert events == ["event: trace_complete"]

    def test_expired_quiet_window_closes_without_redis_poll(self, client):
        """If the quiet deadline has already elapsed, completion is emitted directly."""
        pubsub = MockPubSub([])
        mock_redis = MagicMock()
        mock_redis.pubsub.return_value = pubsub

        with (
            patch("rest.routers.live.TRACE_COMPLETE_QUIET_SECONDS", -1),
            patch(
                "rest.routers.live._completion_state_in_clickhouse",
                return_value=(_utcnow_naive(), _utcnow_naive()),
            ),
            patch("shared.redis.get_async_redis_client", return_value=mock_redis),
        ):
            resp = client.get(ENDPOINT)

        events = parse_sse_events(resp.text)
        assert events == ["event: trace_complete"]
        assert pubsub.get_message_calls == 0

    async def test_direct_generator_closes_when_quiet_deadline_expires(self):
        """Direct generator coverage for the already-complete quiet deadline."""
        pubsub = MockPubSub([])
        mock_redis = MagicMock()
        mock_redis.pubsub.return_value = pubsub

        with (
            patch("rest.routers.live.TRACE_COMPLETE_QUIET_SECONDS", -1),
            patch(
                "rest.routers.live._completion_state_in_clickhouse",
                return_value=(_utcnow_naive(), _utcnow_naive()),
            ),
            patch("shared.redis.get_async_redis_client", return_value=mock_redis),
        ):
            response = await live_router.live_trace_stream(
                ConnectedRequest(),
                PROJECT_ID,
                TRACE_ID,
                ProjectAccessInfo(
                    project_id=PROJECT_ID,
                    user_id="u1",
                    role="ADMIN",
                    workspace_id="ws-test",
                    billing_plan="enterprise",
                ),
            )
            chunks = await collect_stream_chunks(response)

        assert chunks == ["event: trace_complete\ndata: {}\n\n"]

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
            patch("rest.routers.live.TRACE_COMPLETE_QUIET_SECONDS", 0.1),
            patch(
                "rest.routers.live._completion_state_in_clickhouse",
                return_value=(_utcnow_naive(), _utcnow_naive()),
            ),
            patch("shared.redis.get_async_redis_client", return_value=mock_redis),
        ):
            resp = client.get(ENDPOINT)

        events = parse_sse_events(resp.text)
        assert events[0] == "event: spans"
        assert events[-1] == "event: trace_complete"

    def test_does_not_forward_non_span_events_during_drain(self, client):
        """Redundant trace_complete events reset the quiet window, not duplicate output."""
        redundant_complete = redis_message({"type": "trace_complete"})
        pubsub = MockPubSub([redundant_complete])
        mock_redis = MagicMock()
        mock_redis.pubsub.return_value = pubsub

        with (
            patch("rest.routers.live.TRACE_COMPLETE_QUIET_SECONDS", 0.1),
            patch(
                "rest.routers.live._completion_state_in_clickhouse",
                return_value=(_utcnow_naive(), _utcnow_naive()),
            ),
            patch("shared.redis.get_async_redis_client", return_value=mock_redis),
        ):
            resp = client.get(ENDPOINT)

        events = parse_sse_events(resp.text)
        assert events.count("event: trace_complete") == 1

    async def test_direct_generator_complete_message_starts_quiet_window(self):
        """A live trace_complete message starts a quiet window before closing."""
        complete_msg = redis_message({"type": "trace_complete"})
        pubsub = MockPubSub([complete_msg])
        mock_redis = MagicMock()
        mock_redis.pubsub.return_value = pubsub

        with (
            patch("rest.routers.live.TRACE_COMPLETE_QUIET_SECONDS", 0.01),
            patch("rest.routers.live._completion_state_in_clickhouse", return_value=(None, None)),
            patch("shared.redis.get_async_redis_client", return_value=mock_redis),
        ):
            response = await live_router.live_trace_stream(
                ConnectedRequest(),
                PROJECT_ID,
                TRACE_ID,
                ProjectAccessInfo(
                    project_id=PROJECT_ID,
                    user_id="u1",
                    role="ADMIN",
                    workspace_id="ws-test",
                    billing_plan="enterprise",
                ),
            )
            chunks = await collect_stream_chunks(response)

        assert chunks == ["event: trace_complete\ndata: {}\n\n"]


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
            patch("rest.routers.live.TRACE_COMPLETE_QUIET_SECONDS", 0.1),
            patch("rest.routers.live._completion_state_in_clickhouse", return_value=(None, None)),
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
            patch("rest.routers.live.TRACE_COMPLETE_QUIET_SECONDS", 0.1),
            patch("rest.routers.live._completion_state_in_clickhouse", return_value=(None, None)),
            patch("shared.redis.get_async_redis_client", return_value=mock_redis),
        ):
            resp = client.get(ENDPOINT)

        events = parse_sse_events(resp.text)
        assert events.count("event: spans") == 2
        assert events[-1] == "event: trace_complete"

    def test_late_spans_after_root_complete_are_forwarded_before_close(self, client):
        """Root-ended-first traces should not close before late child batches arrive."""
        root_complete = redis_message({"type": "trace_complete"})
        late_child_batch = redis_message({"type": "spans", "spans": [{"span_id": "late-child"}]})
        pubsub = MockPubSub([root_complete, late_child_batch])
        mock_redis = MagicMock()
        mock_redis.pubsub.return_value = pubsub

        with (
            patch("rest.routers.live.TRACE_COMPLETE_QUIET_SECONDS", 0.1),
            patch("rest.routers.live._completion_state_in_clickhouse", return_value=(None, None)),
            patch("shared.redis.get_async_redis_client", return_value=mock_redis),
        ):
            resp = client.get(ENDPOINT)

        events = parse_sse_events(resp.text)
        assert events == ["event: spans", "event: trace_complete"]


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
            return _utcnow_naive(), _utcnow_naive()

        pubsub = MockPubSub([])
        pubsub.subscribe.side_effect = tracked_subscribe
        mock_redis = MagicMock()
        mock_redis.pubsub.return_value = pubsub

        with (
            patch("rest.routers.live._completion_state_in_clickhouse", side_effect=tracked_check),
            patch("shared.redis.get_async_redis_client", return_value=mock_redis),
        ):
            client.get(ENDPOINT)

        assert call_order.index("subscribe") < call_order.index("clickhouse_check")

    def test_events_published_during_clickhouse_check_are_not_lost(self, client):
        """Simulates a Celery worker publishing a span to Redis while the
        ClickHouse completion check is running. Because subscribe happens
        before the check, the event must appear in the SSE output."""
        pubsub = MockPubSub([])
        mock_redis = MagicMock()
        mock_redis.pubsub.return_value = pubsub

        def check_that_injects_a_message(project_id, trace_id):
            # Simulate a Celery worker publishing while ClickHouse is queried:
            # inject a span message into the pubsub queue mid-check.
            pubsub._messages.append(
                redis_message({"type": "spans", "spans": [{"span_id": "concurrent"}]})
            )
            return _utcnow_naive(), _utcnow_naive()

        with (
            patch("rest.routers.live.TRACE_COMPLETE_QUIET_SECONDS", 0.1),
            patch(
                "rest.routers.live._completion_state_in_clickhouse",
                side_effect=check_that_injects_a_message,
            ),
            patch("shared.redis.get_async_redis_client", return_value=mock_redis),
        ):
            resp = client.get(ENDPOINT)

        events = parse_sse_events(resp.text)
        assert "event: spans" in events, "span published during ClickHouse check was lost"
        assert events[-1] == "event: trace_complete"


class TestQuietWindowAnchoring:
    def test_old_completed_trace_closes_immediately(self, client):
        """The quiet window is anchored to the root's end time: a trace that
        completed long ago must not hold the SSE connection for the window."""
        pubsub = MockPubSub([])
        mock_redis = MagicMock()
        mock_redis.pubsub.return_value = pubsub

        stale_root_end = _utcnow_naive() - timedelta(hours=1)
        with (
            patch("rest.routers.live.TRACE_COMPLETE_QUIET_SECONDS", 30),
            patch(
                "rest.routers.live._completion_state_in_clickhouse",
                return_value=(stale_root_end, stale_root_end),
            ),
            patch("shared.redis.get_async_redis_client", return_value=mock_redis),
        ):
            resp = client.get(ENDPOINT)

        events = parse_sse_events(resp.text)
        assert events == ["event: trace_complete"]
        # Deadline expired on arrival — closed without waiting the 30s window.
        assert pubsub.get_message_calls == 0

    def test_recently_completed_trace_still_gets_quiet_window(self, client):
        """A root that ended a moment ago keeps the remaining quiet window so
        late descendant spans can still be forwarded."""
        late_batch = redis_message(
            {"type": "spans", "spans": [{"span_id": "late", "trace_id": TRACE_ID}]}
        )
        pubsub = MockPubSub([late_batch])
        mock_redis = MagicMock()
        mock_redis.pubsub.return_value = pubsub

        with (
            patch("rest.routers.live.TRACE_COMPLETE_QUIET_SECONDS", 0.2),
            patch(
                "rest.routers.live._completion_state_in_clickhouse",
                return_value=(_utcnow_naive(), _utcnow_naive()),
            ),
            patch("shared.redis.get_async_redis_client", return_value=mock_redis),
        ):
            resp = client.get(ENDPOINT)

        events = parse_sse_events(resp.text)
        assert events == ["event: spans", "event: trace_complete"]

    def test_old_root_with_recent_activity_keeps_quiet_window(self, client):
        """A root that ended long ago does not close the stream while spans are
        still actively arriving: the window anchors to the last ingest, so a
        late-connecting client still receives in-flight descendants."""
        late_batch = redis_message(
            {"type": "spans", "spans": [{"span_id": "late", "trace_id": TRACE_ID}]}
        )
        pubsub = MockPubSub([late_batch])
        mock_redis = MagicMock()
        mock_redis.pubsub.return_value = pubsub

        stale_root_end = _utcnow_naive() - timedelta(minutes=5)
        with (
            patch("rest.routers.live.TRACE_COMPLETE_QUIET_SECONDS", 0.2),
            patch(
                "rest.routers.live._completion_state_in_clickhouse",
                return_value=(stale_root_end, _utcnow_naive()),
            ),
            patch("shared.redis.get_async_redis_client", return_value=mock_redis),
        ):
            resp = client.get(ENDPOINT)

        events = parse_sse_events(resp.text)
        assert events == ["event: spans", "event: trace_complete"]


class TestHardDeadline:
    def test_hard_deadline_with_completed_root_emits_trace_complete(self, client):
        """A completed root that kept resetting the quiet window up to the hard
        ceiling closes as complete, so the frontend refetches instead of
        dangling on a dropped timeout event."""
        pubsub = MockPubSub([])
        mock_redis = MagicMock()
        mock_redis.pubsub.return_value = pubsub

        with (
            patch("rest.routers.live.MAX_STREAM_SECONDS", -1),
            patch("rest.routers.live.TRACE_COMPLETE_QUIET_SECONDS", 30),
            patch(
                "rest.routers.live._completion_state_in_clickhouse",
                return_value=(_utcnow_naive(), _utcnow_naive()),
            ),
            patch("shared.redis.get_async_redis_client", return_value=mock_redis),
        ):
            resp = client.get(ENDPOINT)

        events = parse_sse_events(resp.text)
        assert events == ["event: trace_complete"]

    def test_hard_deadline_without_completed_root_emits_stream_timeout(self, client):
        """A trace whose root never completed hits the ceiling as a timeout,
        not a completion — the trace is not done."""
        pubsub = MockPubSub([])
        mock_redis = MagicMock()
        mock_redis.pubsub.return_value = pubsub

        with (
            patch("rest.routers.live.MAX_STREAM_SECONDS", -1),
            patch("rest.routers.live._completion_state_in_clickhouse", return_value=(None, None)),
            patch("shared.redis.get_async_redis_client", return_value=mock_redis),
        ):
            resp = client.get(ENDPOINT)

        events = parse_sse_events(resp.text)
        assert events == ["event: stream_timeout"]


class TestRetentionGate:
    def test_live_stream_403_for_old_trace(self):
        """A trace outside the retention window returns 403 before streaming."""
        old_start = datetime(2020, 1, 1)

        async def mock_access(project_id: str, x_user_id=None):
            return ProjectAccessInfo(
                project_id=project_id,
                user_id="u1",
                role="ADMIN",
                workspace_id="ws-test",
                billing_plan="free",
            )

        app.dependency_overrides[get_project_access] = mock_access

        pubsub = MockPubSub([])
        mock_redis = MagicMock()
        mock_redis.pubsub.return_value = pubsub

        try:
            mock_service = MagicMock()
            mock_service.get_trace_start_time.return_value = old_start
            test_client = TestClient(app, raise_server_exceptions=False)
            with (
                patch(
                    "rest.routers.live.get_trace_reader_service",
                    return_value=mock_service,
                ),
                patch("shared.redis.get_async_redis_client", return_value=mock_redis),
            ):
                resp = test_client.get(ENDPOINT)
            assert resp.status_code == 403
            detail = resp.json()["detail"]
            assert detail["message"] == "Data outside retention window"
            # Verify pubsub was cleaned up on 403
            pubsub.unsubscribe.assert_awaited_once()
            pubsub.close.assert_awaited_once()
        finally:
            app.dependency_overrides.clear()

    def test_live_stream_200_for_recent_trace(self):
        """A trace within the retention window proceeds to streaming."""
        recent_start = _utcnow_naive() - timedelta(days=1)

        async def mock_access(project_id: str, x_user_id=None):
            return ProjectAccessInfo(
                project_id=project_id,
                user_id="u1",
                role="ADMIN",
                workspace_id="ws-test",
                billing_plan="free",
            )

        app.dependency_overrides[get_project_access] = mock_access

        pubsub = MockPubSub([])
        mock_redis = MagicMock()
        mock_redis.pubsub.return_value = pubsub

        try:
            mock_service = MagicMock()
            mock_service.get_trace_start_time.return_value = recent_start
            test_client = TestClient(app)
            with (
                patch("rest.routers.live.TRACE_COMPLETE_QUIET_SECONDS", 0.1),
                patch(
                    "rest.routers.live.get_trace_reader_service",
                    return_value=mock_service,
                ),
                patch(
                    "rest.routers.live._completion_state_in_clickhouse",
                    return_value=(_utcnow_naive(), _utcnow_naive()),
                ),
                patch("shared.redis.get_async_redis_client", return_value=mock_redis),
            ):
                resp = test_client.get(ENDPOINT)

            assert resp.status_code == 200
            events = parse_sse_events(resp.text)
            assert "event: trace_complete" in events
        finally:
            app.dependency_overrides.clear()


class TestTimezoneAwareTimestamps:
    """ClickHouse's DateTime64 columns here carry no explicit timezone, and
    the driver does not consistently return naive datetimes for them.
    These mirror TestQuietWindowAnchoring's scenarios with aware and mixed
    naive/aware inputs, proving identical behavior — not just absence of a
    crash — regardless of which of the two values (or both) came back aware.
    """

    def test_regression_both_aware_does_not_500(self, client):
        """The exact shape of the reported incident: both timestamps aware.
        This is the crash-reproduction case — status 200, not 500."""
        pubsub = MockPubSub([])
        mock_redis = MagicMock()
        mock_redis.pubsub.return_value = pubsub

        now_aware = _aware(_utcnow_naive())
        with (
            patch("rest.routers.live.TRACE_COMPLETE_QUIET_SECONDS", 0.1),
            patch(
                "rest.routers.live._completion_state_in_clickhouse",
                return_value=(now_aware, now_aware),
            ),
            patch("shared.redis.get_async_redis_client", return_value=mock_redis),
        ):
            resp = client.get(ENDPOINT)

        assert resp.status_code == 200
        assert parse_sse_events(resp.text) == ["event: trace_complete"]

    def test_both_aware_old_completed_trace_closes_immediately(self, client):
        """Mirrors TestQuietWindowAnchoring.test_old_completed_trace_closes_immediately
        with both timestamps aware instead of naive — same behavior expected."""
        pubsub = MockPubSub([])
        mock_redis = MagicMock()
        mock_redis.pubsub.return_value = pubsub

        stale_root_end = _aware(_utcnow_naive() - timedelta(hours=1))
        with (
            patch("rest.routers.live.TRACE_COMPLETE_QUIET_SECONDS", 30),
            patch(
                "rest.routers.live._completion_state_in_clickhouse",
                return_value=(stale_root_end, stale_root_end),
            ),
            patch("shared.redis.get_async_redis_client", return_value=mock_redis),
        ):
            resp = client.get(ENDPOINT)

        events = parse_sse_events(resp.text)
        assert events == ["event: trace_complete"]
        assert pubsub.get_message_calls == 0

    def test_mixed_root_aware_last_ingest_naive_does_not_crash(self, client):
        """root_end_time aware, last_ingest_time naive — the mixed pair that
        crashes at max() rather than at the subtraction. Root ended long ago
        (aware); spans are still actively arriving (naive, recent) — the
        window must anchor to the recent activity, same as the all-naive
        equivalent in test_old_root_with_recent_activity_keeps_quiet_window."""
        late_batch = redis_message(
            {"type": "spans", "spans": [{"span_id": "late", "trace_id": TRACE_ID}]}
        )
        pubsub = MockPubSub([late_batch])
        mock_redis = MagicMock()
        mock_redis.pubsub.return_value = pubsub

        stale_root_end = _aware(_utcnow_naive() - timedelta(minutes=5))
        with (
            patch("rest.routers.live.TRACE_COMPLETE_QUIET_SECONDS", 0.2),
            patch(
                "rest.routers.live._completion_state_in_clickhouse",
                return_value=(stale_root_end, _utcnow_naive()),
            ),
            patch("shared.redis.get_async_redis_client", return_value=mock_redis),
        ):
            resp = client.get(ENDPOINT)

        events = parse_sse_events(resp.text)
        assert events == ["event: spans", "event: trace_complete"]

    def test_mixed_root_naive_last_ingest_aware_does_not_crash(self, client):
        """The reverse mixed pair: root_end_time naive, last_ingest_time
        aware. Same expected behavior as the previous test — the fix must
        not assume which of the two columns is the one that comes back
        aware, since they are independently typed."""
        late_batch = redis_message(
            {"type": "spans", "spans": [{"span_id": "late", "trace_id": TRACE_ID}]}
        )
        pubsub = MockPubSub([late_batch])
        mock_redis = MagicMock()
        mock_redis.pubsub.return_value = pubsub

        stale_root_end = _utcnow_naive() - timedelta(minutes=5)
        with (
            patch("rest.routers.live.TRACE_COMPLETE_QUIET_SECONDS", 0.2),
            patch(
                "rest.routers.live._completion_state_in_clickhouse",
                return_value=(stale_root_end, _aware(_utcnow_naive())),
            ),
            patch("shared.redis.get_async_redis_client", return_value=mock_redis),
        ):
            resp = client.get(ENDPOINT)

        events = parse_sse_events(resp.text)
        assert events == ["event: spans", "event: trace_complete"]

    def test_both_aware_recently_completed_trace_still_gets_quiet_window(self, client):
        """Mirrors TestQuietWindowAnchoring.test_recently_completed_trace_still_gets_quiet_window
        with both timestamps aware — a root that ended a moment ago still
        keeps the remaining quiet window for late descendant spans."""
        late_batch = redis_message(
            {"type": "spans", "spans": [{"span_id": "late", "trace_id": TRACE_ID}]}
        )
        pubsub = MockPubSub([late_batch])
        mock_redis = MagicMock()
        mock_redis.pubsub.return_value = pubsub

        now_aware = _aware(_utcnow_naive())
        with (
            patch("rest.routers.live.TRACE_COMPLETE_QUIET_SECONDS", 0.2),
            patch(
                "rest.routers.live._completion_state_in_clickhouse",
                return_value=(now_aware, now_aware),
            ),
            patch("shared.redis.get_async_redis_client", return_value=mock_redis),
        ):
            resp = client.get(ENDPOINT)

        events = parse_sse_events(resp.text)
        assert events == ["event: spans", "event: trace_complete"]

    def test_aware_non_utc_offset_is_converted_not_blindly_stripped(self, client):
        """A blind `.replace(tzinfo=None)` strip (instead of a real
        `.astimezone(UTC)` conversion) would misread this +05:30-offset
        timestamp's local digits as UTC, shifting the represented instant
        5.5 hours into the future — making a trace that actually completed
        an hour ago look like it hasn't gone stale yet, so the stream would
        NOT close immediately and would instead poll for messages.
        Correctly converted, this is the same instant as the existing
        test_old_completed_trace_closes_immediately case: closes at once."""
        pubsub = MockPubSub([])
        mock_redis = MagicMock()
        mock_redis.pubsub.return_value = pubsub

        stale_root_end = _aware_offset(_utcnow_naive() - timedelta(hours=1), hours=5.5)
        with (
            patch("rest.routers.live.TRACE_COMPLETE_QUIET_SECONDS", 30),
            patch(
                "rest.routers.live._completion_state_in_clickhouse",
                return_value=(stale_root_end, stale_root_end),
            ),
            patch("shared.redis.get_async_redis_client", return_value=mock_redis),
        ):
            resp = client.get(ENDPOINT)

        events = parse_sse_events(resp.text)
        assert events == ["event: trace_complete"]
        # Correctly stale by 1 hour -> deadline already expired on arrival,
        # closed without a single poll. A blind strip would have placed the
        # (misread) instant in the future, leaving age clamped to 0 and the
        # full quiet window still open -- this would poll at least once.
        assert pubsub.get_message_calls == 0

    def test_root_aware_none_last_ingest_falls_back_correctly(self, client):
        """root_end_time aware, last_ingest_time is None: the `last_ingest_time
        or root_end_time` fallback must use the already-normalized
        root_end_time, not the raw aware value."""
        pubsub = MockPubSub([])
        mock_redis = MagicMock()
        mock_redis.pubsub.return_value = pubsub

        stale_root_end = _aware(_utcnow_naive() - timedelta(hours=1))
        with (
            patch("rest.routers.live.TRACE_COMPLETE_QUIET_SECONDS", 30),
            patch(
                "rest.routers.live._completion_state_in_clickhouse",
                return_value=(stale_root_end, None),
            ),
            patch("shared.redis.get_async_redis_client", return_value=mock_redis),
        ):
            resp = client.get(ENDPOINT)

        events = parse_sse_events(resp.text)
        assert events == ["event: trace_complete"]
        assert pubsub.get_message_calls == 0
