"""Quarantine of ingest batches that failed every attempt."""

import logging
from unittest.mock import MagicMock, call

import pytest

from worker import ingest_quarantine
from worker.celery_app import app
from worker.ingest_quarantine import failed_key_for, quarantine_batch
from worker.ingest_tasks import _quarantine_on_failure, process_s3_traces

# A batch staged as the raw request body, and one stored as decoded JSON.
RAW_BATCH_KEY = "events/ingest/proj-1/2026/10/29/12/batch.pb.gz"
RAW_FAILED_KEY = "events/failed/proj-1/2026/10/29/12/batch.pb.gz"
BATCH_KEY = "events/otel/proj-1/2026/10/29/12/batch.json"
FAILED_KEY = "events/failed/proj-1/2026/10/29/12/batch.json"
TASK_KWARGS = {"s3_key": BATCH_KEY, "project_id": "proj-1"}


class PermanentError(Exception):
    """An error the test task below lists in ``dont_autoretry_for``."""


@app.task(
    bind=True,
    name="tests.worker.task_with_a_permanent_error",
    autoretry_for=(Exception,),
    dont_autoretry_for=(PermanentError,),
    max_retries=5,
    on_failure=_quarantine_on_failure,
)
def never_retried_task(self, s3_key, project_id):
    from rest.services.s3 import get_s3_service

    get_s3_service().download_json(s3_key)


@pytest.fixture()
def counters(monkeypatch):
    quarantined = MagicMock()
    failed = MagicMock()
    monkeypatch.setattr(ingest_quarantine, "_quarantined_counter", quarantined)
    monkeypatch.setattr(ingest_quarantine, "_quarantine_failed_counter", failed)
    return quarantined, failed


class TestFailedKeyFor:
    @pytest.mark.parametrize(
        ("key", "failed_key"),
        [(RAW_BATCH_KEY, RAW_FAILED_KEY), (BATCH_KEY, FAILED_KEY)],
        ids=["events-ingest", "events-otel"],
    )
    def test_swaps_the_ingest_prefix(self, key, failed_key):
        assert failed_key_for(key) == failed_key

    @pytest.mark.parametrize(
        "key",
        [
            FAILED_KEY,
            RAW_FAILED_KEY,
            "attachments/proj-1/sha256/" + "a" * 64,
            "events/otelx/proj-1/batch.json",
            "events/ingestx/proj-1/batch.pb.gz",
            "events/proj-1/batch.pb.gz",
            "other/events/otel/proj-1/batch.json",
            "other/events/ingest/proj-1/batch.pb.gz",
            "test/key.json",
        ],
    )
    def test_keys_outside_the_ingest_prefixes_are_not_mapped(self, key):
        assert failed_key_for(key) is None


class TestQuarantineBatch:
    @pytest.mark.parametrize(
        ("key", "failed_key"),
        [(RAW_BATCH_KEY, RAW_FAILED_KEY), (BATCH_KEY, FAILED_KEY)],
        ids=["events-ingest", "events-otel"],
    )
    def test_copies_then_deletes_and_counts(self, counters, key, failed_key):
        quarantined, failed = counters
        s3 = MagicMock()

        quarantine_batch(s3, key)

        assert s3.mock_calls == [
            call.copy_object(key, failed_key),
            call.delete_object(key),
        ]
        quarantined.add.assert_called_once_with(1, {})
        failed.add.assert_not_called()

    def test_copy_failure_keeps_the_original(self, counters, caplog):
        quarantined, failed = counters
        s3 = MagicMock()
        s3.copy_object.side_effect = RuntimeError("copy refused")

        with caplog.at_level(logging.ERROR, logger="worker.ingest_quarantine"):
            quarantine_batch(s3, BATCH_KEY)

        s3.copy_object.assert_called_once_with(BATCH_KEY, FAILED_KEY)
        s3.delete_object.assert_not_called()
        failed.add.assert_called_once_with(1, {"stage": "copy"})
        quarantined.add.assert_not_called()
        assert BATCH_KEY in caplog.text
        assert FAILED_KEY in caplog.text

    def test_delete_failure_still_counts_the_copy(self, counters, caplog):
        quarantined, failed = counters
        s3 = MagicMock()
        s3.delete_object.side_effect = RuntimeError("delete refused")

        with caplog.at_level(logging.ERROR, logger="worker.ingest_quarantine"):
            quarantine_batch(s3, BATCH_KEY)

        s3.copy_object.assert_called_once_with(BATCH_KEY, FAILED_KEY)
        s3.delete_object.assert_called_once_with(BATCH_KEY)
        quarantined.add.assert_called_once_with(1, {})
        failed.add.assert_called_once_with(1, {"stage": "delete"})
        assert "could not delete the original" in caplog.text

    def test_key_outside_the_ingest_prefixes_is_never_moved(self, counters, caplog):
        quarantined, failed = counters
        s3 = MagicMock()

        with caplog.at_level(logging.WARNING, logger="worker.ingest_quarantine"):
            quarantine_batch(s3, "test/key.json")

        assert s3.mock_calls == []
        quarantined.add.assert_not_called()
        failed.add.assert_not_called()
        assert "outside events/ingest/ and events/otel/" in caplog.text

    @pytest.mark.parametrize("key", [FAILED_KEY, RAW_FAILED_KEY], ids=["json", "pb.gz"])
    def test_key_already_under_events_failed_is_never_moved(self, counters, key):
        quarantined, failed = counters
        s3 = MagicMock()

        quarantine_batch(s3, key)

        assert s3.mock_calls == []
        quarantined.add.assert_not_called()
        failed.add.assert_not_called()

    def test_runs_without_counters(self, monkeypatch):
        monkeypatch.setattr(ingest_quarantine, "_quarantined_counter", None)
        monkeypatch.setattr(ingest_quarantine, "_quarantine_failed_counter", None)
        s3 = MagicMock()
        s3.delete_object.side_effect = RuntimeError("delete refused")

        quarantine_batch(s3, BATCH_KEY)

        assert s3.mock_calls == [
            call.copy_object(BATCH_KEY, FAILED_KEY),
            call.delete_object(BATCH_KEY),
        ]


