"""Unit tests for the ingest worker's trace-activity report to the web app."""

import json
from datetime import UTC, datetime
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest

from shared.config import settings
from worker import trace_activity
from worker.trace_activity import (
    CLAIM_TTL_SECONDS,
    MAX_RETRIES,
    REFUSED_TTL_SECONDS,
    REPORTED,
    REPORTED_TTL_SECONDS,
    report_trace_activity,
    schedule_trace_activity_report,
)

ROOT = Path(__file__).resolve().parents[2]
EXAMPLE_REQUEST = ROOT / "frontend/ui/src/app/api/internal/trace-activity/request.example.json"
NOON = datetime(2026, 11, 18, 12, 0, tzinfo=UTC)
KEY = "trace-activity:proj-1:2026-11-18"
TOKEN = "this-report"


class FakeRedis:
    """The Redis calls the report makes: SET NX EX, and the token-checked scripts."""

    def __init__(self):
        self.values: dict[str, str] = {}
        self.ttls: dict[str, int] = {}

    def set(self, key, value, nx=False, ex=None):
        if nx and key in self.values:
            return None
        self.values[key] = value
        self.ttls[key] = ex
        return True

    def eval(self, script, numkeys, key, token, *args):
        if self.values.get(key) != token:
            return 0
        if "EXPIRE" in script:
            self.ttls[key] = int(args[0])
        else:
            del self.values[key]
        return 1

    def close(self):
        pass


class RetryScheduledError(Exception):
    def __init__(self, countdown):
        self.countdown = countdown


@pytest.fixture(autouse=True)
def configured(monkeypatch):
    monkeypatch.setattr(settings, "internal_api_secret", "test-secret")
    monkeypatch.setattr(settings, "traceroot_ui_url", "http://web.test")


@pytest.fixture()
def redis_store(monkeypatch):
    store = FakeRedis()
    monkeypatch.setattr(trace_activity.redis_lib, "from_url", lambda *a, **kw: store)
    return store


@pytest.fixture()
def queued(monkeypatch):
    """The report tasks queued, as (args) lists."""
    calls = []
    monkeypatch.setattr(report_trace_activity, "apply_async", lambda args: calls.append(args))
    return calls


@pytest.fixture()
def web(monkeypatch):
    """Stand-in for the web app: records each POST and answers with ``web.answer``."""
    web = SimpleNamespace(calls=[], answer=200)

    def post(url, json=None, headers=None, timeout=None):
        web.calls.append({"url": url, "json": json, "headers": headers, "timeout": timeout})
        if isinstance(web.answer, Exception):
            raise web.answer
        return httpx.Response(web.answer, request=httpx.Request("POST", url))

    monkeypatch.setattr(trace_activity.httpx, "post", post)
    return web


@pytest.fixture()
def attempt(monkeypatch, redis_store):
    """Run one attempt of the report task, as retry number ``retries``."""
    monkeypatch.setattr(
        report_trace_activity, "retry", lambda countdown: RetryScheduledError(countdown)
    )

    def run(retries=0):
        report_trace_activity.push_request(retries=retries)
        try:
            return report_trace_activity.run("proj-1", KEY, TOKEN)
        finally:
            report_trace_activity.pop_request()

    redis_store.values[KEY] = TOKEN  # the claim schedule_trace_activity_report took
    return run


