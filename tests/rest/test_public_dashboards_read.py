"""Integration tests for the public dashboard reads.

These exercise the REAL dual-credential dependency (``authenticate_public_caller``)
and the dashboard read routes end-to-end, mocking the internal Next.js routes
with ``respx``. The dashboard catalog lives in Postgres/Prisma, so the listing
and detail reads are delegated to the secret-authed ``project-dashboards`` /
``project-dashboard`` internal routes, keyed by the project the credential
resolved. Client errors the internal route owns (400/403/404) pass through;
everything ambiguous fails closed as a 503.
"""

import json

import httpx
import respx
from fastapi.testclient import TestClient
from httpx import Response

from rest.main import app

BASE_URL = "http://localhost:3000"

USER_HEADER = {"Authorization": "Bearer user-session-token"}
KEY_HEADER = {"Authorization": "Bearer tr-some-key"}

# A validate-user-token 200 "member" body: the introspection route resolved the
# token to a project the user can read.
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

LIST_BODY = {
    "dashboards": [
        {
            "id": "dash-1",
            "name": "Default",
            "description": "Auto-created overview.",
            "isDefault": True,
            "creator": "Ada Lovelace",
            "createTime": "2026-08-01T00:00:00Z",
            "updateTime": "2026-08-02T00:00:00Z",
            "widgetCount": 4,
        },
        {
            "id": "dash-2",
            "name": "Latency",
            "description": None,
            "isDefault": False,
            "creator": None,
            "createTime": "2026-08-03T00:00:00Z",
            "updateTime": "2026-08-03T00:00:00Z",
            "widgetCount": 0,
        },
    ]
}

LIST_EXPECTED = {
    "data": [
        {
            "id": "dash-1",
            "name": "Default",
            "description": "Auto-created overview.",
            "is_default": True,
            "creator": "Ada Lovelace",
            "create_time": "2026-08-01T00:00:00Z",
            "update_time": "2026-08-02T00:00:00Z",
            "widget_count": 4,
        },
        {
            "id": "dash-2",
            "name": "Latency",
            "description": None,
            "is_default": False,
            "creator": None,
            "create_time": "2026-08-03T00:00:00Z",
            "update_time": "2026-08-03T00:00:00Z",
            "widget_count": 0,
        },
    ]
}

DETAIL_BODY = {
    "dashboard": {
        "id": "dash-1",
        "name": "Default",
        "description": "Auto-created overview.",
        "isDefault": True,
        "creator": "Ada Lovelace",
        "createTime": "2026-08-01T00:00:00Z",
        "updateTime": "2026-08-02T00:00:00Z",
        "widgets": [
            {
                "id": "w-1",
                "title": "Cost over time",
                "type": "query",
                "spec": {"view": "spans", "metric": {"measure": "cost", "agg": "sum"}},
                "createTime": "2026-08-01T00:00:00Z",
            },
            {
                "id": "w-2",
                "title": "Recent errors",
                "type": "trace_feed",
                "spec": {"filters": []},
                "createTime": "2026-08-01T01:00:00Z",
            },
        ],
    }
}

DETAIL_EXPECTED = {
    "id": "dash-1",
    "name": "Default",
    "description": "Auto-created overview.",
    "is_default": True,
    "creator": "Ada Lovelace",
    "create_time": "2026-08-01T00:00:00Z",
    "update_time": "2026-08-02T00:00:00Z",
    "widgets": [
        {
            "id": "w-1",
            "title": "Cost over time",
            "type": "query",
            "spec": {"view": "spans", "metric": {"measure": "cost", "agg": "sum"}},
            "create_time": "2026-08-01T00:00:00Z",
        },
        {
            "id": "w-2",
            "title": "Recent errors",
            "type": "trace_feed",
            "spec": {"filters": []},
            "create_time": "2026-08-01T01:00:00Z",
        },
    ],
}


def _mock_user_auth():
    return respx.post(f"{BASE_URL}/api/internal/validate-user-token").mock(
        return_value=Response(200, json=USER_OK_BODY)
    )


def _mock_key_auth():
    return respx.post(f"{BASE_URL}/api/internal/validate-api-key").mock(
        return_value=Response(200, json=KEY_OK_BODY)
    )


def _mock_list(body=LIST_BODY, status_code=200):
    return respx.post(f"{BASE_URL}/api/internal/project-dashboards").mock(
        return_value=Response(status_code, json=body)
    )


def _mock_detail(body=DETAIL_BODY, status_code=200):
    return respx.post(f"{BASE_URL}/api/internal/project-dashboard").mock(
        return_value=Response(status_code, json=body)
    )


# ── happy paths ──────────────────────────────────────────────────────────────


@respx.mock
def test_list_dashboards_returns_project_dashboards():
    _mock_user_auth()
    listing = _mock_list()
    resp = TestClient(app).get("/api/v1/public/dashboards?project_id=proj-A", headers=USER_HEADER)
    assert resp.status_code == 200
    assert resp.json() == LIST_EXPECTED
    # The internal route is keyed by the resolved project, never the credential.
    assert json.loads(listing.calls.last.request.content) == {"projectId": "proj-A"}


