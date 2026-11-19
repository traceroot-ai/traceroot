"""An ingest attempt redelivered after its worker process died is refused past
INGEST_MAX_DELIVERIES, which fails the attempt like any other error: it is retried with
backoff, and quarantined when the retries run out, instead of being redelivered without
limit.

``celery_app`` sets ``task_acks_late`` and ``task_reject_on_worker_lost``, so Celery
requeues an attempt whose worker process was killed (``WorkerLostError``) and delivers it
again, flagged ``redelivered``, under the same task id and retry number. A batch that
kills the process every time, as an OOM kill does, then loops without limit: on Celery
5.6.2 and Redis 7 with this app's settings, one such batch was delivered 291 times in 60 s
and never quarantined.

Each ``deliver()`` runs the real task through Celery's worker-mode tracer (the code a
worker child runs: autoretry, failure handling, ``on_failure``) with the request a
redelivery carries. A process that died leaves its count in the broker's Redis because it
never finished; ``died()`` seeds those counts. Redis is an in-memory stand-in reached the
way the worker reaches it.
"""

from unittest.mock import MagicMock

import pytest
from celery.app.trace import build_tracer

from shared.config import settings
from worker import ingest_quarantine
from worker.delivery_guard import RedeliveryLimitError
from worker.ingest_tasks import process_s3_traces

BATCH_KEY = "events/ingest/proj-1/2026/11/10/12/batch.pb"
FAILED_KEY = "events/failed/proj-1/2026/11/10/12/batch.pb"
TASK_KWARGS = {"s3_key": BATCH_KEY, "project_id": "proj-1"}
LIMIT = settings.ingest.max_deliveries
LAST = process_s3_traces.max_retries  # the retry number Celery does not retry again


class FakeRedis:
    """INCR / EXPIRE in a MULTI pipeline, DEL and close: all the delivery count uses."""

    def __init__(self):
        self.values: dict[str, int] = {}
        self.used = False
        self.fail = False

    def _touch(self):
        self.used = True
        if self.fail:
            raise ConnectionError("redis unreachable")

    def delete(self, key):
        self._touch()
        self.values.pop(key, None)

    def close(self):
        pass

    def pipeline(self):
        redis, ops = self, []

        class Pipe:
            def incr(self, key):
                ops.append(key)

            def expire(self, key, seconds):
                pass

            def execute(self):
                redis._touch()
                out = []
                for key in ops:
                    redis.values[key] = redis.values.get(key, 0) + 1
                    out.append(redis.values[key])
                return out + [True] * len(ops)

        return Pipe()


@pytest.fixture()
def broker(monkeypatch):
    fake = FakeRedis()
    monkeypatch.setattr("redis.Redis.from_url", lambda *a, **k: fake)
    return fake


def key(task_id: str = "task-1", retries: int = 0) -> str:
    return f"ingest:deliveries:{task_id}:{retries}"


def died(broker: FakeRedis, redeliveries: int, task_id: str = "task-1", retries: int = 0) -> None:
    """The count left by a first delivery and ``redeliveries`` more whose processes died."""
    broker.values[key(task_id, retries)] = redeliveries


@pytest.fixture()
def s3(mock_s3, monkeypatch):
    mock_s3.download_bytes.return_value = b""  # an empty batch: nothing to insert
    # No result store. ``_backend``, not the ``backend`` property: undoing the property
    # would pin the app's backend on the task for the rest of the session.
    monkeypatch.setattr(process_s3_traces, "_backend", MagicMock())
    return mock_s3


@pytest.fixture()
def retried(monkeypatch):
    """The retry a failed attempt publishes (Task.retry sends it through apply_async)."""
    publish = MagicMock()
    monkeypatch.setattr(process_s3_traces, "apply_async", publish)
    return publish


@pytest.fixture()
def quarantined(monkeypatch):
    counter = MagicMock()
    monkeypatch.setattr(ingest_quarantine, "_quarantined_counter", counter)
    return counter


