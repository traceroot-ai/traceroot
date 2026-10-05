"""Integration tests for the public widget reads (public routes + internal mirrors).

``get_widget`` returns what a saved widget is; ``get_widget_data`` returns
what it shows for one window. Both exercise the REAL dual-credential
dependency end-to-end, with the credential introspection routes and the
secret-authed ``project-widget`` Next.js route mocked by ``respx`` and the
query engine patched at the shared handler module, so the public routes and
the internal mirrors run the same body.
"""

import json
from datetime import UTC, datetime, timedelta
from unittest.mock import patch

import httpx
import respx
from fastapi.testclient import TestClient
from httpx import Response

from rest.main import app
from rest.schemas.dashboards import WidgetSpec
from rest.services.widget_query import WidgetSpecError

BASE_URL = "http://localhost:3000"
USER_HEADER = {"Authorization": "Bearer user-session-token"}
KEY_HEADER = {"Authorization": "Bearer tr-some-key"}
USER_OK_BODY = {
    "valid": True,
    "projectId": "proj-A",
    "workspaceId": "ws-1",
    "billingPlan": "enterprise",
    "role": "member",
    "userId": "u1",
}
KEY_OK_BODY = {
    "valid": True,
    "projectId": "proj-A",
    "workspaceId": "ws-1",
    "billingPlan": "enterprise",
    "ingestionBlocked": False,
}
FREE_KEY_BODY = {**KEY_OK_BODY, "billingPlan": "free"}
RUN = "rest.routers.dashboard_read_common.run_widget_query"
DETAIL_PATH = "/api/v1/public/widgets/w-1"
DATA_PATH = "/api/v1/public/widgets/w-1/data"

QUERY_SPEC = {
    "view": "spans",
    "filters": [],
    "metric": {"measure": "cost", "agg": "sum"},
    "breakdown": "model_name",
    "display": {"type": "bar"},
}
SERIES_SPEC = {**QUERY_SPEC, "breakdown": None, "display": {"type": "line"}}


def _widget_body(*, type_: str = "query", spec=None):
    return {
        "widget": {
            "id": "w-1",
            "title": "Cost by model",
            "type": type_,
            "spec": QUERY_SPEC if spec is None else spec,
            "displayConfig": {"color": "blue"},
            "createTime": "2026-08-01T00:00:00Z",
            "updateTime": "2026-08-02T00:00:00Z",
            "dashboard": {"id": "dash-1", "name": "Latency overview"},
        }
    }


DETAIL_EXPECTED = {
    "id": "w-1",
    "title": "Cost by model",
    "type": "query",
    "spec": QUERY_SPEC,
    "create_time": "2026-08-01T00:00:00Z",
    "dashboard_id": "dash-1",
    "dashboard_name": "Latency overview",
    "display_config": {"color": "blue"},
    "update_time": "2026-08-02T00:00:00Z",
}

WIDGET_REF = {"id": "w-1", "dashboard_id": "dash-1", "title": "Cost by model", "type": "query"}


def _mock_key_auth(body=KEY_OK_BODY):
    return respx.post(f"{BASE_URL}/api/internal/validate-api-key").mock(
        return_value=Response(200, json=body)
    )


def _mock_user_auth(body=USER_OK_BODY, status_code=200):
    return respx.post(f"{BASE_URL}/api/internal/validate-user-token").mock(
        return_value=Response(status_code, json=body)
    )


def _mock_widget(body=None, status_code=200):
    return respx.post(f"{BASE_URL}/api/internal/project-widget").mock(
        return_value=Response(status_code, json=_widget_body() if body is None else body)
    )


def _rows(n: int):
    return {
        "columns": ["model_name", "value"],
        "rows": [[f"m{i}", float(i)] for i in range(n)],
        "meta": {},
    }


