"""Endpoint tests for the widget query router."""

from datetime import datetime
from unittest.mock import MagicMock, patch

import pytest
from fastapi.testclient import TestClient

from rest.main import app
from rest.routers.deps import ProjectAccessInfo, get_project_access


@pytest.fixture()
def client():
    app.dependency_overrides[get_project_access] = lambda: ProjectAccessInfo(
        project_id="proj-1", user_id="user-1", role="admin"
    )
    yield TestClient(app)


VALID_BODY = {
    "spec": {
        "view": "spans",
        "filters": [],
        "metric": {"measure": "cost", "agg": "sum"},
        "breakdown": "model_name",
        "display": {"type": "bar"},
    },
    "start_time": "2026-06-01T00:00:00Z",
    "end_time": "2026-06-08T00:00:00Z",
}


def test_schema_endpoint(client):
    resp = client.get("/api/v1/projects/proj-1/widgets/schema")
    assert resp.status_code == 200
    body = resp.json()
    assert "spans" in body and "traces" in body
    assert body["spans"]["fields"]["cost"]["aggs"]


def test_query_endpoint_executes(client):
    fake = {"columns": ["model_name", "value"], "rows": [["gpt-4o", 1.5]], "meta": {}}
    with patch("rest.routers.dashboards.run_widget_query", return_value=fake) as mock_run:
        resp = client.post("/api/v1/projects/proj-1/widgets/query", json=VALID_BODY)
    assert resp.status_code == 200
    assert resp.json() == fake
    # project scoping comes from the path, never the body
    assert mock_run.call_args.kwargs["project_id"] == "proj-1"


def test_query_endpoint_spec_error_is_422_with_step(client):
    bad = {**VALID_BODY, "spec": {**VALID_BODY["spec"], "breakdown": "cost"}}
    resp = client.post("/api/v1/projects/proj-1/widgets/query", json=bad)
    assert resp.status_code == 422
    detail = resp.json()["detail"]
    assert detail["step"] == "breakdown"


def test_query_endpoint_pydantic_error_is_422(client):
    bad = {**VALID_BODY, "spec": {**VALID_BODY["spec"], "display": {"type": "gauge"}}}
    resp = client.post("/api/v1/projects/proj-1/widgets/query", json=bad)
    assert resp.status_code == 422


def test_query_endpoint_no_auth_is_not_200():
    """Without the dependency override, auth is enforced — must not return 200."""
    # Don't override get_project_access — let it run for real.
    # The real auth dep makes an httpx call that fails fast in tests.
    test_client = TestClient(app, raise_server_exceptions=False)
    resp = test_client.post("/api/v1/projects/proj-1/widgets/query", json=VALID_BODY)
    assert resp.status_code in (401, 503)


# ── field values (builder value dropdowns) ────────────────────────────────────


@pytest.fixture()
def mock_trace_reader():
    reader = MagicMock()
    with patch("rest.routers.dashboards.get_trace_reader_service", return_value=reader):
        yield reader


class TestWidgetFieldValues:
    def test_spans_view_uses_the_span_distinct_query(self, client, mock_trace_reader):
        mock_trace_reader.get_distinct_span_values.return_value = [
            {"value": "gpt-4o", "count": 12},
            {"value": "claude-opus-4-8", "count": 7},
        ]
        resp = client.get("/api/v1/projects/proj-1/widgets/field-values/spans/model_name")
        assert resp.status_code == 200
        body = resp.json()
        assert body["field"] == "model_name"
        assert body["values"][0] == {"value": "gpt-4o", "count": 12}
        kw = mock_trace_reader.get_distinct_span_values.call_args.kwargs
        # project scoping comes from the path; the column is registry-resolved
        assert kw["project_id"] == "proj-1"
        assert kw["column"] == "model_name"
        mock_trace_reader.get_distinct_trace_values.assert_not_called()

    def test_traces_view_uses_the_trace_distinct_query(self, client, mock_trace_reader):
        mock_trace_reader.get_distinct_trace_values.return_value = [{"value": "u-1", "count": 3}]
        resp = client.get("/api/v1/projects/proj-1/widgets/field-values/traces/user_id")
        assert resp.status_code == 200
        assert resp.json()["values"] == [{"value": "u-1", "count": 3}]
        kw = mock_trace_reader.get_distinct_trace_values.call_args.kwargs
        assert kw["project_id"] == "proj-1"
        assert kw["column"] == "user_id"
        mock_trace_reader.get_distinct_span_values.assert_not_called()

    def test_time_window_threads_to_the_service(self, client, mock_trace_reader):
        mock_trace_reader.get_distinct_span_values.return_value = []
        resp = client.get(
            "/api/v1/projects/proj-1/widgets/field-values/spans/environment"
            "?start_time=2026-06-01T00:00:00&end_time=2026-06-02T00:00:00"
        )
        assert resp.status_code == 200
        kw = mock_trace_reader.get_distinct_span_values.call_args.kwargs
        assert kw["start_after"] == datetime(2026, 6, 1, 0, 0, 0)
        assert kw["end_before"] == datetime(2026, 6, 2, 0, 0, 0)

    def test_no_window_passes_none_bounds(self, client, mock_trace_reader):
        """The service itself defaults a lookback; the endpoint passes what it got."""
        mock_trace_reader.get_distinct_span_values.return_value = []
        resp = client.get("/api/v1/projects/proj-1/widgets/field-values/spans/status")
        assert resp.status_code == 200
        kw = mock_trace_reader.get_distinct_span_values.call_args.kwargs
        assert kw["start_after"] is None
        assert kw["end_before"] is None

    def test_unknown_view_is_404(self, client, mock_trace_reader):
        resp = client.get("/api/v1/projects/proj-1/widgets/field-values/sessions/name")
        assert resp.status_code == 404
        mock_trace_reader.get_distinct_span_values.assert_not_called()

    def test_unknown_field_is_404(self, client, mock_trace_reader):
        resp = client.get("/api/v1/projects/proj-1/widgets/field-values/spans/not_a_field")
        assert resp.status_code == 404
        mock_trace_reader.get_distinct_span_values.assert_not_called()

    def test_numeric_field_is_400(self, client, mock_trace_reader):
        resp = client.get("/api/v1/projects/proj-1/widgets/field-values/spans/cost")
        assert resp.status_code == 400
        mock_trace_reader.get_distinct_span_values.assert_not_called()

    def test_count_field_is_400(self, client, mock_trace_reader):
        resp = client.get("/api/v1/projects/proj-1/widgets/field-values/spans/count")
        assert resp.status_code == 400
        mock_trace_reader.get_distinct_span_values.assert_not_called()
