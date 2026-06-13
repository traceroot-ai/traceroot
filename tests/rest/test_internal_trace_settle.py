"""Unit tests for the internal trace settle-status endpoint.

The detector worker polls this before evaluating a trace: streaming roots
export before their children, so a trace with dangling parent_span_ids is
still in flight and the evaluation job must be bounced.
"""

import hashlib
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
    r = MagicMock()
    r.result_rows = rows
    r.column_names = column_names
    return r


def _agg(root_present: int, span_count: int, age_seconds: float) -> MagicMock:
    return _make_query_result(
        rows=[(root_present, span_count, age_seconds)],
        column_names=["root_present", "span_count", "last_arrival_age_seconds"],
    )


def _dangling(ids: list[str]) -> MagicMock:
    return _make_query_result(
        rows=[(i,) for i in ids],
        column_names=["parent_span_id"],
    )


class TestTraceSettleStatus:
    URL = "/api/v1/internal/traces/trace-abc/settle-status"

    def test_settled_trace(self, client, mock_ch, secret):
        mock_ch.query.side_effect = [_agg(1, 5, 2.5), _dangling([])]
        resp = client.get(
            self.URL,
            params={"project_id": "p1"},
            headers={"X-Internal-Secret": secret},
        )
        assert resp.status_code == 200
        assert resp.json() == {
            "root_present": True,
            "span_count": 5,
            "dangling_count": 0,
            "dangling_hash": "",
            "last_arrival_age_seconds": 2.5,
        }

    def test_in_flight_trace_dangling_hash_is_sha256_of_sorted_ids(self, client, mock_ch, secret):
        # Unsorted on purpose: the hash must be over the sorted, comma-joined
        # ids so the same dangling set always hashes identically.
        mock_ch.query.side_effect = [_agg(1, 3, 0.4), _dangling(["span-b", "span-a"])]
        resp = client.get(
            self.URL,
            params={"project_id": "p1"},
            headers={"X-Internal-Secret": secret},
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["root_present"] is True
        assert body["span_count"] == 3
        assert body["dangling_count"] == 2
        expected = hashlib.sha256(b"span-a,span-b").hexdigest()
        assert body["dangling_hash"] == expected

    def test_zero_span_trace_returns_all_zero_without_dangling_query(self, client, mock_ch, secret):
        mock_ch.query.side_effect = [_agg(0, 0, 0.0)]
        resp = client.get(
            self.URL,
            params={"project_id": "p1"},
            headers={"X-Internal-Secret": secret},
        )
        assert resp.status_code == 200
        assert resp.json() == {
            "root_present": False,
            "span_count": 0,
            "dangling_count": 0,
            "dangling_hash": "",
            "last_arrival_age_seconds": 0.0,
        }
        # The dangling-id lookup is skipped for an empty trace.
        assert mock_ch.query.call_count == 1

    def test_age_computed_in_clickhouse_and_passed_through(self, client, mock_ch, secret):
        mock_ch.query.side_effect = [_agg(0, 2, 17.25), _dangling(["root-x"])]
        resp = client.get(
            self.URL,
            params={"project_id": "p1"},
            headers={"X-Internal-Secret": secret},
        )
        body = resp.json()
        assert body["last_arrival_age_seconds"] == 17.25
        assert body["root_present"] is False
        # Age must come from ClickHouse (clock-skew safe), not Python.
        agg_sql = mock_ch.query.call_args_list[0].args[0]
        assert "date_diff" in agg_sql
        assert "max(ch_create_time)" in agg_sql

    def test_queries_filter_by_project_and_trace(self, client, mock_ch, secret):
        mock_ch.query.side_effect = [_agg(1, 1, 0.1), _dangling([])]
        client.get(
            self.URL,
            params={"project_id": "p1"},
            headers={"X-Internal-Secret": secret},
        )
        for call in mock_ch.query.call_args_list:
            sql = call.args[0]
            params = call.kwargs["parameters"]
            assert "trace_id = {trace_id:String}" in sql
            assert "project_id = {project_id:String}" in sql
            assert params == {"trace_id": "trace-abc", "project_id": "p1"}

    def test_requires_internal_secret(self, client, mock_ch):
        resp = client.get(self.URL, params={"project_id": "p1"})
        assert resp.status_code == 403