def test_counters_are_built_from_the_otel_api():
    assert ingest_quarantine._quarantined_counter is not None
    assert ingest_quarantine._quarantine_failed_counter is not None


class TestProcessS3TracesFinalAttempt:
    """The task quarantines only on the attempt Celery will not retry.

    ``apply()`` runs the task eagerly through Celery's own autoretry, retry()
    and failure handling, recursing into each retry, so these tests exercise
    the real give-up point and the task's ``on_failure`` hook.
    """

    @pytest.fixture()
    def s3(self, monkeypatch):
        mock = MagicMock()
        mock.download_json.side_effect = RuntimeError("corrupt batch")
        monkeypatch.setattr("rest.services.s3.get_s3_service", lambda: mock)
        return mock

    @pytest.fixture()
    def quarantine_attempts(self, monkeypatch):
        """Record request.retries for each attempt that calls quarantine_batch."""
        attempts: list[int] = []

        def fake_quarantine(s3_service, s3_key):
            attempts.append(process_s3_traces.request.retries)

        monkeypatch.setattr(ingest_quarantine, "quarantine_batch", fake_quarantine)
        return attempts

    def test_every_retry_failing_quarantines_once_on_the_last(self, s3, quarantine_attempts):
        result = process_s3_traces.apply(kwargs=TASK_KWARGS, throw=False)

        assert s3.download_json.call_count == process_s3_traces.max_retries + 1
        assert quarantine_attempts == [process_s3_traces.max_retries]
        assert result.state == "FAILURE"
        assert str(result.result) == "corrupt batch"

    def test_error_celery_never_retries_is_quarantined_on_its_only_attempt(self, s3, counters):
        quarantined, _ = counters
        s3.download_json.side_effect = PermanentError("unreadable batch")

        result = never_retried_task.apply(kwargs=TASK_KWARGS, throw=False)

        assert s3.download_json.call_count == 1
        s3.copy_object.assert_called_once_with(BATCH_KEY, FAILED_KEY)
        s3.delete_object.assert_called_once_with(BATCH_KEY)
        quarantined.add.assert_called_once_with(1, {})
        assert result.state == "FAILURE"
        assert str(result.result) == "unreadable batch"

    def test_storage_error_while_quarantining_is_logged_and_the_task_still_fails(
        self, s3, monkeypatch, caplog
    ):
        # The task body gets the service; the hook's own call then fails.
        get_s3_service = MagicMock(side_effect=[s3, RuntimeError("storage unavailable")])
        monkeypatch.setattr("rest.services.s3.get_s3_service", get_s3_service)

        with caplog.at_level(logging.ERROR, logger="worker.ingest_tasks"):
            result = process_s3_traces.apply(
                kwargs=TASK_KWARGS, retries=process_s3_traces.max_retries, throw=False
            )

        assert get_s3_service.call_count == 2
        s3.copy_object.assert_not_called()
        assert "Could not quarantine the batch of task" in caplog.text
        assert "storage unavailable" in caplog.text
        assert result.state == "FAILURE"
        assert str(result.result) == "corrupt batch"

    def test_direct_call_never_quarantines(self, s3, quarantine_attempts):
        with pytest.raises(RuntimeError, match="corrupt batch"):
            process_s3_traces(**TASK_KWARGS)

        assert quarantine_attempts == []

    def test_successful_last_attempt_is_not_quarantined(self, s3, quarantine_attempts):
        s3.download_json.side_effect = None
        s3.download_json.return_value = {"resourceSpans": []}

        result = process_s3_traces.apply(
            kwargs=TASK_KWARGS, retries=process_s3_traces.max_retries, throw=False
        )

        assert result.state == "SUCCESS"
        assert quarantine_attempts == []

    def test_last_attempt_moves_the_batch_and_fails_with_the_original_error(self, s3, counters):
        quarantined, _ = counters

        result = process_s3_traces.apply(
            kwargs=TASK_KWARGS, retries=process_s3_traces.max_retries, throw=False
        )

        s3.copy_object.assert_called_once_with(BATCH_KEY, FAILED_KEY)
        s3.delete_object.assert_called_once_with(BATCH_KEY)
        quarantined.add.assert_called_once_with(1, {})
        assert result.state == "FAILURE"
        assert str(result.result) == "corrupt batch"

    def test_copy_failure_keeps_the_batch_and_the_original_error(self, s3, counters):
        _, failed = counters
        s3.copy_object.side_effect = RuntimeError("copy refused")

        result = process_s3_traces.apply(
            kwargs=TASK_KWARGS, retries=process_s3_traces.max_retries, throw=False
        )

        s3.delete_object.assert_not_called()
        failed.add.assert_called_once_with(1, {"stage": "copy"})
        assert result.state == "FAILURE"
        assert str(result.result) == "corrupt batch"
