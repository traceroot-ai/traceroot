"""New data and replacement snapshots update activity only after storage succeeds."""

from datetime import UTC, datetime

import pytest

from tests.fixtures.otel_payloads import make_otel_payload, make_span
from worker.ingest_tasks import process_s3_traces

RECEIVED = "2026-11-13T12:34:56+00:00"


@pytest.fixture()
def ch(monkeypatch):
    from unittest.mock import MagicMock

    client = MagicMock()
    client.query.return_value.result_rows = [("aa" * 16,)]
    monkeypatch.setattr("db.clickhouse.client.get_clickhouse_client", lambda: client)
    monkeypatch.setattr("worker.detector_tasks.enqueue_detector_runs", MagicMock())
    monkeypatch.setattr("worker.ingest_tasks._publish_live_spans", MagicMock())
    return client


@pytest.mark.parametrize("parent", [None, "cc" * 8])
def test_root_and_child_only_snapshots_record_the_batch_receive_time(
    mock_s3, ch, mock_project_ingestion, parent
):
    mock_s3.download_json.return_value = make_otel_payload(
        [make_span("aa" * 16, "bb" * 8, parent_span_id_hex=parent)]
    )
    order = []
    ch.insert_spans_batch.side_effect = lambda _: order.append("stored")
    mock_project_ingestion.side_effect = lambda *_: order.append("recorded")
    process_s3_traces(s3_key="batch.json", project_id="p1", received_at=RECEIVED)
    mock_project_ingestion.assert_called_once_with({"p1"}, datetime.fromisoformat(RECEIVED))
    assert order == ["stored", "recorded"]


def test_empty_batch_has_no_activity(mock_s3, ch, mock_project_ingestion):
    mock_s3.download_json.return_value = {"resourceSpans": []}
    process_s3_traces(s3_key="empty.json", project_id="p1", received_at=RECEIVED)
    mock_project_ingestion.assert_not_called()


def test_failed_span_storage_has_no_activity(mock_s3, ch, mock_project_ingestion):
    mock_s3.download_json.return_value = make_otel_payload([make_span("aa" * 16, "bb" * 8)])
    ch.insert_spans_batch.side_effect = RuntimeError("storage unavailable")
    with pytest.raises(RuntimeError, match="storage unavailable"):
        process_s3_traces(s3_key="batch.json", project_id="p1", received_at=RECEIVED)
    mock_project_ingestion.assert_not_called()


def test_failed_activity_write_fails_the_task_for_retry(mock_s3, ch, mock_project_ingestion):
    mock_s3.download_json.return_value = make_otel_payload([make_span("aa" * 16, "bb" * 8)])
    mock_project_ingestion.side_effect = RuntimeError("activity unavailable")
    with pytest.raises(RuntimeError, match="activity unavailable"):
        process_s3_traces(s3_key="batch.json", project_id="p1", received_at=RECEIVED)


def test_legacy_task_falls_back_to_processing_time(mock_s3, ch, mock_project_ingestion):
    mock_s3.download_json.return_value = make_otel_payload([make_span("aa" * 16, "bb" * 8)])
    before = datetime.now(UTC)
    process_s3_traces(s3_key="batch.json", project_id="p1")
    ids, timestamp = mock_project_ingestion.call_args.args
    assert ids == {"p1"}
    assert before <= timestamp <= datetime.now(UTC)
