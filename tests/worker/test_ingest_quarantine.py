"""Quarantine of ingest batches that failed every attempt."""

import logging
from unittest.mock import MagicMock, call

import pytest

from worker import ingest_quarantine
from worker.ingest_quarantine import failed_key_for, quarantine_batch

BATCH_KEY = "events/otel/proj-1/2026/10/29/12/batch.json"
FAILED_KEY = "events/failed/proj-1/2026/10/29/12/batch.json"


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