def _iso(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


# ── get_widget ───────────────────────────────────────────────────────────────


@respx.mock
def test_get_widget_returns_the_definition_with_its_dashboard():
    _mock_user_auth()
    widget = _mock_widget()
    resp = TestClient(app).get(DETAIL_PATH, headers=USER_HEADER, params={"project_id": "proj-A"})
    assert resp.status_code == 200, resp.text
    assert resp.json() == DETAIL_EXPECTED
    # The internal route is keyed by the resolved project, never the credential.
    assert json.loads(widget.calls.last.request.content) == {
        "projectId": "proj-A",
        "widgetId": "w-1",
    }


@respx.mock
def test_get_widget_api_key_reads_its_own_project():
    _mock_key_auth()
    widget = _mock_widget()
    resp = TestClient(app).get(DETAIL_PATH, headers=KEY_HEADER)
    assert resp.status_code == 200, resp.text
    assert resp.json() == DETAIL_EXPECTED
    assert json.loads(widget.calls.last.request.content) == {
        "projectId": "proj-A",
        "widgetId": "w-1",
    }


def test_widget_reads_require_authorization():
    client = TestClient(app, raise_server_exceptions=False)
    for path in (DETAIL_PATH, DATA_PATH):
        assert client.get(path).status_code == 401, path


@respx.mock
def test_user_token_requires_project_id_before_any_internal_call():
    _mock_user_auth()
    widget = _mock_widget()
    client = TestClient(app, raise_server_exceptions=False)
    for path in (DETAIL_PATH, DATA_PATH):
        assert client.get(path, headers=USER_HEADER).status_code == 400, path
    assert widget.call_count == 0


@respx.mock
def test_user_token_without_membership_is_403_before_any_internal_call():
    _mock_user_auth({"valid": False, "hasAccess": False}, status_code=403)
    widget = _mock_widget()
    client = TestClient(app, raise_server_exceptions=False)
    for path in (DETAIL_PATH, DATA_PATH):
        resp = client.get(path, headers=USER_HEADER, params={"project_id": "proj-A"})
        assert resp.status_code == 403, path
    assert widget.call_count == 0


@respx.mock
def test_a_widget_outside_the_project_is_404_with_upstream_detail():
    """Unknown and foreign ids are the same 404: existence never leaks across projects."""
    _mock_key_auth()
    _mock_widget({"error": "Widget not found"}, status_code=404)
    client = TestClient(app, raise_server_exceptions=False)
    with patch(RUN) as run:
        for path in (DETAIL_PATH, DATA_PATH):
            resp = client.get(path, headers=KEY_HEADER)
            assert resp.status_code == 404, path
            assert resp.json()["detail"] == "Widget not found"
    run.assert_not_called()


@respx.mock
def test_get_widget_malformed_upstream_body_is_503_not_500():
    _mock_key_auth()
    _mock_widget({"widget": {"id": "w-1"}})  # missing required fields
    client = TestClient(app, raise_server_exceptions=False)
    resp = client.get(DETAIL_PATH, headers=KEY_HEADER)
    assert resp.status_code == 503


@respx.mock
def test_get_widget_network_error_is_503():
    _mock_key_auth()
    respx.post(f"{BASE_URL}/api/internal/project-widget").mock(
        side_effect=httpx.ConnectError("Connection refused")
    )
    client = TestClient(app, raise_server_exceptions=False)
    resp = client.get(DETAIL_PATH, headers=KEY_HEADER)
    assert resp.status_code == 503


# ── get_widget_data ──────────────────────────────────────────────────────────


@respx.mock
def test_get_widget_data_answers_the_saved_spec_for_a_preset_window():
    _mock_key_auth()
    _mock_widget()
    with patch(RUN, return_value=_rows(3)) as run:
        resp = TestClient(app).get(DATA_PATH, headers=KEY_HEADER, params={"range": "7d"})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["widget"] == WIDGET_REF
    assert body["status"] == "ok"
    assert body["columns"] == ["model_name", "value"]
    assert body["rows"] == _rows(3)["rows"]
    assert body["meta"] == {}
    assert body["truncated"] is False
    assert body["error"] is None
    assert body["window"]["range"] == "7d"
    assert body["window"]["clamped"] is False
    assert _iso(body["window"]["end_time"]) - _iso(body["window"]["start_time"]) == timedelta(
        days=7
    )
    # The stored spec ran, scoped to the credential's project, for that window.
    assert run.call_args.kwargs["project_id"] == "proj-A"
    assert run.call_args.kwargs["spec"] == WidgetSpec.model_validate(QUERY_SPEC)
    assert run.call_args.kwargs["end_time"] - run.call_args.kwargs["start_time"] == timedelta(
        days=7
    )


@respx.mock
def test_no_window_means_the_site_default():
    _mock_key_auth()
    _mock_widget()
    with patch(RUN, return_value=_rows(1)):
        resp = TestClient(app).get(DATA_PATH, headers=KEY_HEADER)
    assert resp.status_code == 200, resp.text
    window = resp.json()["window"]
    assert window["range"] == "1d"
    assert _iso(window["end_time"]) - _iso(window["start_time"]) == timedelta(days=1)


@respx.mock
def test_every_row_the_engine_returns_comes_back_uncapped():
    """One widget has no fan-out to protect: no row cap, and truncated is always false."""
    _mock_key_auth()
    _mock_widget()
    with patch(RUN, return_value=_rows(200)) as run:
        resp = TestClient(app).get(DATA_PATH, headers=KEY_HEADER)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert len(body["rows"]) == 200 and body["truncated"] is False
    assert run.call_args.kwargs["max_rows"] is None


@respx.mock
def test_a_series_over_a_long_window_is_returned_whole():
    """No series ceiling either: a multi-year series is answered, not refused."""
    _mock_key_auth()
    _mock_widget(_widget_body(spec={**QUERY_SPEC, "display": {"type": "line"}}))
    rows = {
        "columns": ["bucket", "model_name", "value"],
        "rows": [[f"2026-06-{1 + i % 28:02d}T00:00:00", "m", float(i)] for i in range(6000)],
        "meta": {"granularity": "day"},
    }
    with patch(RUN, return_value=rows) as run:
        resp = TestClient(app).get(
            DATA_PATH,
            headers=KEY_HEADER,
            params={"start_time": "2021-01-01T00:00:00Z", "end_time": "2026-01-01T00:00:00Z"},
        )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["status"] == "ok"
    assert len(body["rows"]) == 6000 and body["truncated"] is False
    assert body["window"] == {
        "start_time": "2021-01-01T00:00:00Z",
        "end_time": "2026-01-01T00:00:00Z",
        "range": None,
        "clamped": False,
    }
    assert run.call_args.kwargs["max_rows"] is None


@respx.mock
def test_a_trace_feed_is_skipped_without_running_anything():
    _mock_key_auth()
    _mock_widget(_widget_body(type_="trace_feed", spec={"filters": []}))
    with patch(RUN) as run:
        resp = TestClient(app).get(DATA_PATH, headers=KEY_HEADER)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["widget"] == {**WIDGET_REF, "type": "trace_feed"}
    assert body["status"] == "skipped"
    assert body["rows"] is None and body["columns"] is None
    assert body["error"] is None
    assert body["window"]["range"] == "1d"
    run.assert_not_called()


@respx.mock
def test_a_legacy_detector_widget_is_skipped_like_a_feed():
    _mock_key_auth()
    _mock_widget(_widget_body(type_="detector", spec={"detectorId": "det-1"}))
    with patch(RUN) as run:
        resp = TestClient(app).get(DATA_PATH, headers=KEY_HEADER)
    assert resp.status_code == 200, resp.text
    assert resp.json()["status"] == "skipped"
    assert resp.json()["widget"]["type"] == "detector"
    run.assert_not_called()


@respx.mock
def test_a_stored_spec_that_no_longer_validates_is_a_200_error():
    _mock_key_auth()
    _mock_widget(_widget_body(spec={"view": "spans"}))
    with patch(RUN) as run:
        resp = TestClient(app).get(DATA_PATH, headers=KEY_HEADER)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["status"] == "error"
    assert body["error"].startswith("spec: ")
    assert body["rows"] is None
    run.assert_not_called()


@respx.mock
def test_an_engine_rejection_is_a_200_error_with_its_step():
    _mock_key_auth()
    _mock_widget()
    with patch(RUN, side_effect=WidgetSpecError("breakdown", "field is not groupable")):
        resp = TestClient(app).get(DATA_PATH, headers=KEY_HEADER)
    assert resp.status_code == 200, resp.text
    assert resp.json()["status"] == "error"
    assert resp.json()["error"] == "breakdown: field is not groupable"


@respx.mock
def test_an_unexpected_engine_failure_is_reported_generically():
    _mock_key_auth()
    _mock_widget()
    with patch(RUN, side_effect=RuntimeError("clickhouse down")):
        resp = TestClient(app).get(DATA_PATH, headers=KEY_HEADER)
    assert resp.status_code == 200, resp.text
    assert resp.json()["status"] == "error"
    assert resp.json()["error"] == "Widget query failed"


@respx.mock
def test_range_with_bounds_is_422_before_anything_is_fetched():
    _mock_key_auth()
    widget = _mock_widget()
    params = {
        "range": "7d",
        "start_time": "2026-06-01T00:00:00Z",
        "end_time": "2026-06-08T00:00:00Z",
    }
    with patch(RUN) as run:
        resp = TestClient(app).get(DATA_PATH, headers=KEY_HEADER, params=params)
    assert resp.status_code == 422
    assert "either range or start_time/end_time" in str(resp.json()["detail"])
    assert not widget.called
    run.assert_not_called()


@respx.mock
def test_unknown_range_is_a_query_param_validation_error():
    _mock_key_auth()
    resp = TestClient(app).get(DATA_PATH, headers=KEY_HEADER, params={"range": "2w"})
    assert resp.status_code == 422
    assert resp.json()["detail"].startswith("range: Input should be")


@respx.mock
def test_retention_clamp_is_reported_on_the_window():
    _mock_key_auth(FREE_KEY_BODY)
    _mock_widget()
    with patch(RUN, return_value=_rows(1)) as run:
        resp = TestClient(app).get(DATA_PATH, headers=KEY_HEADER, params={"range": "90d"})
    assert resp.status_code == 200, resp.text
    window = resp.json()["window"]
    assert window["clamped"] is True
    floor = datetime.now(UTC).replace(tzinfo=None) - timedelta(days=15, hours=2)
    assert _iso(window["start_time"]).replace(tzinfo=None) >= floor
    assert run.call_args.kwargs["start_time"] == _iso(window["start_time"])


@respx.mock
def test_a_window_entirely_before_retention_is_422_naming_retention():
    _mock_key_auth(FREE_KEY_BODY)
    widget = _mock_widget()
    params = {"start_time": "2020-01-01T00:00:00Z", "end_time": "2020-02-01T00:00:00Z"}
    with patch(RUN) as run:
        resp = TestClient(app).get(DATA_PATH, headers=KEY_HEADER, params=params)
    assert resp.status_code == 422
    assert "before the plan's retention cutoff" in resp.json()["detail"]
    assert not widget.called
    run.assert_not_called()


@respx.mock
def test_get_widget_data_malformed_upstream_body_is_503():
    _mock_key_auth()
    _mock_widget({"widget": {"id": "w-1"}})
    client = TestClient(app, raise_server_exceptions=False)
    with patch(RUN) as run:
        resp = client.get(DATA_PATH, headers=KEY_HEADER)
    assert resp.status_code == 503
    run.assert_not_called()


# ── internal project-scoped mirrors (the in-app agent's dispatch path) ──────


@respx.mock
def test_internal_mirrors_answer_like_the_public_routes(monkeypatch):
    from shared.config import settings

    monkeypatch.setattr(settings, "internal_api_secret", "test-secret")
    _mock_key_auth()
    _mock_widget()
    headers = {"X-Internal-Secret": "test-secret", "x-user-id": "u1"}
    public = TestClient(app).get(DETAIL_PATH, headers=KEY_HEADER)
    internal = TestClient(app).get("/api/v1/internal/projects/proj-A/widgets/w-1", headers=headers)
    assert public.status_code == internal.status_code == 200
    assert public.json() == internal.json()

    params = {"start_time": "2026-06-01T00:00:00Z", "end_time": "2026-06-08T00:00:00Z"}
    with patch(RUN, return_value=_rows(2)):
        public = TestClient(app).get(DATA_PATH, headers=KEY_HEADER, params=params)
        internal = TestClient(app).get(
            "/api/v1/internal/projects/proj-A/widgets/w-1/data", headers=headers, params=params
        )
    assert public.status_code == internal.status_code == 200
    assert public.json() == internal.json()


@respx.mock
def test_internal_mirrors_reject_a_caller_without_the_secret(monkeypatch):
    from shared.config import settings

    monkeypatch.setattr(settings, "internal_api_secret", "test-secret")
    widget = _mock_widget()
    client = TestClient(app, raise_server_exceptions=False)
    for path in (
        "/api/v1/internal/projects/proj-A/widgets/w-1",
        "/api/v1/internal/projects/proj-A/widgets/w-1/data",
    ):
        assert client.get(path, headers={"x-user-id": "u1"}).status_code == 403, path
    assert widget.call_count == 0


def test_widget_mirror_is_off_the_public_project_surface():
    from fastapi.routing import APIRoute

    paths = {r.path for r in app.routes if isinstance(r, APIRoute)}
    assert "/api/v1/projects/{project_id}/widgets/{widget_id}" not in paths
    assert "/api/v1/projects/{project_id}/widgets/{widget_id}/data" not in paths
    assert "/api/v1/internal/projects/{project_id}/widgets/{widget_id}" in paths
    assert "/api/v1/internal/projects/{project_id}/widgets/{widget_id}/data" in paths
