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
    REPORTING_STARTED_AT,
    record_tracking_start,
    report_trace_activity,
    schedule_trace_activity_report,
)

ROOT = Path(__file__).resolve().parents[2]
INTERNAL_ROUTES = ROOT / "frontend/ui/src/app/api/internal"
EXAMPLE_REPORT = INTERNAL_ROUTES / "trace-activity/request.example.json"
EXAMPLE_START_NOTICE = INTERNAL_ROUTES / "first-trace-tracking/request.example.json"
REPORT_URL = "http://web.test/api/internal/trace-activity"
START_URL = "http://web.test/api/internal/first-trace-tracking"
NOON = datetime(2026, 11, 18, 12, 0, tzinfo=UTC)
DAY = "2026-11-18"
KEY = f"trace-activity:proj-1:{DAY}"
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


def frozen_clock(monkeypatch, now):
    """Make the module's ``datetime.now`` answer ``now``."""

    class Frozen(datetime):
        @classmethod
        def now(cls, tz=None):
            return now if tz is None else now.astimezone(tz)

    monkeypatch.setattr(trace_activity, "datetime", Frozen)


@pytest.fixture(autouse=True)
def configured(monkeypatch):
    monkeypatch.setattr(settings, "internal_api_secret", "test-secret")
    monkeypatch.setattr(settings, "traceroot_ui_url", "http://web.test")
    # Each test starts as a fresh worker process that has not told the web app its start.
    monkeypatch.setattr(trace_activity, "_tracking_start_recorded", False)


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
    """Stand-in for the web app: records each POST and answers it.

    ``web.answer`` answers the reports, ``web.start_answer`` the start notices; an
    exception is raised instead of answering, and a list is answered in turn.
    """
    web = SimpleNamespace(calls=[], answer=200, start_answer=200)

    def post(url, json=None, headers=None, timeout=None):
        web.calls.append({"url": url, "json": json, "headers": headers, "timeout": timeout})
        answer = web.start_answer if url == START_URL else web.answer
        if isinstance(answer, list):
            answer = answer.pop(0)
        if isinstance(answer, Exception):
            raise answer
        return httpx.Response(answer, request=httpx.Request("POST", url))

    web.reports = lambda: [call for call in web.calls if call["url"] == REPORT_URL]
    web.start_notices = lambda: [call for call in web.calls if call["url"] == START_URL]
    monkeypatch.setattr(trace_activity.httpx, "post", post)
    return web


@pytest.fixture()
def attempt(monkeypatch, redis_store):
    """Run one attempt of the report task, as retry number ``retries``."""
    monkeypatch.setattr(
        report_trace_activity, "retry", lambda countdown: RetryScheduledError(countdown)
    )

    def run(retries=0, *args):
        report_trace_activity.push_request(retries=retries)
        try:
            return report_trace_activity.run("proj-1", KEY, TOKEN, *(args or (DAY,)))
        finally:
            report_trace_activity.pop_request()

    redis_store.values[KEY] = TOKEN  # the claim schedule_trace_activity_report took
    return run