@respx.mock
def test_get_dashboard_returns_dashboard_with_widgets():
    _mock_user_auth()
    detail = _mock_detail()
    resp = TestClient(app).get(
        "/api/v1/public/dashboards/dash-1?project_id=proj-A", headers=USER_HEADER
    )
    assert resp.status_code == 200
    assert resp.json() == DETAIL_EXPECTED
    assert json.loads(detail.calls.last.request.content) == {
        "projectId": "proj-A",
        "dashboardId": "dash-1",
    }


@respx.mock
def test_list_dashboards_api_key_reads_with_creator_redacted():
    """Dual-stamp: an API key fixes its own project and reads the same rows,
    but ``creator`` is nulled — a project key is not a user credential, and
    member names/emails must not be readable by whoever holds an ingest key."""
    _mock_key_auth()
    listing = _mock_list()
    resp = TestClient(app).get("/api/v1/public/dashboards", headers=KEY_HEADER)
    assert resp.status_code == 200
    expected = {
        "data": [{**item, "creator": None} for item in LIST_EXPECTED["data"]],
    }
    assert resp.json() == expected
    assert json.loads(listing.calls.last.request.content) == {"projectId": "proj-A"}


@respx.mock
def test_get_dashboard_api_key_reads_with_creator_redacted():
    _mock_key_auth()
    _mock_detail()
    resp = TestClient(app).get("/api/v1/public/dashboards/dash-1", headers=KEY_HEADER)
    assert resp.status_code == 200
    assert resp.json() == {**DETAIL_EXPECTED, "creator": None}


@respx.mock
def test_list_dashboards_empty_is_empty_data():
    """A project with no dashboards lists as empty — no lazy seeding on this path."""
    _mock_user_auth()
    _mock_list(body={"dashboards": []})
    resp = TestClient(app).get("/api/v1/public/dashboards?project_id=proj-A", headers=USER_HEADER)
    assert resp.status_code == 200
    assert resp.json() == {"data": []}


# ── auth gates ───────────────────────────────────────────────────────────────


def test_list_dashboards_requires_authorization():
    client = TestClient(app, raise_server_exceptions=False)
    resp = client.get("/api/v1/public/dashboards")
    assert resp.status_code == 401


@respx.mock
def test_list_dashboards_user_token_requires_project_id():
    """A user credential without ?project_id is a 400 before any internal call."""
    listing = _mock_list()
    client = TestClient(app, raise_server_exceptions=False)
    resp = client.get("/api/v1/public/dashboards", headers=USER_HEADER)
    assert resp.status_code == 400
    assert listing.call_count == 0


# ── passthrough statuses (the internal route owns these) ─────────────────────


@respx.mock
def test_get_dashboard_foreign_id_is_404_with_upstream_detail():
    """A dashboard outside the resolved project simply isn't found (404)."""
    _mock_user_auth()
    _mock_detail(body={"error": "Dashboard not found"}, status_code=404)
    client = TestClient(app, raise_server_exceptions=False)
    resp = client.get(
        "/api/v1/public/dashboards/other-projects-dash?project_id=proj-A", headers=USER_HEADER
    )
    assert resp.status_code == 404
    assert resp.json()["detail"] == "Dashboard not found"


@respx.mock
def test_get_dashboard_passes_through_400_and_403():
    _mock_user_auth()
    client = TestClient(app, raise_server_exceptions=False)
    for status_code, error in ((400, "dashboardId is required"), (403, "Forbidden")):
        _mock_detail(body={"error": error}, status_code=status_code)
        resp = client.get("/api/v1/public/dashboards/dash-1?project_id=proj-A", headers=USER_HEADER)
        assert resp.status_code == status_code
        assert resp.json()["detail"] == error


@respx.mock
def test_passthrough_without_error_string_uses_generic_detail():
    """A passthrough status whose body has no usable error string never leaks
    the raw body — a generic per-status fallback is surfaced instead."""
    _mock_user_auth()
    _mock_detail(body={"unexpected": "shape"}, status_code=404)
    client = TestClient(app, raise_server_exceptions=False)
    resp = client.get("/api/v1/public/dashboards/dash-1?project_id=proj-A", headers=USER_HEADER)
    assert resp.status_code == 404
    assert resp.json()["detail"] == "Not found"


# ── fail-closed ladder (ambiguity is a 503, never an uncaught 500) ───────────


@respx.mock
def test_list_dashboards_network_error_is_503():
    _mock_user_auth()
    respx.post(f"{BASE_URL}/api/internal/project-dashboards").mock(
        side_effect=httpx.ConnectError("Connection refused")
    )
    client = TestClient(app, raise_server_exceptions=False)
    resp = client.get("/api/v1/public/dashboards?project_id=proj-A", headers=USER_HEADER)
    assert resp.status_code == 503


