"""The bounded SQL tool of the background update: time bound, row cap, scope."""

from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient

from rest.main import app
from rest.services.sql.service import SqlColumn, SqlResult
from shared.config import settings

URL = "/api/v1/internal/update-sql"
DAY = (
    "SELECT name, count() FROM spans WHERE span_start_time >= '2026-10-26 09:00:00' "
    "AND span_start_time < '2026-10-26 21:00:00' GROUP BY name"
)


@pytest.fixture()
def secret(monkeypatch):
    monkeypatch.setattr(settings, "internal_api_secret", "test-secret")
    return {"X-Internal-Secret": "test-secret"}


@pytest.fixture()
def service(monkeypatch):
    mock = MagicMock()
    mock.return_value.run.return_value = SqlResult(
        columns=[SqlColumn(name="name", type="String"), SqlColumn(name="count()", type="UInt64")],
        rows=[["support_agent", 4]],
        row_count=1,
        truncated=False,
        elapsed_ms=3,
    )
    monkeypatch.setattr("rest.routers.internal.update_sql.SqlQueryService", mock)
    return mock.return_value


def post(secret, query, **extra):
    return TestClient(app).post(
        URL, json={"project_id": "p1", "query": query, **extra}, headers=secret
    )


def test_requires_the_secret(service):
    response = TestClient(app).post(URL, json={"project_id": "p1", "query": DAY})
    assert response.status_code in (401, 403)
    service.run.assert_not_called()


def test_runs_a_query_bounded_to_hours(secret, service):
    response = post(secret, DAY)
    assert response.status_code == 200
    assert response.json()["rows"] == [["support_agent", 4]]
    assert service.run.call_args.kwargs["max_rows"] == 200


def test_refuses_a_raw_seven_day_scan(secret, service):
    week = DAY.replace("2026-10-26 21:00:00", "2026-11-02 09:00:00")
    response = post(secret, week)
    assert response.status_code == 422
    assert "wider than the limit" in response.json()["detail"]
    service.run.assert_not_called()


@pytest.mark.parametrize(
    "query",
    [
        "SELECT count() FROM spans",
        "SELECT count() FROM spans WHERE span_start_time >= '2026-10-26 09:00:00'",
        "SELECT count() FROM traces",
    ],
)
def test_refuses_a_query_with_no_time_range(secret, service, query):
    assert post(secret, query).status_code == 422
    service.run.assert_not_called()


def test_refuses_writes_and_unknown_tables(secret, service):
    assert post(secret, "DROP TABLE spans").status_code == 422
    assert post(secret, "SELECT * FROM system.tables").status_code == 422
    service.run.assert_not_called()


def test_caps_the_rows_however_many_are_asked_for(secret, service):
    post(secret, DAY, max_rows=100000)
    assert service.run.call_args.kwargs["max_rows"] == 200