class TestScheduleTraceActivityReport:
    def test_queues_one_report_per_project_per_utc_day(self, redis_store, queued):
        schedule_trace_activity_report("proj-1", received_at=NOON)
        schedule_trace_activity_report(
            "proj-1", received_at=datetime(2026, 11, 18, 23, 59, tzinfo=UTC)
        )

        [args] = queued
        assert args == ["proj-1", KEY, redis_store.values[KEY], DAY]
        assert redis_store.ttls[KEY] == CLAIM_TTL_SECONDS

    def test_queues_again_on_the_next_utc_day(self, redis_store, queued):
        schedule_trace_activity_report(
            "proj-1", received_at=datetime(2026, 11, 18, 23, 59, tzinfo=UTC)
        )
        schedule_trace_activity_report(
            "proj-1", received_at=datetime(2026, 11, 19, 0, 1, tzinfo=UTC)
        )

        assert [(args[1], args[3]) for args in queued] == [
            (KEY, DAY),
            ("trace-activity:proj-1:2026-11-19", "2026-11-19"),
        ]

    def test_reports_the_day_the_batch_was_received_not_the_day_it_is_processed(
        self, monkeypatch, redis_store, queued
    ):
        # The API received the batch ten seconds before midnight; it waited in the
        # queue, and the worker processes it after midnight.
        frozen_clock(monkeypatch, datetime(2026, 11, 18, 0, 0, 30, tzinfo=UTC))

        schedule_trace_activity_report(
            "proj-1", received_at=datetime(2026, 11, 17, 23, 59, 50, tzinfo=UTC)
        )

        [args] = queued
        assert args[1] == "trace-activity:proj-1:2026-11-17"
        assert args[3] == "2026-11-17"

    def test_reads_a_receive_time_without_an_offset_as_utc(self, redis_store, queued):
        schedule_trace_activity_report("proj-1", received_at=datetime(2026, 11, 17, 23, 59, 50))

        [args] = queued
        assert args[3] == "2026-11-17"

    def test_a_batch_without_a_receive_time_counts_the_day_it_is_processed(
        self, monkeypatch, redis_store, queued
    ):
        frozen_clock(monkeypatch, NOON)

        schedule_trace_activity_report("proj-1")

        [args] = queued
        assert args[1] == KEY
        assert args[3] == DAY

    def test_skips_a_project_already_reported_that_day(self, redis_store, queued):
        redis_store.values[KEY] = REPORTED

        schedule_trace_activity_report("proj-1", received_at=NOON)

        assert queued == []

    def test_releases_the_claim_when_queuing_fails(self, monkeypatch, redis_store):
        def broken(args):
            raise ConnectionError("broker down")

        monkeypatch.setattr(report_trace_activity, "apply_async", broken)

        schedule_trace_activity_report("proj-1", received_at=NOON)  # must not raise

        assert redis_store.values == {}

    def test_is_skipped_without_the_internal_secret(self, monkeypatch, queued):
        monkeypatch.setattr(settings, "internal_api_secret", "")
        connected = []
        monkeypatch.setattr(
            trace_activity.redis_lib, "from_url", lambda *a, **kw: connected.append(1)
        )

        schedule_trace_activity_report("proj-1", received_at=NOON)

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

        schedule_trace_activity_report("proj-1", received_at=NOON)

        assert queued == []


class TestReportTraceActivity:
    def test_sends_the_request_the_web_app_tests_against(self, attempt, web):
        attempt()

        [call] = web.reports()
        expected = json.loads(EXAMPLE_REPORT.read_text())
        assert sorted(call["json"]) == sorted(expected)
        assert call["json"] == {"projectId": "proj-1", "day": DAY}
        assert call["headers"] == {"X-Internal-Secret": "test-secret"}
        assert call["timeout"] == 5.0

    def test_marks_the_day_reported_once_the_web_app_accepts(self, attempt, web, redis_store):
        attempt()

        assert redis_store.values[KEY] == REPORTED
        assert redis_store.ttls[KEY] == REPORTED_TTL_SECONDS

    def test_a_retry_after_midnight_still_reports_the_day_the_batch_was_received(
        self, monkeypatch, attempt, web
    ):
        frozen_clock(monkeypatch, datetime(2026, 11, 17, 23, 59, 55, tzinfo=UTC))
        web.answer = 503
        with pytest.raises(RetryScheduledError):
            attempt(0, "2026-11-17")

        frozen_clock(monkeypatch, datetime(2026, 11, 18, 0, 0, 55, tzinfo=UTC))
        web.answer = 200
        attempt(1, "2026-11-17")

        assert [call["json"]["day"] for call in web.reports()] == ["2026-11-17", "2026-11-17"]

    def test_a_task_queued_without_a_day_leaves_the_day_to_the_web_app(self, redis_store, web):
        # A task queued before reports carried the day: the web app counts the day
        # the report arrives, as it did then.
        redis_store.values[KEY] = TOKEN
        report_trace_activity.push_request(retries=0)
        try:
            report_trace_activity.run("proj-1", KEY, TOKEN)
        finally:
            report_trace_activity.pop_request()

        [call] = web.reports()
        assert call["json"] == {"projectId": "proj-1"}

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

        assert len(web.reports()) == 2
        assert redis_store.values[KEY] == REPORTED

    @pytest.mark.parametrize("status", [400, 403, 404])
    def test_a_refused_report_is_not_retried_and_its_claim_lapses_soon(
        self, attempt, web, redis_store, status
    ):
        web.answer = status

        attempt()

        assert len(web.reports()) == 1
        assert redis_store.values[KEY] == TOKEN
        assert redis_store.ttls[KEY] == REFUSED_TTL_SECONDS


