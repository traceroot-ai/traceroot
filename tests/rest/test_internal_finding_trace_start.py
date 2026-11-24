"""Unit tests for GET /api/v1/internal/findings/{finding_id}/trace-start."""

import asyncio
from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient

from rest.main import app
from shared.config import settings


@pytest.fixture()
def secret(monkeypatch):
    """Configure a known internal-secret so the auth dep accepts our header."""
    monkeypatch.setattr(settings, "internal_api_secret", "test-secret")
    return "test-secret"


@pytest.fixture()
def mock_ch(monkeypatch):
    """Mock the ClickHouse client used by the internal detectors router."""
    mock = MagicMock()
    monkeypatch.setattr(
        "rest.routers.internal.detectors.get_clickhouse_client",
        lambda: mock,
    )
    return mock


@pytest.fixture()
def mock_reader(monkeypatch):
    """Mock the trace reader service used by the internal detectors router."""
    reader = MagicMock()
    monkeypatch.setattr(
        "rest.routers.internal.detectors.get_trace_reader_service",
        lambda: reader,
    )
    return reader


@pytest.fixture()
def client(secret, mock_ch, mock_reader):
    return TestClient(app)


def _make_query_result(rows: list[tuple], column_names: list[str]) -> MagicMock:
    """Shape a ClickHouse-client-style query result."""
    r = MagicMock()
    r.result_rows = rows
    r.column_names = column_names
    return r


def _loop_visible_to(recorder: list[bool], result):
    """Stub recording whether it ran where an event loop was running.

    The sentinel ``TestBlockingReadsRunOffTheEventLoop`` in test_traces_router.py
    uses, which also checks that it catches a call left on the loop.
    """

    def _call(*_args, **_kwargs):
        try:
            asyncio.get_running_loop()
        except RuntimeError:
            recorder.append(False)
        else:
            recorder.append(True)
        return result

    return _call


