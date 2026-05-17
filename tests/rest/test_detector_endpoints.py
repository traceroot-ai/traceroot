"""Unit tests for the internal detector findings/runs endpoints (#806).

Covers the server-side filters (start_after/end_before/search_query — same
names trace/sessions/users use), the COUNT-driven pagination metadata, and
the {data, meta} response envelope.
"""

from datetime import datetime
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
    """Mock the ClickHouse client used by the internal router."""
    mock = MagicMock()
    monkeypatch.setattr(
        "rest.routers.internal.get_clickhouse_client",
        lambda: mock,
    )
    return mock


@pytest.fixture()
def client(secret, mock_ch):
    return TestClient(app)


def _make_query_result(rows: list[tuple], column_names: list[str]) -> MagicMock:
    """Helper: shape ClickHouse-client-style result object."""
    r = MagicMock()
    r.result_rows = rows
    r.column_names = column_names
    return r


# =============================================================================
# /detector-findings
# =============================================================================


class TestListDetectorFindings:
    def _fake_data(self):
        ts = datetime(2026, 5, 1, 12, 0, 0)
        return _make_query_result(
            rows=[("f1", "p1", "trace-aaa", "summary text", "{}", ts)],
            column_names=[
                "finding_id",
                "project_id",
                "trace_id",
                "summary",
                "payload",
                "timestamp",
            ],
        )

    def _fake_count(self, total: int):
        return _make_query_result(rows=[(total,)], column_names=["count()"])

    def test_returns_data_meta_envelope(self, client, mock_ch, secret):
        mock_ch.query.side_effect = [self._fake_data(), self._fake_count(1)]
        resp = client.get(
            "/api/v1/internal/detector-findings",
            params={"project_id": "p1", "detector_id": "d1"},
            headers={"X-Internal-Secret": secret},
        )
        assert resp.status_code == 200
        body = resp.json()
        assert "data" in body and "meta" in body
        assert body["meta"] == {"page": 0, "limit": 50, "total": 1}
        assert body["data"][0]["finding_id"] == "f1"

    def test_search_query_adds_ilike_clause(self, client, mock_ch, secret):
        mock_ch.query.side_effect = [self._fake_data(), self._fake_count(0)]
        resp = client.get(
            "/api/v1/internal/detector-findings",
            params={"project_id": "p1", "detector_id": "d1", "search_query": "foo"},
            headers={"X-Internal-Secret": secret},
        )
        assert resp.status_code == 200
        # First call is the data query — assert SQL contains both ILIKE branches
        # so we know substring search hits trace_id AND summary.
        data_sql = mock_ch.query.call_args_list[0].args[0]
        assert "f.trace_id ILIKE" in data_sql
        assert "f.summary ILIKE" in data_sql
        params = mock_ch.query.call_args_list[0].kwargs["parameters"]
        assert params["search_kw"] == "%foo%"

    def test_search_escapes_ilike_wildcards(self, client, mock_ch, secret):
        """% and _ in user input must be escaped so they're matched literally."""
        mock_ch.query.side_effect = [self._fake_data(), self._fake_count(0)]
        client.get(
            "/api/v1/internal/detector-findings",
            params={"project_id": "p1", "detector_id": "d1", "search_query": "100%_x"},
            headers={"X-Internal-Secret": secret},
        )
        params = mock_ch.query.call_args_list[0].kwargs["parameters"]
        # Wildcards inside the user input are escaped; outer % wrappers stay.
        assert params["search_kw"] == r"%100\%\_x%"

    def test_start_after_end_before_become_datetime_params(self, client, mock_ch, secret):
        mock_ch.query.side_effect = [self._fake_data(), self._fake_count(0)]
        resp = client.get(
            "/api/v1/internal/detector-findings",
            params={
                "project_id": "p1",
                "detector_id": "d1",
                "start_after": "2026-04-01T00:00:00Z",
                "end_before": "2026-05-01T00:00:00Z",
            },
            headers={"X-Internal-Secret": secret},
        )
        assert resp.status_code == 200
        data_sql = mock_ch.query.call_args_list[0].args[0]
        assert "f.timestamp >= {start_after:DateTime64(3)}" in data_sql
        assert "f.timestamp < {end_before:DateTime64(3)}" in data_sql
        params = mock_ch.query.call_args_list[0].kwargs["parameters"]
        # FastAPI auto-parses ISO; we then convert to UTC-naive for ClickHouse.
        assert isinstance(params["start_after"], datetime)
        assert params["start_after"].tzinfo is None
        assert isinstance(params["end_before"], datetime)

    def test_invalid_start_after_returns_422(self, client, mock_ch, secret):
        """FastAPI's auto-parser rejects malformed datetime input with 422 (project standard)."""
        resp = client.get(
            "/api/v1/internal/detector-findings",
            params={"project_id": "p1", "detector_id": "d1", "start_after": "not-a-date"},
            headers={"X-Internal-Secret": secret},
        )
        assert resp.status_code == 422
        # ClickHouse should never be called with a malformed timestamp.
        mock_ch.query.assert_not_called()

    def test_count_query_omits_pagination_params(self, client, mock_ch, secret):
        """COUNT must run against the same WHERE clause but without LIMIT/OFFSET."""
        mock_ch.query.side_effect = [self._fake_data(), self._fake_count(123)]
        client.get(
            "/api/v1/internal/detector-findings",
            params={"project_id": "p1", "detector_id": "d1"},
            headers={"X-Internal-Secret": secret},
        )
        count_call = mock_ch.query.call_args_list[1]
        count_sql = count_call.args[0]
        assert "SELECT count()" in count_sql
        assert "LIMIT" not in count_sql
        assert "OFFSET" not in count_sql

    def test_meta_echoes_requested_page(self, client, mock_ch, secret):
        mock_ch.query.side_effect = [self._fake_data(), self._fake_count(500)]
        resp = client.get(
            "/api/v1/internal/detector-findings",
            params={"project_id": "p1", "detector_id": "d1", "limit": 50, "page": 2},
            headers={"X-Internal-Secret": secret},
        )
        assert resp.json()["meta"] == {"page": 2, "limit": 50, "total": 500}

    def test_limit_capped_at_200(self, client, mock_ch, secret):
        # Limit > 200 should be rejected by the FastAPI Query validator.
        resp = client.get(
            "/api/v1/internal/detector-findings",
            params={"project_id": "p1", "detector_id": "d1", "limit": 999},
            headers={"X-Internal-Secret": secret},
        )
        assert resp.status_code == 422