class TestReportingStart:
    """The cutoff: the worker tells the web app when it started reporting, before any report."""

    def test_records_the_start_before_the_first_report_and_only_once(self, attempt, web):
        attempt()
        attempt()

        assert [call["url"] for call in web.calls] == [START_URL, REPORT_URL, REPORT_URL]
        [notice] = web.start_notices()
        assert notice["json"] == {"startedAt": REPORTING_STARTED_AT.isoformat()}
        assert notice["headers"] == {"X-Internal-Secret": "test-secret"}
        assert notice["timeout"] == 5.0

    def test_sends_the_notice_the_web_app_tests_against(self, web):
        assert record_tracking_start() is True

        [notice] = web.start_notices()
        expected = json.loads(EXAMPLE_START_NOTICE.read_text())
        assert sorted(notice["json"]) == sorted(expected)
        # Both are ISO-8601 with an offset, which the web app requires.
        assert datetime.fromisoformat(notice["json"]["startedAt"]).utcoffset() is not None
        assert datetime.fromisoformat(expected["startedAt"]).utcoffset() is not None

    @pytest.mark.parametrize(
        "answer",
        [httpx.ConnectError("web app down"), 503, 404],
        ids=["unreachable", "503", "an older web app without the route"],
    )
    def test_sends_no_report_until_the_start_is_recorded(self, attempt, web, redis_store, answer):
        web.start_answer = answer

        with pytest.raises(RetryScheduledError) as retry:
            attempt()

        assert web.reports() == []
        assert retry.value.countdown == 60
        assert redis_store.values[KEY] == TOKEN

        web.start_answer = 200
        attempt(retries=1)

        assert [call["url"] for call in web.calls][-2:] == [START_URL, REPORT_URL]
        assert redis_store.values[KEY] == REPORTED

    def test_gives_the_claim_up_when_the_start_is_never_recorded(self, attempt, web, redis_store):
        web.start_answer = 503

        attempt(retries=MAX_RETRIES)  # no retry left: returns, does not raise

        assert web.reports() == []
        assert KEY not in redis_store.values

    def test_a_409_records_the_start_again_and_sends_the_report_once_more(
        self, attempt, web, redis_store
    ):
        # The web app has lost its cutoff: the report changed nothing there.
        attempt()
        redis_store.values[KEY] = TOKEN  # the next report's claim
        web.answer = [409, 200]

        attempt()

        assert [call["url"] for call in web.calls] == [
            START_URL,
            REPORT_URL,
            REPORT_URL,
            START_URL,
            REPORT_URL,
        ]
        assert redis_store.values[KEY] == REPORTED

    def test_a_409_is_retried_when_the_start_cannot_be_recorded_again(
        self, attempt, web, redis_store
    ):
        attempt()
        redis_store.values[KEY] = TOKEN
        web.answer = 409
        web.start_answer = 503

        with pytest.raises(RetryScheduledError):
            attempt()

        assert redis_store.values[KEY] == TOKEN
        web.answer = 200
        web.start_answer = 200
        attempt(retries=1)
        # The retry records the start before it reports.
        assert [call["url"] for call in web.calls][-2:] == [START_URL, REPORT_URL]
        assert redis_store.values[KEY] == REPORTED

    def test_is_not_sent_without_the_internal_secret(self, monkeypatch, web):
        monkeypatch.setattr(settings, "internal_api_secret", "")

        assert record_tracking_start() is False
        assert web.calls == []

    def test_the_worker_records_its_start_as_it_starts(self, web):
        from worker.celery_app import record_reporting_start

        record_reporting_start()

        assert len(web.start_notices()) == 1

    def test_a_failed_notice_as_the_worker_starts_does_not_stop_it(self, web):
        from worker.celery_app import record_reporting_start

        web.start_answer = httpx.ConnectError("web app down")

        record_reporting_start()  # must not raise

        assert len(web.start_notices()) == 1
