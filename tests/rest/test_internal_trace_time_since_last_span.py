"""Unit tests for the internal trace time-since-last-span endpoint.

The detector worker polls this before evaluating: it waits until the trace has
been quiet for EVALUATOR_DELAY (no new span). The endpoint reports only how long
the trace has been quiet — milliseconds since the most recent span was ingested.
"""

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
    monkeypatch.setattr("rest.routers.internal.get_clickhouse_client", lambda: mock)
    return mock


@pytest.fixture()
def client(secret, mock_ch):
    return TestClient(app)


def _age_result(age_ms) -> MagicMock:
    r = MagicMock()
    r.result_rows = [(age_ms,)]
    r.column_names = ["time_since_last_span_ms"]
    return r


class TestTraceTimeSinceLastSpan:
    URL = "/api/v1/internal/traces/trace-abc/time-since-last-span"

    def test_reports_quiet_age(self, client, mock_ch, secret):
        mock_ch.query.return_value = _age_result(17250)
        resp = client.get(
            self.URL, params={"project_id": "p1"}, headers={"X-Internal-Secret": secret}
        )
        assert resp.status_code == 200
        assert resp.json() == {"time_since_last_span_ms": 17250}
        # A single query; the age is computed in ClickHouse (clock-skew safe).
        assert mock_ch.query.call_count == 1
        sql = mock_ch.query.call_args.args[0]
        assert "date_diff" in sql
        assert "max(ch_create_time)" in sql

    def test_empty_trace_reports_zero(self, client, mock_ch, secret):
        # max(ch_create_time) over no rows -> NULL -> age 0 ("not quiet yet").
        mock_ch.query.return_value = _age_result(None)
        resp = client.get(
            self.URL, params={"project_id": "p1"}, headers={"X-Internal-Secret": secret}
        )
        assert resp.status_code == 200
        assert resp.json() == {"time_since_last_span_ms": 0}

    def test_query_filters_by_project_and_trace(self, client, mock_ch, secret):
        mock_ch.query.return_value = _age_result(100)
        client.get(self.URL, params={"project_id": "p1"}, headers={"X-Internal-Secret": secret})
        call = mock_ch.query.call_args
        sql = call.args[0]
        params = call.kwargs["parameters"]
        assert "trace_id = {trace_id:String}" in sql
        assert "project_id = {project_id:String}" in sql
        assert params == {"trace_id": "trace-abc", "project_id": "p1"}

    def test_requires_internal_secret(self, client, mock_ch):
        resp = client.get(self.URL, params={"project_id": "p1"})
        assert resp.status_code == 403
