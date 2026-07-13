"""process_s3_traces must never enqueue detection for detector-sourced roots.

The transform is mocked: on this path the transform does not emit a
detector-sourced record, so the guard's trigger has to be stubbed. That is
exactly the point — this guard is the backstop for data that should never
reach this code path.
"""

from unittest.mock import MagicMock

import pytest

from worker.ingest_tasks import process_s3_traces

DETECTOR_TRACE = "ab" * 16
USER_TRACE = "cd" * 16


def _root_span(trace_id: str, source: str | None) -> dict:
    span = {
        "span_id": "01" * 8,
        "trace_id": trace_id,
        "parent_span_id": None,
        "project_id": "proj-1",
        "name": "root",
    }
    if source is not None:
        span["source"] = source
    return span


def _trace(trace_id: str) -> dict:
    return {"trace_id": trace_id, "project_id": "proj-1", "name": "root"}


@pytest.fixture()
def mock_s3(monkeypatch):
    mock = MagicMock()
    monkeypatch.setattr("rest.services.s3.get_s3_service", lambda: mock)
    mock.download_json.return_value = {"resourceSpans": []}
    return mock


@pytest.fixture()
def mock_ch(monkeypatch):
    mock = MagicMock()
    monkeypatch.setattr("db.clickhouse.client.get_clickhouse_client", lambda: mock)
    return mock


@pytest.fixture()
def mock_enqueue(monkeypatch):
    mock = MagicMock()
    monkeypatch.setattr("worker.detector_tasks.enqueue_detector_runs", mock)
    return mock


@pytest.fixture(autouse=True)
def quiet_live_publish(monkeypatch):
    """Live-span publishing is out of scope; stub it for isolation."""
    monkeypatch.setattr("worker.ingest_tasks._publish_live_spans", MagicMock())


@pytest.fixture()
def transform_returning(monkeypatch):
    """Make the (mocked) transform return exactly these records."""

    def _set(traces: list[dict], spans: list[dict]) -> None:
        # The task imports the transform inside its body, so patch the source
        # module — the deferred import reads this attribute at call time.
        monkeypatch.setattr(
            "worker.otel_transform.transform_otel_to_clickhouse",
            lambda otel_data, project_id: (traces, spans),
        )

    return _set


class TestDetectorSourcedRootsAreNotEnqueued:
    def test_detector_root_skips_enqueue_but_still_inserts(
        self, mock_s3, mock_ch, mock_enqueue, transform_returning
    ):
        transform_returning([_trace(DETECTOR_TRACE)], [_root_span(DETECTOR_TRACE, "detector")])

        process_s3_traces(s3_key="k.json", project_id="proj-1")

        mock_enqueue.assert_not_called()
        # INSERT path unaffected: the self-trace row still lands.
        inserted = mock_ch.insert_traces_batch.call_args[0][0]
        assert [t["trace_id"] for t in inserted] == [DETECTOR_TRACE]

    def test_user_root_is_enqueued(self, mock_s3, mock_ch, mock_enqueue, transform_returning):
        transform_returning([_trace(USER_TRACE)], [_root_span(USER_TRACE, "user")])

        process_s3_traces(s3_key="k.json", project_id="proj-1")

        mock_enqueue.assert_called_once_with("proj-1", {USER_TRACE})

    def test_sourceless_root_is_enqueued(self, mock_s3, mock_ch, mock_enqueue, transform_returning):
        """Records from before the source column default to user traffic."""
        transform_returning([_trace(USER_TRACE)], [_root_span(USER_TRACE, None)])

        process_s3_traces(s3_key="k.json", project_id="proj-1")

        mock_enqueue.assert_called_once_with("proj-1", {USER_TRACE})

    def test_trace_with_both_detector_and_user_roots_is_excluded(
        self, mock_s3, mock_ch, mock_enqueue, transform_returning
    ):
        """Corrupt/spoofed dual-root data resolves in the safe direction."""
        transform_returning(
            [_trace(DETECTOR_TRACE)],
            [
                _root_span(DETECTOR_TRACE, "detector"),
                _root_span(DETECTOR_TRACE, "user"),
            ],
        )

        process_s3_traces(s3_key="k.json", project_id="proj-1")

        mock_enqueue.assert_not_called()

    def test_mixed_batch_enqueues_only_the_user_root(
        self, mock_s3, mock_ch, mock_enqueue, transform_returning
    ):
        transform_returning(
            [_trace(DETECTOR_TRACE), _trace(USER_TRACE)],
            [
                _root_span(DETECTOR_TRACE, "detector"),
                _root_span(USER_TRACE, "user"),
            ],
        )

        process_s3_traces(s3_key="k.json", project_id="proj-1")

        mock_enqueue.assert_called_once_with("proj-1", {USER_TRACE})
        inserted = mock_ch.insert_traces_batch.call_args[0][0]
        assert {t["trace_id"] for t in inserted} == {DETECTOR_TRACE, USER_TRACE}
