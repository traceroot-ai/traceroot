"""Integration tests for the public widget query.

Exercise the REAL dual-credential dependency and the route end-to-end, with
the credential introspection routes mocked by ``respx`` and the query engine
patched at the shared handler (``rest.routers.dashboard_read_common``) — the
same body the internal ``/widgets/query`` mirror runs, so behaviour cannot
drift between the surfaces.
"""

from datetime import UTC, datetime, timedelta
from unittest.mock import patch

import respx
from fastapi.testclient import TestClient
from httpx import Response

from rest.main import app

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

SPEC = {
    "view": "spans",
    "filters": [],
    "metric": {"measure": "cost", "agg": "sum"},
    "breakdown": "model_name",
    "display": {"type": "bar"},
}
FAKE = {"columns": ["model_name", "value"], "rows": [["gpt-4o", 1.5]], "meta": {}}
PATH = "/api/v1/public/widgets/query"


def _mock_user_auth():
    return respx.post(f"{BASE_URL}/api/internal/validate-user-token").mock(
        return_value=Response(200, json=USER_OK_BODY)
    )


def _mock_key_auth(body=KEY_OK_BODY):
    return respx.post(f"{BASE_URL}/api/internal/validate-api-key").mock(
        return_value=Response(200, json=body)
    )


def _post(body, headers, params=None, fake=FAKE):
    with patch("rest.routers.dashboard_read_common.run_widget_query", return_value=fake) as run:
        resp = TestClient(app).post(PATH, json=body, headers=headers, params=params)
    return resp, run


def _iso(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


@respx.mock
def test_user_credential_queries_its_project_for_a_preset_window():
    _mock_user_auth()
    before = datetime.now(UTC)
    resp, run = _post({"spec": SPEC, "range": "7d"}, USER_HEADER, params={"project_id": "proj-A"})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert (body["columns"], body["rows"], body["meta"]) == (FAKE["columns"], FAKE["rows"], {})
    assert body["window"]["range"] == "7d"
    assert body["window"]["clamped"] is False
    assert _iso(body["window"]["end_time"]) - _iso(body["window"]["start_time"]) == timedelta(
        days=7
    )
    assert _iso(body["window"]["end_time"]) >= before
    # Project scoping comes from the credential, never the body.
    assert run.call_args.kwargs["project_id"] == "proj-A"


@respx.mock
def test_api_key_queries_the_key_project_with_explicit_bounds():
    _mock_key_auth()
    body = {"spec": SPEC, "start_time": "2026-06-01T00:00:00Z", "end_time": "2026-06-08T00:00:00Z"}
    resp, run = _post(body, KEY_HEADER)
    assert resp.status_code == 200, resp.text
    assert resp.json()["window"] == {
        "start_time": "2026-06-01T00:00:00Z",
        "end_time": "2026-06-08T00:00:00Z",
        "range": None,
        "clamped": False,
    }
    assert run.call_args.kwargs["project_id"] == "proj-A"


@respx.mock
def test_no_window_means_the_site_default():
    _mock_key_auth()
    resp, _ = _post({"spec": SPEC}, KEY_HEADER)
    assert resp.status_code == 200, resp.text
    window = resp.json()["window"]
    assert window["range"] == "1d"
    assert _iso(window["end_time"]) - _iso(window["start_time"]) == timedelta(days=1)


@respx.mock
def test_retention_clamp_is_reported_not_silent():
    _mock_key_auth(FREE_KEY_BODY)
    resp, run = _post({"spec": SPEC, "range": "90d"}, KEY_HEADER)
    assert resp.status_code == 200, resp.text
    window = resp.json()["window"]
    assert window["clamped"] is True
    floor = datetime.now(UTC).replace(tzinfo=None) - timedelta(days=15, hours=2)
    assert _iso(window["start_time"]).replace(tzinfo=None) >= floor
    assert run.call_args.kwargs["start_time"] == _iso(window["start_time"])


@respx.mock
def test_range_with_bounds_is_422_and_nothing_runs():
    _mock_key_auth()
    body = {
        "spec": SPEC,
        "range": "7d",
        "start_time": "2026-06-01T00:00:00Z",
        "end_time": "2026-06-08T00:00:00Z",
    }
    resp, run = _post(body, KEY_HEADER)
    assert resp.status_code == 422
    assert "either range or start_time/end_time" in str(resp.json()["detail"])
    run.assert_not_called()


@respx.mock
def test_spec_error_is_422_with_its_step():
    _mock_key_auth()
    from rest.services.widget_query import WidgetSpecError

    with patch(
        "rest.routers.dashboard_read_common.run_widget_query",
        side_effect=WidgetSpecError("breakdown", "not groupable"),
    ):
        resp = TestClient(app).post(PATH, json={"spec": SPEC}, headers=KEY_HEADER)
    assert resp.status_code == 422
    assert resp.json()["detail"] == {"step": "breakdown", "message": "not groupable"}


@respx.mock
def test_a_window_entirely_before_retention_is_422_naming_retention():
    _mock_key_auth(FREE_KEY_BODY)
    body = {"spec": SPEC, "start_time": "2020-01-01T00:00:00Z", "end_time": "2020-02-01T00:00:00Z"}
    resp, run = _post(body, KEY_HEADER)
    assert resp.status_code == 422
    assert "before the plan's retention cutoff" in resp.json()["detail"]
    run.assert_not_called()


@respx.mock
def test_an_unexpected_engine_failure_is_a_500_with_a_generic_detail():
    _mock_key_auth()
    with patch(
        "rest.routers.dashboard_read_common.run_widget_query", side_effect=RuntimeError("down")
    ):
        resp = TestClient(app).post(PATH, json={"spec": SPEC}, headers=KEY_HEADER)
    assert resp.status_code == 500
    assert resp.json()["detail"] == "Widget query failed"


@respx.mock
def test_user_credential_requires_project_id():
    _mock_user_auth()
    resp, run = _post({"spec": SPEC}, USER_HEADER)
    assert resp.status_code == 400
    run.assert_not_called()


def test_requires_authorization():
    resp, run = _post({"spec": SPEC}, {})
    assert resp.status_code == 401
    run.assert_not_called()


@respx.mock
def test_public_and_internal_routes_answer_alike(monkeypatch):
    """The public route and the internal ``/widgets/query`` mirror share one
    handler, so the same body yields the same answer and window."""
    from shared.config import settings

    monkeypatch.setattr(settings, "internal_api_secret", "test-secret")
    _mock_key_auth()
    body = {"spec": SPEC, "start_time": "2026-06-01T00:00:00Z", "end_time": "2026-06-08T00:00:00Z"}
    public, _ = _post(body, KEY_HEADER)
    from rest.routers.deps import ProjectAccessInfo, get_project_access

    app.dependency_overrides[get_project_access] = lambda: ProjectAccessInfo(
        project_id="proj-A",
        user_id="u1",
        role="admin",
        workspace_id="ws-1",
        billing_plan="enterprise",
    )
    try:
        with patch("rest.routers.dashboard_read_common.run_widget_query", return_value=FAKE):
            internal = TestClient(app).post("/api/v1/projects/proj-A/widgets/query", json=body)
    finally:
        app.dependency_overrides.pop(get_project_access, None)
    assert public.status_code == internal.status_code == 200
    assert public.json() == internal.json()
