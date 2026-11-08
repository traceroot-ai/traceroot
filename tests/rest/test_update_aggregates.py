"""The internal window-aggregates endpoint used by the background update.

The SQL itself is proven against a seeded live ClickHouse (the seeding script's
``verify`` checks every number); these tests pin the contract around it: the
secret gate, the window bounds, the customer-traffic filter on every read, and
the shape of the response.
"""

from datetime import datetime
from decimal import Decimal
from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient

from rest.main import app
from shared.config import settings

URL = "/api/v1/internal/update-aggregates"
WINDOW = {
    "project_id": "p1",
    "start": "2026-10-26T09:00:00Z",
    "end": "2026-11-02T09:00:00Z",
}


@pytest.fixture()
def secret(monkeypatch):
    monkeypatch.setattr(settings, "internal_api_secret", "test-secret")
    return {"X-Internal-Secret": "test-secret"}


@pytest.fixture()
def mock_ch(monkeypatch):
    mock = MagicMock()

    def query(sql, parameters=None, settings=None):
        result = MagicMock()
        if "toStartOfFifteenMinutes" in sql:
            # 2026-10-27 22:30 UTC, which is already the 28th in Auckland.
            result.result_rows = [("gpt-4o", 1793140200, 100, Decimal("0.5"))]
        elif (
            "spans_public_v1" in sql
            and "span_kind = 'LLM'" in sql
            and "model_name IS NOT NULL" in sql
        ):
            result.result_rows = [("gpt-4o", 2, 100, Decimal("0.5"))]
        elif "span_kind = 'LLM'" in sql:
            result.result_rows = [(2, 80, 20, 100, Decimal("0.5"))]
        elif "span_kind = 'TOOL'" in sql:
            result.result_rows = [("search_docs", 3, 1)]
        elif "GROUP BY name" in sql:
            result.result_rows = [("support_agent", 4, 1, 1200.0, 3000.0)]
        elif "GROUP BY git_ref" in sql:
            result.result_rows = [("abc123", 4, 1, 1200.0, 3000.0)]
        else:
            result.result_rows = [(4, 1, 1200.0, 3000.0, 3500.0, 4)]
        return result

    mock.query.side_effect = query
    monkeypatch.setattr(
        "rest.routers.internal.update_aggregates.get_clickhouse_client", lambda: mock
    )
    return mock


def test_requires_the_internal_secret(mock_ch):
    assert TestClient(app).get(URL, params=WINDOW).status_code in (401, 403)
    assert mock_ch.query.call_count == 0


def test_returns_the_window_shape(secret, mock_ch):
    body = TestClient(app).get(URL, params=WINDOW, headers=secret).json()
    assert body["totals"] == {
        "traces": 4,
        "error_traces": 1,
        "p50_ms": 1200,
        "p95_ms": 3000,
        "p99_ms": 3500,
        "git_context_traces": 4,
    }
    assert body["llm"]["cost"] == "0.5"
    assert body["by_model"] == [{"model": "gpt-4o", "calls": 2, "total_tokens": 100, "cost": "0.5"}]
    assert body["by_model_day"][0]["day"] == "2026-10-27"
    assert body["tools"] == [{"name": "search_docs", "calls": 3, "errors": 1}]
    assert body["workflows"][0]["name"] == "support_agent"
    assert body["refs"][0]["name"] == "abc123"
    assert datetime.fromisoformat(body["start"]).hour == 9


def test_every_read_is_scoped_and_limited_to_customer_traffic(secret, mock_ch):
    TestClient(app).get(URL, params=WINDOW, headers=secret)
    assert mock_ch.query.call_count == 7
    for call in mock_ch.query.call_args_list:
        sql = call.args[0]
        # The curated views: latest version of each row, customer traffic only, scoped
        # and bounded by project and time.
        assert "_public_v1(project_id = {project_id:String}" in sql
        assert "start_time = {start:DateTime64(3)}" in sql
        assert "FROM spans " not in sql and "FROM traces " not in sql
        assert call.kwargs["parameters"]["project_id"] == "p1"
        assert call.kwargs["settings"]["max_execution_time"] > 0


@pytest.mark.parametrize(
    "start,end",
    [
        ("2026-11-02T09:00:00Z", "2026-11-02T09:00:00Z"),
        ("2026-11-03T09:00:00Z", "2026-11-02T09:00:00Z"),
        ("2026-10-01T09:00:00Z", "2026-11-02T09:00:00Z"),
    ],
)
def test_rejects_an_empty_inverted_or_oversize_window(secret, mock_ch, start, end):
    response = TestClient(app).get(
        URL, params={"project_id": "p1", "start": start, "end": end}, headers=secret
    )
    assert response.status_code == 422
    assert mock_ch.query.call_count == 0


def test_an_empty_window_reports_zero_latency_not_an_error(secret, mock_ch):
    base = mock_ch.query.side_effect

    def empty(sql, parameters=None, settings=None):
        result = base(sql, parameters=parameters, settings=settings)
        if "quantileExact(0.99)" in sql:
            result.result_rows = [(0, 0, float("nan"), float("nan"), float("nan"), 0)]
        return result

    mock_ch.query.side_effect = empty
    response = TestClient(app).get(URL, params=WINDOW, headers=secret)
    assert response.status_code == 200
    assert response.json()["totals"]["p95_ms"] == 0


def test_days_follow_the_project_timezone(secret, mock_ch):
    client = TestClient(app)
    utc = client.get(URL, params=WINDOW, headers=secret).json()
    auckland = client.get(URL, params={**WINDOW, "tz": "Pacific/Auckland"}, headers=secret).json()
    assert utc["by_model_day"][0]["day"] == "2026-10-27"
    assert auckland["by_model_day"][0]["day"] == "2026-10-28"


def test_an_unknown_timezone_is_a_client_error(secret, mock_ch):
    response = TestClient(app).get(URL, params={**WINDOW, "tz": "Mars/Base"}, headers=secret)
    assert response.status_code == 422
