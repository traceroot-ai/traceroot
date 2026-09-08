"""Endpoint tests for the widget query router."""

from datetime import UTC, datetime, timedelta
from unittest.mock import MagicMock, patch

import pytest
from fastapi.testclient import TestClient

from rest.main import app
from rest.routers.deps import ProjectAccessInfo, get_project_access


def _override_plan(billing_plan: str):
    # Mirror the validate-project-access contract (workspaceId + billingPlan)
    # so get_rate_limited_project_access stamps a real workspace for the
    # per-workspace rate limiter.
    app.dependency_overrides[get_project_access] = lambda: ProjectAccessInfo(
        project_id="proj-1",
        user_id="user-1",
        role="admin",
        workspace_id="ws-test",
        billing_plan=billing_plan,
    )
    return TestClient(app)


@pytest.fixture()
def client():
    # Free plan (15-day retention) — exercises the retention clamp path.
    yield _override_plan("free")


@pytest.fixture()
def enterprise_client():
    # Unlimited retention: no clamp, so an endpoint's raw window threads through
    # verbatim — isolates the plumbing from the retention gate.
    yield _override_plan("enterprise")


# ~ now - 15 days, minus a generous slack for the 1h buffer and test runtime;
# a clamped free-plan start must land at or after this.
def _free_clamp_floor():
    return datetime.now(UTC).replace(tzinfo=None) - timedelta(days=15, hours=2)


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


def test_query_endpoint_executes(enterprise_client):
    # Unlimited retention, so the fixed June window is answered as given and
    # the echo below is exact; the clamp path has its own test.
    fake = {"columns": ["model_name", "value"], "rows": [["gpt-4o", 1.5]], "meta": {}}
    with patch(
        "rest.routers.dashboard_read_common.run_widget_query", return_value=fake
    ) as mock_run:
        resp = enterprise_client.post("/api/v1/projects/proj-1/widgets/query", json=VALID_BODY)
    assert resp.status_code == 200
    # The result is the query engine's plus the window it was answered for.
    assert resp.json() == {
        **fake,
        "window": {
            "start_time": "2026-06-01T00:00:00Z",
            "end_time": "2026-06-08T00:00:00Z",
            "range": None,
            "clamped": False,
        },
    }
    # project scoping comes from the path, never the body
    assert mock_run.call_args.kwargs["project_id"] == "proj-1"


def test_query_clamps_start_for_limited_plan(client):
    # Free plan: a window that starts before the cutoff but ends inside it has
    # its start pulled to the cutoff before hitting ClickHouse, matching every
    # other data endpoint. (A window entirely before the cutoff is a 422 — see
    # the test below — since clamping it would only invert it.)
    end = datetime.now(UTC).replace(microsecond=0)
    body = {**VALID_BODY, "start_time": "2020-01-01T00:00:00Z", "end_time": end.isoformat()}
    fake = {"columns": [], "rows": [], "meta": {}}
    with patch(
        "rest.routers.dashboard_read_common.run_widget_query", return_value=fake
    ) as mock_run:
        resp = client.post("/api/v1/projects/proj-1/widgets/query", json=body)
    assert resp.status_code == 200
    clamped = mock_run.call_args.kwargs["start_time"]
    assert clamped > datetime(2020, 1, 2, tzinfo=UTC)  # not the ancient input
    assert clamped.replace(tzinfo=None) >= _free_clamp_floor()  # pulled up to ~ now - 15 days
    assert resp.json()["window"]["clamped"] is True


def test_query_rejects_a_window_entirely_before_retention(client):
    body = {**VALID_BODY, "start_time": "2020-01-01T00:00:00Z", "end_time": "2020-02-01T00:00:00Z"}
    with patch("rest.routers.dashboard_read_common.run_widget_query") as mock_run:
        resp = client.post("/api/v1/projects/proj-1/widgets/query", json=body)
    assert resp.status_code == 422
    assert "before the plan's retention cutoff" in resp.json()["detail"]
    mock_run.assert_not_called()


def test_query_preserves_window_for_unlimited_plan(enterprise_client):
    # Enterprise (unlimited retention): the body window reaches the query verbatim.
    body = {**VALID_BODY, "start_time": "2020-01-01T00:00:00Z", "end_time": "2020-02-01T00:00:00Z"}
    fake = {"columns": [], "rows": [], "meta": {}}
    with patch(
        "rest.routers.dashboard_read_common.run_widget_query", return_value=fake
    ) as mock_run:
        resp = enterprise_client.post("/api/v1/projects/proj-1/widgets/query", json=body)
    assert resp.status_code == 200
    assert mock_run.call_args.kwargs["start_time"] == datetime(2020, 1, 1, tzinfo=UTC)