def deliver(*, redelivered: bool, task_id: str = "task-1", retries: int = 0):
    """One delivery as a worker child traces it; returns (state, exception or None)."""
    trace = build_tracer(
        process_s3_traces.name,
        process_s3_traces,
        app=process_s3_traces.app,
        eager=False,
        store_errors=False,
    )
    request = {
        "id": task_id,
        "retries": retries,
        "delivery_info": {"redelivered": redelivered, "exchange": "", "routing_key": "celery"},
    }
    out = trace(task_id, [], dict(TASK_KWARGS), request)
    if out.info is None:
        return "SUCCESS", None
    return out.info.state, out.info.retval


class TestRedeliveredAttempt:
    def test_past_the_limit_a_redelivery_fails_its_attempt_which_is_retried(
        self, broker, s3, retried, quarantined
    ):
        died(broker, LIMIT - 1)

        state, retry = deliver(redelivered=True)

        assert state == "RETRY"
        assert isinstance(retry.exc, RedeliveryLimitError)
        s3.download_bytes.assert_not_called()  # refused before any work
        retried.assert_called_once()
        assert retried.call_args.args[1] == TASK_KWARGS
        assert retried.call_args.kwargs["retries"] == 1  # a new attempt, counted afresh
        s3.copy_object.assert_not_called()
        quarantined.add.assert_not_called()

    def test_on_the_last_attempt_a_refused_redelivery_is_quarantined_once(
        self, broker, s3, retried, quarantined
    ):
        died(broker, LIMIT - 1, retries=LAST)

        state, exc = deliver(redelivered=True, retries=LAST)

        assert state == "FAILURE"
        assert isinstance(exc, RedeliveryLimitError)
        s3.download_bytes.assert_not_called()
        retried.assert_not_called()
        s3.copy_object.assert_called_once_with(BATCH_KEY, FAILED_KEY)
        s3.delete_object.assert_called_once_with(BATCH_KEY)
        quarantined.add.assert_called_once_with(1, {})

    def test_a_refused_attempt_redelivered_again_is_refused_at_once(self, broker, s3, retried):
        """If the refused delivery's process dies too, its count is still there."""
        died(broker, LIMIT - 1)
        deliver(redelivered=True)

        state, _ = deliver(redelivered=True)

        assert state == "RETRY"
        s3.download_bytes.assert_not_called()

    def test_within_the_limit_a_redelivery_is_processed_and_clears_its_count(self, broker, s3):
        """A deploy that kills a worker mid-batch must not cost the batch."""
        died(broker, LIMIT - 2)

        assert deliver(redelivered=True) == ("SUCCESS", None)
        s3.download_bytes.assert_called_once()
        s3.copy_object.assert_not_called()
        assert key() not in broker.values

    def test_a_first_delivery_never_touches_redis(self, broker, s3):
        broker.fail = True
        assert deliver(redelivered=False) == ("SUCCESS", None)
        assert broker.used is False

    def test_a_redelivery_that_fails_in_its_process_clears_its_count(self, broker, s3):
        s3.download_bytes.side_effect = RuntimeError("corrupt batch")
        state, exc = deliver(redelivered=True, retries=process_s3_traces.max_retries)
        assert (state, str(exc)) == ("FAILURE", "corrupt batch")
        assert broker.values == {}

    def test_a_retry_is_a_new_attempt_with_its_own_count(self, broker, s3):
        died(broker, LIMIT + 5, retries=0)
        assert deliver(redelivered=True, retries=1) == ("SUCCESS", None)

    def test_other_batches_are_not_affected(self, broker, s3):
        died(broker, LIMIT + 5, task_id="poison")
        assert deliver(redelivered=True, task_id="healthy") == ("SUCCESS", None)

    def test_without_redis_a_redelivery_is_processed_as_before(self, broker, s3, caplog):
        died(broker, LIMIT + 5)
        broker.fail = True
        assert deliver(redelivered=True) == ("SUCCESS", None)
        assert "Could not count the redeliveries" in caplog.text
