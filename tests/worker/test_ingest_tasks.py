"""Unit tests for Celery task logic with mocked S3 + ClickHouse."""

import json
from unittest.mock import MagicMock

import pytest

from tests.fixtures.otel_payloads import make_otel_payload, make_span
from worker.ingest_tasks import _publish_live_spans, process_s3_traces

TRACE_HEX = "aa" * 16
SPAN_HEX = "bb" * 8


@pytest.fixture()
def mock_redis(monkeypatch):
    """Mock Redis Client."""
    mock = MagicMock()
    monkeypatch.setattr("redis.from_url", lambda url, decode_responses=True: mock)
    return mock


@pytest.fixture()
def mock_s3(monkeypatch):
    """Mock S3 service."""
    mock = MagicMock()
    monkeypatch.setattr("rest.services.s3.get_s3_service", lambda: mock)
    return mock


@pytest.fixture()
def mock_ch(monkeypatch):
    """Mock ClickHouse client."""
    mock = MagicMock()
    monkeypatch.setattr("db.clickhouse.client.get_clickhouse_client", lambda: mock)
    return mock


@pytest.fixture(autouse=True)
def mock_detector_enqueue(monkeypatch):
    """Mock the detector enqueue so tests never touch Postgres/Redis/BullMQ."""
    mock = MagicMock()
    monkeypatch.setattr("worker.detector_tasks.enqueue_detector_runs", mock)
    return mock


class TestPublishLiveSpans:
    def test_groups_spans_by_trace(self, mock_redis):
        """Each trace receives one spans event on its own Redis channel."""
        trace_a_spans = [
            {
                "trace_id": "trace-a",
                "span_id": "a-root",
                "parent_span_id": "existing-parent",
                "span_end_time": None,
            },
            {
                "trace_id": "trace-a",
                "span_id": "a-child",
                "parent_span_id": "a-root",
                "span_end_time": None,
            },
        ]
        trace_b_spans = [
            {
                "trace_id": "trace-b",
                "span_id": "b-child",
                "parent_span_id": "b-root",
                "span_end_time": None,
            },
        ]

        _publish_live_spans(
            [trace_a_spans[0], trace_b_spans[0], trace_a_spans[1]],
            project_id="proj-1",
        )

        published_span_events = {}
        for publish_call in mock_redis.publish.call_args_list:
            channel, encoded_payload = publish_call.args
            payload = json.loads(encoded_payload)
            if payload["type"] == "spans":
                published_span_events[channel] = payload["spans"]

        assert published_span_events == {
            "trace:live:proj-1:trace-a": trace_a_spans,
            "trace:live:proj-1:trace-b": trace_b_spans,
        }
        mock_redis.close.assert_called_once_with()

    def test_publishes_completion_only_for_completed_root(self, mock_redis):
        """A completed child or an open root must not complete a trace."""
        spans = [
            {
                "trace_id": "completed-trace",
                "span_id": "completed-root",
                "parent_span_id": None,
                "span_end_time": "2026-07-28T10:00:00",
            },
            {
                "trace_id": "open-trace",
                "span_id": "open-root",
                "parent_span_id": None,
                "span_end_time": None,
            },
            {
                "trace_id": "child-only-trace",
                "span_id": "completed-child",
                "parent_span_id": "missing-root",
                "span_end_time": "2026-07-28T10:00:00",
            },
        ]

        _publish_live_spans(spans, project_id="proj-1")

        completion_channels = []
        for publish_call in mock_redis.publish.call_args_list:
            channel, encoded_payload = publish_call.args
            payload = json.loads(encoded_payload)
            if payload["type"] == "trace_complete":
                completion_channels.append(channel)

        assert completion_channels == ["trace:live:proj-1:completed-trace"]