def test_query_endpoint_spec_error_is_422_with_step(enterprise_client):
    # Unlimited retention so the clamp can't invert VALID_BODY's fixed window;
    # this isolates spec (breakdown) validation, which is plan-agnostic.
    bad = {**VALID_BODY, "spec": {**VALID_BODY["spec"], "breakdown": "cost"}}
    resp = enterprise_client.post("/api/v1/projects/proj-1/widgets/query", json=bad)
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
def mock_discovery():
    service = MagicMock()
    with patch("rest.routers.dashboards.get_trace_discovery_service", return_value=service):
        yield service


class TestWidgetFieldValues:
    def test_spans_view_uses_the_span_distinct_query(self, client, mock_discovery):
        mock_discovery.get_distinct_span_values.return_value = [
            {"value": "gpt-4o", "count": 12},
            {"value": "claude-opus-4-8", "count": 7},
        ]
        resp = client.get("/api/v1/projects/proj-1/widgets/field-values/spans/model_name")
        assert resp.status_code == 200
        body = resp.json()
        assert body["field"] == "model_name"
        assert body["values"][0] == {"value": "gpt-4o", "count": 12}
        kw = mock_discovery.get_distinct_span_values.call_args.kwargs
        # project scoping comes from the path; the column is registry-resolved
        assert kw["project_id"] == "proj-1"
        assert kw["column"] == "model_name"
        mock_discovery.get_distinct_trace_values.assert_not_called()

    def test_traces_view_uses_the_trace_distinct_query(self, client, mock_discovery):
        mock_discovery.get_distinct_trace_values.return_value = [{"value": "u-1", "count": 3}]
        resp = client.get("/api/v1/projects/proj-1/widgets/field-values/traces/user_id")
        assert resp.status_code == 200
        assert resp.json()["values"] == [{"value": "u-1", "count": 3}]
        kw = mock_discovery.get_distinct_trace_values.call_args.kwargs
        assert kw["project_id"] == "proj-1"
        assert kw["column"] == "user_id"
        mock_discovery.get_distinct_span_values.assert_not_called()

    def test_time_window_threads_to_the_service(self, enterprise_client, mock_discovery):
        # Unlimited retention: the requested window reaches the service verbatim.
        mock_discovery.get_distinct_span_values.return_value = []
        resp = enterprise_client.get(
            "/api/v1/projects/proj-1/widgets/field-values/spans/environment"
            "?start_time=2026-06-01T00:00:00&end_time=2026-06-02T00:00:00"
        )
        assert resp.status_code == 200
        kw = mock_discovery.get_distinct_span_values.call_args.kwargs
        assert kw["start_after"] == datetime(2026, 6, 1, 0, 0, 0)
        assert kw["end_before"] == datetime(2026, 6, 2, 0, 0, 0)

    def test_no_window_passes_none_bounds(self, enterprise_client, mock_discovery):
        """Unlimited retention: the service itself defaults a lookback; the endpoint passes None."""
        mock_discovery.get_distinct_span_values.return_value = []
        resp = enterprise_client.get("/api/v1/projects/proj-1/widgets/field-values/spans/status")
        assert resp.status_code == 200
        kw = mock_discovery.get_distinct_span_values.call_args.kwargs
        assert kw["start_after"] is None
        assert kw["end_before"] is None

    def test_out_of_window_start_is_clamped_for_limited_plan(self, client, mock_discovery):
        # Free plan (15-day retention): a request reaching past the window is
        # silently pulled forward to the cutoff — the server-side safety net.
        mock_discovery.get_distinct_span_values.return_value = []
        resp = client.get(
            "/api/v1/projects/proj-1/widgets/field-values/spans/environment"
            "?start_time=2020-01-01T00:00:00"
        )
        assert resp.status_code == 200
        clamped = mock_discovery.get_distinct_span_values.call_args.kwargs["start_after"]
        assert clamped > datetime(2020, 1, 2)  # not the ancient input
        assert clamped >= _free_clamp_floor()  # pulled up to ~ now - 15 days

    def test_missing_start_is_clamped_for_limited_plan(self, client, mock_discovery):
        # Free plan with no start_time would otherwise scan back to day zero.
        mock_discovery.get_distinct_span_values.return_value = []
        resp = client.get("/api/v1/projects/proj-1/widgets/field-values/spans/status")
        assert resp.status_code == 200
        clamped = mock_discovery.get_distinct_span_values.call_args.kwargs["start_after"]
        assert clamped is not None
        assert clamped >= _free_clamp_floor()

    def test_unknown_view_is_404(self, client, mock_discovery):
        resp = client.get("/api/v1/projects/proj-1/widgets/field-values/sessions/name")
        assert resp.status_code == 404
        mock_discovery.get_distinct_span_values.assert_not_called()

    def test_unknown_field_is_404(self, client, mock_discovery):
        resp = client.get("/api/v1/projects/proj-1/widgets/field-values/spans/not_a_field")
        assert resp.status_code == 404
        mock_discovery.get_distinct_span_values.assert_not_called()

    def test_numeric_field_is_400(self, client, mock_discovery):
        resp = client.get("/api/v1/projects/proj-1/widgets/field-values/spans/cost")
        assert resp.status_code == 400
        mock_discovery.get_distinct_span_values.assert_not_called()

    def test_count_field_is_400(self, client, mock_discovery):
        resp = client.get("/api/v1/projects/proj-1/widgets/field-values/spans/count")
        assert resp.status_code == 400
        mock_discovery.get_distinct_span_values.assert_not_called()


