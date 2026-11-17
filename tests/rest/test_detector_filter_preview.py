"""A detector filter preview reads one authorized trace without running a detector."""

from datetime import UTC, datetime, timedelta
from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient

from rest.main import app
from rest.routers import detectors
from rest.routers.deps import ProjectAccessInfo, get_project_access

URL = "/api/v1/projects/project-1/detectors/preview"


@pytest.fixture()
def preview(monkeypatch):
    trace_reader = MagicMock()
    trace_reader.get_trace.return_value = {"trace_start_time": datetime.now(UTC)}
    summaries = MagicMock(return_value={"trace-1": {"cost": 1.5, "errors": 1}})
    monkeypatch.setattr(detectors, "get_trace_reader_service", lambda: trace_reader)
    monkeypatch.setattr(detectors, "_get_trace_summaries", summaries)
    yield trace_reader, summaries
    app.dependency_overrides.clear()


def _client(plan="enterprise"):
    app.dependency_overrides[get_project_access] = lambda: ProjectAccessInfo(
        project_id="project-1", user_id="user-1", role="ADMIN", billing_plan=plan
    )
    return TestClient(app)


def test_preview_reports_each_condition_without_creating_a_run(preview):
    trace_reader, summaries = preview
    response = _client().post(
        URL,
        json={
            "trace_id": "trace-1",
            "conditions": [
                {"field": "cost", "op": ">", "value": 0.5},
                {"field": "errors", "op": "=", "value": 0},
            ],
        },
    )
    assert response.status_code == 200
    assert response.json() == {
        "trace_id": "trace-1",
        "matches": False,
        "condition_matches": [True, False],
    }
    trace_reader.get_trace.assert_called_once_with(
        project_id="project-1", trace_id="trace-1", source="user"
    )
    summaries.assert_called_once_with("project-1", ["trace-1"])


def test_empty_filter_matches_a_retained_trace(preview):
    response = _client().post(URL, json={"trace_id": "trace-1", "conditions": []})
    assert response.status_code == 200
    assert response.json()["matches"] is True
    assert response.json()["condition_matches"] == []


def test_missing_trace_is_not_previewed(preview):
    trace_reader, summaries = preview
    trace_reader.get_trace.return_value = None
    response = _client().post(URL, json={"trace_id": "missing", "conditions": []})
    assert response.status_code == 404
    summaries.assert_not_called()


def test_retention_is_checked_before_summary_query(preview):
    trace_reader, summaries = preview
    trace_reader.get_trace.return_value = {
        "trace_start_time": datetime.now(UTC) - timedelta(days=30)
    }
    response = _client("free").post(URL, json={"trace_id": "trace-1", "conditions": []})
    assert response.status_code == 403
    summaries.assert_not_called()


@pytest.mark.parametrize(
    "condition",
    [
        {"field": "cost", "op": ">", "value": "many"},
        {"field": "environment", "op": ">", "value": "production"},
        {"field": "metadata", "op": "=", "value": "healthcheck"},
        {"field": "errors", "op": "=", "value": -1},
    ],
)
def test_invalid_draft_returns_422_before_reads(preview, condition):
    trace_reader, summaries = preview
    response = _client().post(URL, json={"trace_id": "trace-1", "conditions": [condition]})
    assert response.status_code == 422
    trace_reader.get_trace.assert_not_called()
    summaries.assert_not_called()


def test_missing_session_is_not_a_preview_authorization(preview):
    trace_reader, summaries = preview
    response = TestClient(app).post(URL, json={"trace_id": "trace-1", "conditions": []})
    assert response.status_code == 401
    trace_reader.get_trace.assert_not_called()
    summaries.assert_not_called()
