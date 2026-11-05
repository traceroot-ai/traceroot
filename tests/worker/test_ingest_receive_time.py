"""The ingest task and the batch receive time the API queues it with."""

from unittest.mock import MagicMock

import pytest

from tests.fixtures.otel_payloads import make_otel_payload, make_span
from worker.ingest_tasks import process_s3_traces

TRACE_HEX = "aa" * 16
SPAN_HEX = "bb" * 8


@pytest.fixture()
def sinks(monkeypatch):
    """S3 serving one JSON batch, and every downstream sink mocked."""
    s3 = MagicMock()
    s3.download_json.return_value = make_otel_payload([make_span(TRACE_HEX, SPAN_HEX)])
    monkeypatch.setattr("rest.services.s3.get_s3_service", lambda: s3)
    ch = MagicMock()
    monkeypatch.setattr("db.clickhouse.client.get_clickhouse_client", lambda: ch)
    monkeypatch.setattr("worker.detector_tasks.enqueue_detector_runs", MagicMock())
    monkeypatch.setattr("worker.ingest_tasks._publish_live_spans", MagicMock())
    return ch


def test_task_accepts_a_receive_time(sinks):
    result = process_s3_traces(
        s3_key="events/otel/proj-1/k.json",
        project_id="proj-1",
        received_at="2026-10-29T12:00:00.123456+00:00",
    )
    assert result["spans"] == 1
    sinks.insert_spans_batch.assert_called_once()


def test_task_runs_without_a_receive_time(sinks):
    result = process_s3_traces(s3_key="events/otel/proj-1/k.json", project_id="proj-1")
    assert result["spans"] == 1