# ── window presets (the agent and the CLI describe a window by preset id) ─────


def _query_with(client, body, fake=None):
    fake = fake if fake is not None else {"columns": [], "rows": [], "meta": {}}
    with patch(
        "rest.routers.dashboard_read_common.run_widget_query", return_value=fake
    ) as mock_run:
        resp = client.post("/api/v1/projects/proj-1/widgets/query", json=body)
    return resp, mock_run


def test_query_accepts_a_range_preset_and_echoes_it(enterprise_client):
    body = {"spec": VALID_BODY["spec"], "range": "7d"}
    before = datetime.now(UTC)
    resp, mock_run = _query_with(enterprise_client, body)
    after = datetime.now(UTC)
    assert resp.status_code == 200
    window = resp.json()["window"]
    assert window["range"] == "7d"
    assert window["clamped"] is False
    end = datetime.fromisoformat(window["end_time"].replace("Z", "+00:00"))
    start = datetime.fromisoformat(window["start_time"].replace("Z", "+00:00"))
    assert before <= end <= after
    assert end - start == timedelta(days=7)
    # The resolved bounds are what the query engine saw.
    assert mock_run.call_args.kwargs["start_time"] == start
    assert mock_run.call_args.kwargs["end_time"] == end


def test_query_with_no_window_uses_the_site_default(enterprise_client):
    resp, _ = _query_with(enterprise_client, {"spec": VALID_BODY["spec"]})
    assert resp.status_code == 200
    window = resp.json()["window"]
    assert window["range"] == "1d"
    end = datetime.fromisoformat(window["end_time"].replace("Z", "+00:00"))
    start = datetime.fromisoformat(window["start_time"].replace("Z", "+00:00"))
    assert end - start == timedelta(days=1)


def test_query_reports_a_retention_clamp_on_the_window(client):
    # Free plan (15-day retention) asked for 90 days: the start is pulled up to
    # the cutoff, and the response says so instead of silently narrowing.
    resp, mock_run = _query_with(client, {"spec": VALID_BODY["spec"], "range": "90d"})
    assert resp.status_code == 200
    window = resp.json()["window"]
    assert window["range"] == "90d"
    assert window["clamped"] is True
    start = datetime.fromisoformat(window["start_time"].replace("Z", "+00:00"))
    assert start.replace(tzinfo=None) >= _free_clamp_floor()
    # The engine sees the clamped, aware start the window echoes.
    assert mock_run.call_args.kwargs["start_time"] == start


def test_query_rejects_range_alongside_explicit_bounds(enterprise_client):
    resp, mock_run = _query_with(enterprise_client, {**VALID_BODY, "range": "7d"})
    assert resp.status_code == 422
    assert "either range or start_time/end_time" in str(resp.json()["detail"])
    mock_run.assert_not_called()


def test_query_rejects_an_unknown_range_before_querying(enterprise_client):
    # The schema advertises the ids as an enum, so an unknown one is a body
    # validation error naming the field — and nothing is queried.
    resp, mock_run = _query_with(enterprise_client, {"spec": VALID_BODY["spec"], "range": "2w"})
    assert resp.status_code == 422
    assert resp.json()["detail"][0]["loc"] == ["body", "range"]
    mock_run.assert_not_called()


def test_query_rejects_one_bound_without_the_other(enterprise_client):
    body = {"spec": VALID_BODY["spec"], "start_time": "2026-06-01T00:00:00Z"}
    resp, mock_run = _query_with(enterprise_client, body)
    assert resp.status_code == 422
    assert "both start_time and end_time" in str(resp.json()["detail"])
    mock_run.assert_not_called()