# =============================================================================
# /detector-runs
# =============================================================================


class TestListDetectorRuns:
    def _fake_data(self):
        ts = datetime(2026, 5, 1, 12, 0, 0)
        return _make_query_result(
            rows=[
                ("r1", "d1", "p1", "trace-bbb", "f1", "completed", ts, "summary text"),
            ],
            column_names=[
                "run_id",
                "detector_id",
                "project_id",
                "trace_id",
                "finding_id",
                "status",
                "timestamp",
                "summary",
            ],
        )

    def _fake_count(self, total: int):
        return _make_query_result(rows=[(total,)], column_names=["count()"])

    def test_returns_data_meta_envelope(self, client, mock_ch, secret):
        mock_ch.query.side_effect = [self._fake_data(), self._fake_count(1)]
        resp = client.get(
            "/api/v1/internal/detector-runs",
            params={"project_id": "p1", "detector_id": "d1"},
            headers={"X-Internal-Secret": secret},
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["meta"] == {"page": 0, "limit": 50, "total": 1}
        assert body["data"][0]["run_id"] == "r1"

    def test_search_query_hits_trace_id_and_joined_summary(self, client, mock_ch, secret):
        mock_ch.query.side_effect = [self._fake_data(), self._fake_count(0)]
        resp = client.get(
            "/api/v1/internal/detector-runs",
            params={"project_id": "p1", "detector_id": "d1", "search_query": "foo"},
            headers={"X-Internal-Secret": secret},
        )
        assert resp.status_code == 200
        data_sql = mock_ch.query.call_args_list[0].args[0]
        # Runs search must hit trace_id directly and the joined finding's
        # per-detector summary expression — confirm both are wired.
        assert "r.trace_id ILIKE" in data_sql
        assert "JSONExtractString" in data_sql  # the joined-summary expression
        assert "ILIKE {search_kw:String}" in data_sql

    def test_start_after_end_before_apply_to_run_timestamp(self, client, mock_ch, secret):
        mock_ch.query.side_effect = [self._fake_data(), self._fake_count(0)]
        client.get(
            "/api/v1/internal/detector-runs",
            params={
                "project_id": "p1",
                "detector_id": "d1",
                "start_after": "2026-04-01T00:00:00Z",
                "end_before": "2026-05-01T00:00:00Z",
            },
            headers={"X-Internal-Secret": secret},
        )
        data_sql = mock_ch.query.call_args_list[0].args[0]
        assert "r.timestamp >= {start_after:DateTime64(3)}" in data_sql
        assert "r.timestamp < {end_before:DateTime64(3)}" in data_sql

    def test_no_filters_means_no_extra_where(self, client, mock_ch, secret):
        """Bare query should have only project_id + detector_id conditions."""
        mock_ch.query.side_effect = [self._fake_data(), self._fake_count(1)]
        client.get(
            "/api/v1/internal/detector-runs",
            params={"project_id": "p1", "detector_id": "d1"},
            headers={"X-Internal-Secret": secret},
        )
        data_sql = mock_ch.query.call_args_list[0].args[0]
        assert "ILIKE" not in data_sql  # no search → no ILIKE
        assert "start_after" not in data_sql
        assert "end_before" not in data_sql


# =============================================================================
# Auth — both endpoints
# =============================================================================


class TestInternalAuth:
    def test_missing_secret_rejected(self, client, mock_ch):
        resp = client.get(
            "/api/v1/internal/detector-findings",
            params={"project_id": "p1", "detector_id": "d1"},
        )
        assert resp.status_code == 403

    def test_wrong_secret_rejected(self, client, mock_ch, secret):
        resp = client.get(
            "/api/v1/internal/detector-findings",
            params={"project_id": "p1", "detector_id": "d1"},
            headers={"X-Internal-Secret": "wrong"},
        )
        assert resp.status_code == 403


# =============================================================================
# /detector-counts (#810)
# =============================================================================


class TestListDetectorCounts:
    def _fake_aggregate(self, rows: list[tuple]):
        return _make_query_result(
            rows=rows,
            column_names=["detector_id", "run_count", "finding_count"],
        )

    def test_returns_per_detector_counts(self, client, mock_ch, secret):
        mock_ch.query.side_effect = [
            self._fake_aggregate([("d-a", 100, 7), ("d-b", 25, 0)]),
        ]
        resp = client.get(
            "/api/v1/internal/detector-counts",
            params={
                "project_id": "p1",
                "start_after": "2026-04-20T00:00:00Z",
            },
            headers={"X-Internal-Secret": secret},
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body == {
            "data": {
                "d-a": {"finding_count": 7, "run_count": 100},
                "d-b": {"finding_count": 0, "run_count": 25},
            }
        }

    def test_empty_when_no_runs_in_window(self, client, mock_ch, secret):
        mock_ch.query.side_effect = [self._fake_aggregate([])]
        resp = client.get(
            "/api/v1/internal/detector-counts",
            params={
                "project_id": "p1",
                "start_after": "2026-04-20T00:00:00Z",
            },
            headers={"X-Internal-Secret": secret},
        )
        assert resp.status_code == 200
        assert resp.json() == {"data": {}}

    def test_passes_end_before_when_provided(self, client, mock_ch, secret):
        mock_ch.query.side_effect = [self._fake_aggregate([])]
        client.get(
            "/api/v1/internal/detector-counts",
            params={
                "project_id": "p1",
                "start_after": "2026-04-20T00:00:00Z",
                "end_before": "2026-05-01T00:00:00Z",
            },
            headers={"X-Internal-Secret": secret},
        )
        call_args = mock_ch.query.call_args
        sql = call_args.args[0] if call_args.args else call_args.kwargs.get("query")
        params = call_args.kwargs.get("parameters", {})
        assert "timestamp <" in sql
        assert "end_before" in params

    def test_omits_end_before_when_absent(self, client, mock_ch, secret):
        mock_ch.query.side_effect = [self._fake_aggregate([])]
        client.get(
            "/api/v1/internal/detector-counts",
            params={
                "project_id": "p1",
                "start_after": "2026-04-20T00:00:00Z",
            },
            headers={"X-Internal-Secret": secret},
        )
        call_args = mock_ch.query.call_args
        sql = call_args.args[0] if call_args.args else call_args.kwargs.get("query")
        params = call_args.kwargs.get("parameters", {})
        assert "timestamp <" not in sql or "end_before" not in sql
        assert "end_before" not in params

    def test_requires_internal_secret(self, client, mock_ch):
        resp = client.get(
            "/api/v1/internal/detector-counts",
            params={"project_id": "p1", "start_after": "2026-04-20T00:00:00Z"},
        )
        assert resp.status_code == 403

    def test_requires_start_after(self, client, mock_ch, secret):
        resp = client.get(
            "/api/v1/internal/detector-counts",
            params={"project_id": "p1"},
            headers={"X-Internal-Secret": secret},
        )
        assert resp.status_code == 422