class TestProcessS3Traces:
    def test_happy_path(self, mock_s3, mock_ch, mock_redis):
        """Downloads from S3, transforms, inserts traces + spans."""
        payload = make_otel_payload([make_span(TRACE_HEX, SPAN_HEX, name="test")])
        mock_s3.download_json.return_value = payload

        result = process_s3_traces(s3_key="test/key.json", project_id="proj-1")

        mock_s3.download_json.assert_called_once_with("test/key.json")
        assert result["traces"] == 1
        assert result["spans"] == 1
        mock_ch.insert_traces_batch.assert_called_once()
        mock_ch.insert_spans_batch.assert_called_once()
        mock_redis.publish.assert_called()

    def test_redis_publish_failure_does_not_break_ingestion(
        self, mock_s3, mock_ch, mock_redis, caplog
    ):
        """Redis failure is logged, but ClickHouse ingestion still succeeds."""
        payload = make_otel_payload([make_span(TRACE_HEX, SPAN_HEX, name="test")])
        mock_s3.download_json.return_value = payload
        mock_redis.publish.side_effect = ConnectionError("Redis unavailable")

        result = process_s3_traces(s3_key="test/key.json", project_id="proj-1")

        assert result["traces"] == 1
        assert result["spans"] == 1
        mock_ch.insert_traces_batch.assert_called_once()
        mock_ch.insert_spans_batch.assert_called_once()
        assert "Failed to publish live spans to Redis" in caplog.text

    def test_empty_payload(self, mock_s3, mock_ch, mock_redis):
        """Empty OTEL data -> no inserts, returns zeros."""
        mock_s3.download_json.return_value = {"resourceSpans": []}

        result = process_s3_traces(s3_key="test/key.json", project_id="proj-1")

        assert result["traces"] == 0
        assert result["spans"] == 0
        mock_ch.insert_traces_batch.assert_not_called()
        mock_ch.insert_spans_batch.assert_not_called()
        mock_redis.publish.assert_not_called()

    def test_s3_download_fails(self, mock_s3, mock_ch, mock_redis):
        """S3 error -> exception raised (Celery will retry)."""
        mock_s3.download_json.side_effect = Exception("S3 error")

        with pytest.raises(Exception, match="S3 error"):
            process_s3_traces(s3_key="test/key.json", project_id="proj-1")

        mock_ch.insert_traces_batch.assert_not_called()
        mock_redis.publish.assert_not_called()

    def test_clickhouse_insert_fails(self, mock_s3, mock_ch, mock_redis):
        """CH insert error -> exception raised."""
        payload = make_otel_payload([make_span(TRACE_HEX, SPAN_HEX)])
        mock_s3.download_json.return_value = payload
        mock_ch.insert_traces_batch.side_effect = Exception("CH connection error")

        with pytest.raises(Exception, match="CH connection error"):
            process_s3_traces(s3_key="test/key.json", project_id="proj-1")

        mock_redis.publish.assert_not_called()

    def test_multiple_traces_and_spans(self, mock_s3, mock_ch, mock_redis):
        """Payload with multiple traces processes correctly."""
        trace1 = "aa" * 16
        trace2 = "bb" * 16
        payload = make_otel_payload(
            [
                make_span(trace1, "11" * 8, name="trace-1"),
                make_span(trace2, "22" * 8, name="trace-2"),
                make_span(trace1, "33" * 8, name="child", parent_span_id_hex="11" * 8),
            ]
        )
        mock_s3.download_json.return_value = payload

        result = process_s3_traces(s3_key="test/key.json", project_id="proj-1")

        assert result["traces"] == 2
        assert result["spans"] == 3
        mock_redis.publish.assert_called()

    def test_detector_enqueue_gets_only_root_bearing_traces(
        self, mock_s3, mock_ch, mock_redis, mock_detector_enqueue
    ):
        """Enqueue receives only the traces whose root span arrived in this batch."""
        root_trace = "aa" * 16
        late_trace = "bb" * 16
        payload = make_otel_payload(
            [
                make_span(root_trace, "11" * 8, name="root"),
                # Child-only span for another trace — no root in this batch.
                make_span(late_trace, "22" * 8, name="child", parent_span_id_hex="33" * 8),
            ]
        )
        mock_s3.download_json.return_value = payload
        mock_ch.query.return_value = MagicMock(result_rows=[])

        process_s3_traces(s3_key="test/key.json", project_id="proj-1")

        mock_detector_enqueue.assert_called_once()
        project_id, traces_with_root = mock_detector_enqueue.call_args[0]
        assert project_id == "proj-1"
        # Only the root-bearing trace is passed; the child-only late_trace is not.
        assert traces_with_root == {root_trace}
        mock_redis.publish.assert_called()

    def test_missing_root_probe_is_scoped_to_the_project(self, mock_s3, mock_ch):
        """The probe names project_id, the sort-key prefix it needs to prune on."""
        late_trace = "cc" * 16
        mock_s3.download_json.return_value = make_otel_payload(
            [make_span(late_trace, "44" * 8, name="child", parent_span_id_hex="55" * 8)]
        )
        mock_ch.query.return_value = MagicMock(result_rows=[])

        process_s3_traces(s3_key="test/key.json", project_id="proj-1")

        args, kwargs = mock_ch.query.call_args
        assert "project_id" in args[0]
        assert kwargs["parameters"]["project_id"] == "proj-1"

    def test_detector_enqueue_not_called_for_empty_batch(
        self, mock_s3, mock_ch, mock_detector_enqueue
    ):
        mock_s3.download_json.return_value = {"resourceSpans": []}

        process_s3_traces(s3_key="test/key.json", project_id="proj-1")

        mock_detector_enqueue.assert_not_called()