class TestScheduleTraceActivityReport:
    def test_queues_one_report_per_project_per_utc_day(self, redis_store, queued):
        schedule_trace_activity_report("proj-1", now=NOON)
        schedule_trace_activity_report("proj-1", now=datetime(2026, 11, 18, 23, 59, tzinfo=UTC))

        [args] = queued
        assert args[:2] == ["proj-1", KEY]
        assert redis_store.values[KEY] == args[2]
        assert redis_store.ttls[KEY] == CLAIM_TTL_SECONDS

    def test_queues_again_on_the_next_utc_day(self, redis_store, queued):
        schedule_trace_activity_report("proj-1", now=datetime(2026, 11, 18, 23, 59, tzinfo=UTC))
        schedule_trace_activity_report("proj-1", now=datetime(2026, 11, 19, 0, 1, tzinfo=UTC))

        assert [args[1] for args in queued] == [KEY, "trace-activity:proj-1:2026-11-19"]

    def test_skips_a_project_already_reported_today(self, redis_store, queued):
        redis_store.values[KEY] = REPORTED

        schedule_trace_activity_report("proj-1", now=NOON)

        assert queued == []

    def test_releases_the_claim_when_queuing_fails(self, monkeypatch, redis_store):
        def broken(args):
            raise ConnectionError("broker down")

        monkeypatch.setattr(report_trace_activity, "apply_async", broken)

        schedule_trace_activity_report("proj-1", now=NOON)  # must not raise

        assert redis_store.values == {}

    def test_is_skipped_without_the_internal_secret(self, monkeypatch, queued):
        monkeypatch.setattr(settings, "internal_api_secret", "")
        connected = []
        monkeypatch.setattr(
            trace_activity.redis_lib, "from_url", lambda *a, **kw: connected.append(1)
        )

        schedule_trace_activity_report("proj-1", now=NOON)

        assert connected == []
        assert queued == []

    @pytest.mark.parametrize("failure", ["connect", "set"])
    def test_redis_failure_queues_nothing_and_does_not_raise(self, monkeypatch, queued, failure):
        class DownRedis(FakeRedis):
            def set(self, *args, **kwargs):
                raise ConnectionError("redis down")

        def from_url(*args, **kwargs):
            if failure == "connect":
                raise ConnectionError("redis down")
            return DownRedis()

        monkeypatch.setattr(trace_activity.redis_lib, "from_url", from_url)

        schedule_trace_activity_report("proj-1", now=NOON)

        assert queued == []


class TestReportTraceActivity:
    def test_sends_the_request_the_web_app_tests_against(self, attempt, web):
        attempt()

        [call] = web.calls
        expected = json.loads(EXAMPLE_REQUEST.read_text())
        assert sorted(call["json"]) == sorted(expected)
        assert call["json"] == {"projectId": "proj-1"}
        assert call["url"] == "http://web.test/api/internal/trace-activity"
        assert call["headers"] == {"X-Internal-Secret": "test-secret"}
        assert call["timeout"] == 5.0

    def test_marks_the_day_reported_once_the_web_app_accepts(self, attempt, web, redis_store):
        attempt()

        assert redis_store.values[KEY] == REPORTED
        assert redis_store.ttls[KEY] == REPORTED_TTL_SECONDS

    @pytest.mark.parametrize(
        "answer",
        [httpx.ConnectError("web app down"), httpx.ReadTimeout("too slow"), 503, 429],
        ids=["unreachable", "timeout", "503", "429"],
    )
    def test_retries_a_failure_that_may_clear_up_and_holds_the_claim(
        self, attempt, web, redis_store, answer
    ):
        web.answer = answer

        with pytest.raises(RetryScheduledError) as retry:
            attempt()

        assert retry.value.countdown == 60
        assert redis_store.values[KEY] == TOKEN
        assert redis_store.ttls[KEY] == 60 + CLAIM_TTL_SECONDS

    @pytest.mark.parametrize("retries, countdown", [(1, 120), (3, 480), (5, 1800), (19, 1800)])
    def test_backs_off_up_to_half_an_hour(self, attempt, web, retries, countdown):
        web.answer = 503

        with pytest.raises(RetryScheduledError) as retry:
            attempt(retries=retries)

        assert retry.value.countdown == countdown

    def test_releases_the_claim_after_the_last_retry(self, attempt, web, redis_store):
        web.answer = 503

        attempt(retries=MAX_RETRIES)  # no retry left: returns, does not raise

        assert KEY not in redis_store.values

    def test_a_retry_after_a_lost_response_completes_the_report(self, attempt, web, redis_store):
        # The web app handled the first attempt but its answer never arrived.
        web.answer = httpx.ReadError("connection reset")
        with pytest.raises(RetryScheduledError):
            attempt()

        web.answer = 200
        attempt(retries=1)

        assert len(web.calls) == 2
        assert redis_store.values[KEY] == REPORTED

    @pytest.mark.parametrize("status", [400, 403, 404])
    def test_a_refused_report_is_not_retried_and_its_claim_lapses_soon(
        self, attempt, web, redis_store, status
    ):
        web.answer = status

        attempt()

        assert len(web.calls) == 1
        assert redis_store.values[KEY] == TOKEN
        assert redis_store.ttls[KEY] == REFUSED_TTL_SECONDS
