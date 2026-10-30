"""Quarantine of ingest batches that failed every attempt."""

import logging
from unittest.mock import MagicMock, call

import pytest

from worker import ingest_quarantine
from worker.ingest_quarantine import failed_key_for, quarantine_batch
from worker.ingest_tasks import process_s3_traces

BATCH_KEY = "events/otel/proj-1/2026/10/29/12/batch.json"
FAILED_KEY = "events/failed/proj-1/2026/10/29/12/batch.json"
TASK_KWARGS = {"s3_key": BATCH_KEY, "project_id": "proj-1"}


@pytest.fixture()
def counters(monkeypatch):
    quarantined = MagicMock()
    failed = MagicMock()
    monkeypatch.setattr(ingest_quarantine, "_quarantined_counter", quarantined)
    monkeypatch.setattr(ingest_quarantine, "_quarantine_failed_counter", failed)
    return quarantined, failed


class TestFailedKeyFor:
    def test_swaps_the_ingest_prefix(self):
        assert failed_key_for(BATCH_KEY) == FAILED_KEY

    @pytest.mark.parametrize(
        "key",
        [
            "events/failed/proj-1/batch.json",
            "attachments/proj-1/sha256/" + "a" * 64,
            "events/otelx/proj-1/batch.json",
            "other/events/otel/proj-1/batch.json",
            "test/key.json",
        ],
    )
    def test_keys_outside_events_otel_are_not_mapped(self, key):
        assert failed_key_for(key) is None


class TestQuarantineBatch:
    def test_copies_then_deletes_and_counts(self, counters):
        quarantined, failed = counters
        s3 = MagicMock()

        assert quarantine_batch(s3, BATCH_KEY) is True

        assert s3.mock_calls == [
            call.copy_object(BATCH_KEY, FAILED_KEY),
            call.delete_object(BATCH_KEY),
        ]
        quarantined.add.assert_called_once_with(1, {})
        failed.add.assert_not_called()

    def test_copy_failure_keeps_the_original(self, counters, caplog):
        quarantined, failed = counters
        s3 = MagicMock()
        s3.copy_object.side_effect = RuntimeError("copy refused")

        with caplog.at_level(logging.ERROR, logger="worker.ingest_quarantine"):
            assert quarantine_batch(s3, BATCH_KEY) is False

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
            assert quarantine_batch(s3, BATCH_KEY) is True

        s3.copy_object.assert_called_once_with(BATCH_KEY, FAILED_KEY)
        quarantined.add.assert_called_once_with(1, {})
        failed.add.assert_called_once_with(1, {"stage": "delete"})
        assert "could not delete the original" in caplog.text

    def test_key_outside_events_otel_is_never_moved(self, counters):
        quarantined, failed = counters
        s3 = MagicMock()

        assert quarantine_batch(s3, "test/key.json") is False

        assert s3.mock_calls == []
        quarantined.add.assert_not_called()
        failed.add.assert_not_called()

    def test_runs_without_counters(self, monkeypatch):
        monkeypatch.setattr(ingest_quarantine, "_quarantined_counter", None)
        monkeypatch.setattr(ingest_quarantine, "_quarantine_failed_counter", None)
        s3 = MagicMock()
        s3.delete_object.side_effect = RuntimeError("delete refused")

        assert quarantine_batch(s3, BATCH_KEY) is True


def test_counters_are_built_from_the_otel_api():
    assert ingest_quarantine._quarantined_counter is not None
    assert ingest_quarantine._quarantine_failed_counter is not None


class TestProcessS3TracesFinalAttempt:
    """The task quarantines only on the attempt Celery will not retry.

    ``apply()`` runs the task eagerly through Celery's own autoretry and
    ``retry()`` code, recursing into each retry, so these tests exercise the
    real give-up point rather than a reimplementation of it.
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
            return True

        monkeypatch.setattr(ingest_quarantine, "quarantine_batch", fake_quarantine)
        return attempts

    def test_task_allows_five_retries(self):
        assert process_s3_traces.max_retries == 5

    def test_every_retry_failing_quarantines_once_on_the_last(self, s3, quarantine_attempts):
        result = process_s3_traces.apply(kwargs=TASK_KWARGS, throw=False)

        assert s3.download_json.call_count == process_s3_traces.max_retries + 1
        assert quarantine_attempts == [process_s3_traces.max_retries]
        assert result.state == "FAILURE"
        assert str(result.result) == "corrupt batch"

    def test_attempt_before_the_last_is_retried_not_quarantined(self, s3, quarantine_attempts):
        last = process_s3_traces.max_retries

        process_s3_traces.apply(kwargs=TASK_KWARGS, retries=last - 1, throw=False)

        # Attempt last-1 fails and is retried; only attempt `last` quarantines.
        assert s3.download_json.call_count == 2
        assert quarantine_attempts == [last]

    def test_last_attempt_alone_quarantines(self, s3, quarantine_attempts):
        last = process_s3_traces.max_retries

        result = process_s3_traces.apply(kwargs=TASK_KWARGS, retries=last, throw=False)

        assert s3.download_json.call_count == 1
        assert quarantine_attempts == [last]
        assert str(result.result) == "corrupt batch"

    def test_non_final_attempt_raises_without_quarantine(self, s3, quarantine_attempts):
        process_s3_traces.push_request(retries=process_s3_traces.max_retries - 1)
        try:
            with pytest.raises(RuntimeError, match="corrupt batch"):
                process_s3_traces.run(**TASK_KWARGS)
        finally:
            process_s3_traces.pop_request()

        assert quarantine_attempts == []

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