class TestGetFindingTraceStart:
    def test_root_start_known_returns_utc_and_skips_earliest_span_fallback(
        self, client, mock_ch, mock_reader, secret
    ):
        first_seen = datetime(2026, 5, 2, 12, 30, 0)
        root_start = datetime(2026, 5, 1, 9, 15, 0)
        mock_ch.query.return_value = _make_query_result(
            rows=[("trace-1", first_seen)],
            column_names=["trace_id", "min(timestamp)"],
        )
        mock_reader.get_trace_start_time.return_value = root_start

        resp = client.get(
            "/api/v1/internal/findings/f1/trace-start",
            params={"project_id": "p1"},
            headers={"X-Internal-Secret": secret},
        )

        assert resp.status_code == 200
        assert resp.json() == {
            "trace_id": "trace-1",
            "trace_start_time": "2026-05-01T09:15:00+00:00",
            "timestamp": "2026-05-02T12:30:00+00:00",
        }
        mock_reader.get_trace_start_time.assert_called_once_with(
            "p1", "trace-1", customer_only=True
        )
        mock_reader.get_customer_trace_earliest_span_time.assert_not_called()

    def test_missing_root_falls_back_to_earliest_customer_span(
        self, client, mock_ch, mock_reader, secret
    ):
        first_seen = datetime(2026, 5, 2, 12, 30, 0)
        earliest_span = datetime(2026, 5, 1, 9, 20, 0)
        mock_ch.query.return_value = _make_query_result(
            rows=[("trace-1", first_seen)],
            column_names=["trace_id", "min(timestamp)"],
        )
        mock_reader.get_trace_start_time.return_value = None
        mock_reader.get_customer_trace_earliest_span_time.return_value = earliest_span

        resp = client.get(
            "/api/v1/internal/findings/f1/trace-start",
            params={"project_id": "p1"},
            headers={"X-Internal-Secret": secret},
        )

        assert resp.status_code == 200
        assert resp.json() == {
            "trace_id": "trace-1",
            "trace_start_time": "2026-05-01T09:20:00+00:00",
            "timestamp": "2026-05-02T12:30:00+00:00",
        }
        mock_reader.get_trace_start_time.assert_called_once_with(
            "p1", "trace-1", customer_only=True
        )
        mock_reader.get_customer_trace_earliest_span_time.assert_called_once_with("p1", "trace-1")

    def test_no_customer_span_returns_null_trace_start_with_timestamp(
        self, client, mock_ch, mock_reader, secret
    ):
        first_seen = datetime(2026, 5, 2, 12, 30, 0)
        mock_ch.query.return_value = _make_query_result(
            rows=[("trace-1", first_seen)],
            column_names=["trace_id", "min(timestamp)"],
        )
        mock_reader.get_trace_start_time.return_value = None
        mock_reader.get_customer_trace_earliest_span_time.return_value = None

        resp = client.get(
            "/api/v1/internal/findings/f1/trace-start",
            params={"project_id": "p1"},
            headers={"X-Internal-Secret": secret},
        )

        assert resp.status_code == 200
        assert resp.json() == {
            "trace_id": "trace-1",
            "trace_start_time": None,
            "timestamp": "2026-05-02T12:30:00+00:00",
        }

    def test_missing_finding_returns_404_without_touching_trace_reader(
        self, client, mock_ch, mock_reader, secret
    ):
        mock_ch.query.return_value = _make_query_result(
            rows=[],
            column_names=["trace_id", "min(timestamp)"],
        )

        resp = client.get(
            "/api/v1/internal/findings/missing/trace-start",
            params={"project_id": "p1"},
            headers={"X-Internal-Secret": secret},
        )

        assert resp.status_code == 404
        mock_reader.get_trace_start_time.assert_not_called()
        mock_reader.get_customer_trace_earliest_span_time.assert_not_called()

    def test_query_binds_parameters_groups_by_trace_id_and_avoids_final(
        self, client, mock_ch, mock_reader, secret
    ):
        mock_ch.query.return_value = _make_query_result(
            rows=[("trace-1", datetime(2026, 5, 2, 12, 0, 0))],
            column_names=["trace_id", "min(timestamp)"],
        )
        mock_reader.get_trace_start_time.return_value = datetime(2026, 5, 1, 12, 0, 0)

        resp = client.get(
            "/api/v1/internal/findings/f-exact/trace-start",
            params={"project_id": "proj-1"},
            headers={"X-Internal-Secret": secret},
        )

        assert resp.status_code == 200
        mock_ch.query.assert_called_once()
        sql = mock_ch.query.call_args.args[0]
        params = mock_ch.query.call_args.kwargs["parameters"]
        assert params == {"project_id": "proj-1", "finding_id": "f-exact"}
        assert "{project_id:String}" in sql
        assert "{finding_id:String}" in sql
        assert "GROUP BY trace_id" in " ".join(sql.split())
        assert "FINAL" not in sql.upper()

    def test_missing_or_wrong_internal_secret_returns_403(self, client, mock_ch, mock_reader):
        resp_missing = client.get(
            "/api/v1/internal/findings/f1/trace-start",
            params={"project_id": "p1"},
        )
        assert resp_missing.status_code == 403

        resp_wrong = client.get(
            "/api/v1/internal/findings/f1/trace-start",
            params={"project_id": "p1"},
            headers={"X-Internal-Secret": "wrong-secret"},
        )
        assert resp_wrong.status_code == 403
        mock_ch.query.assert_not_called()
        mock_reader.get_trace_start_time.assert_not_called()

    def test_clickhouse_reads_run_off_the_event_loop(self, client, mock_ch, mock_reader, secret):
        ran_on_loop: list[bool] = []
        mock_ch.query.side_effect = _loop_visible_to(
            ran_on_loop,
            _make_query_result(
                rows=[("trace-1", datetime(2026, 5, 2, 12, 30, 0))],
                column_names=["trace_id", "min(timestamp)"],
            ),
        )
        mock_reader.get_trace_start_time.side_effect = _loop_visible_to(ran_on_loop, None)
        mock_reader.get_customer_trace_earliest_span_time.side_effect = _loop_visible_to(
            ran_on_loop, datetime(2026, 5, 1, 9, 20, 0)
        )

        resp = client.get(
            "/api/v1/internal/findings/f1/trace-start",
            params={"project_id": "p1"},
            headers={"X-Internal-Secret": secret},
        )

        assert resp.status_code == 200
        # The finding query, the root lookup and the earliest-span fallback.
        assert ran_on_loop == [False, False, False]

    def test_aware_non_utc_datetimes_are_converted_to_utc(
        self, client, mock_ch, mock_reader, secret
    ):
        tz_plus_2 = timezone(timedelta(hours=2))
        first_seen = datetime(2026, 5, 2, 14, 30, 0, tzinfo=tz_plus_2)
        root_start = datetime(2026, 5, 1, 11, 15, 0, tzinfo=tz_plus_2)
        mock_ch.query.return_value = _make_query_result(
            rows=[("trace-1", first_seen)],
            column_names=["trace_id", "min(timestamp)"],
        )
        mock_reader.get_trace_start_time.return_value = root_start

        resp = client.get(
            "/api/v1/internal/findings/f1/trace-start",
            params={"project_id": "p1"},
            headers={"X-Internal-Secret": secret},
        )

        assert resp.status_code == 200
        assert resp.json() == {
            "trace_id": "trace-1",
            "trace_start_time": "2026-05-01T09:15:00+00:00",
            "timestamp": "2026-05-02T12:30:00+00:00",
        }