@respx.mock
def test_list_dashboards_unexpected_status_is_503():
    _mock_user_auth()
    _mock_list(body={}, status_code=500)
    client = TestClient(app, raise_server_exceptions=False)
    resp = client.get("/api/v1/public/dashboards?project_id=proj-A", headers=USER_HEADER)
    assert resp.status_code == 503


@respx.mock
def test_list_dashboards_upstream_401_is_503():
    """An upstream 401 means OUR internal secret was rejected — that's a
    misconfiguration (503), never the caller's credential failing."""
    _mock_user_auth()
    _mock_list(body={"error": "Unauthorized"}, status_code=401)
    client = TestClient(app, raise_server_exceptions=False)
    resp = client.get("/api/v1/public/dashboards?project_id=proj-A", headers=USER_HEADER)
    assert resp.status_code == 503


@respx.mock
def test_list_dashboards_malformed_json_is_503():
    _mock_user_auth()
    respx.post(f"{BASE_URL}/api/internal/project-dashboards").mock(
        return_value=Response(200, content=b"<html>not json</html>")
    )
    client = TestClient(app, raise_server_exceptions=False)
    resp = client.get("/api/v1/public/dashboards?project_id=proj-A", headers=USER_HEADER)
    assert resp.status_code == 503


@respx.mock
def test_list_dashboards_missing_dashboards_array_is_503():
    _mock_user_auth()
    _mock_list(body={"unexpected": "shape"})
    client = TestClient(app, raise_server_exceptions=False)
    resp = client.get("/api/v1/public/dashboards?project_id=proj-A", headers=USER_HEADER)
    assert resp.status_code == 503


@respx.mock
def test_list_dashboards_malformed_item_is_503_not_500():
    _mock_user_auth()
    _mock_list(body={"dashboards": [{"name": "Default"}]})  # missing required fields
    client = TestClient(app, raise_server_exceptions=False)
    resp = client.get("/api/v1/public/dashboards?project_id=proj-A", headers=USER_HEADER)
    assert resp.status_code == 503


@respx.mock
def test_get_dashboard_malformed_body_is_503():
    _mock_user_auth()
    _mock_detail(body={"dashboard": {"id": "dash-1"}})  # missing required fields
    client = TestClient(app, raise_server_exceptions=False)
    resp = client.get("/api/v1/public/dashboards/dash-1?project_id=proj-A", headers=USER_HEADER)
    assert resp.status_code == 503


# ── internal project-scoped mirror (the in-app agent's dispatch path) ────────


@respx.mock
def test_internal_mirror_list_reads_like_the_public_route(monkeypatch):
    """The internal mirror lives under `/api/v1/internal` (which the ingress
    fixed-404s off the load balancer) and shares the public handler body,
    authenticated by the trusted internal secret alone."""
    from shared.config import settings

    monkeypatch.setattr(settings, "internal_api_secret", "test-secret")
    listing = _mock_list()
    resp = TestClient(app).get(
        "/api/v1/internal/projects/proj-A/dashboards",
        headers={"X-Internal-Secret": "test-secret"},
    )
    assert resp.status_code == 200
    assert resp.json() == LIST_EXPECTED
    assert json.loads(listing.calls.last.request.content) == {"projectId": "proj-A"}


@respx.mock
def test_internal_mirror_detail_reads_like_the_public_route(monkeypatch):
    from shared.config import settings

    monkeypatch.setattr(settings, "internal_api_secret", "test-secret")
    _mock_detail()
    resp = TestClient(app).get(
        "/api/v1/internal/projects/proj-A/dashboards/dash-1",
        headers={"X-Internal-Secret": "test-secret"},
    )
    assert resp.status_code == 200
    assert resp.json() == DETAIL_EXPECTED


@respx.mock
def test_internal_mirror_rejects_a_caller_without_the_secret(monkeypatch):
    """An x-user-id header alone buys nothing: the mirror is secret-only."""
    from shared.config import settings

    monkeypatch.setattr(settings, "internal_api_secret", "test-secret")
    listing = _mock_list()
    client = TestClient(app, raise_server_exceptions=False)
    resp = client.get(
        "/api/v1/internal/projects/proj-A/dashboards",
        headers={"x-user-id": "u1"},
    )
    assert resp.status_code == 403
    assert listing.call_count == 0


def test_dashboard_mirror_is_off_the_public_project_surface():
    """The catalog mirror must not be mounted at `/api/v1/projects/...`.

    That prefix is ALB-routed, and its project access check trusts a
    caller-supplied x-user-id — anyone knowing a project id and a member id
    could read the tenant's dashboard catalog (creator identities included)
    with no token at all. Only the internal prefix, which the ingress drops,
    may serve it.
    """
    from fastapi.routing import APIRoute

    paths = {r.path for r in app.routes if isinstance(r, APIRoute)}
    assert "/api/v1/projects/{project_id}/dashboards" not in paths
    assert "/api/v1/projects/{project_id}/dashboards/{dashboard_id}" not in paths
    assert "/api/v1/internal/projects/{project_id}/dashboards" in paths
