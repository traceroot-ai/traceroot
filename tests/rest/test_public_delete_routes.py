"""Integration tests for the public DELETE routes (six resources).

Same harness as the create and update tests: the REAL account-scope dependency
plus the write-path liveness dependency, internal routes mocked with ``respx``.
Deletes take their tenancy and the required ``reason`` as query parameters
(a DELETE body is legal but poorly supported by tooling) and forward them to
the internal route as a JSON body beside the actor envelope. The tests pin
that body, the one response shape shared by all six, the 422 surface (a
missing, blank, or oversized reason; missing tenancy; the workspace's typed
name), and service-message parity on passthrough errors.
"""

import json

import httpx
import pytest
import respx
from fastapi.testclient import TestClient
from httpx import Response

from rest.main import app

BASE_URL = "http://localhost:3000"
INTERNAL = f"{BASE_URL}/api/internal/write"

USER_HEADER = {"Authorization": "Bearer user-session-token"}
KEY_HEADER = {"Authorization": "Bearer tr-some-key"}

# The account-scope validate-user-token 200 body (no project requested).
ACCOUNT_OK_BODY = {"valid": True, "userId": "u1", "email": "u@example.com"}

REASON = "superseded by the timeout trigger"
ENVELOPE = {"actorUserId": "u1", "reason": REASON, "transport": "public-api"}
PROJECT_ENVELOPE = {**ENVELOPE, "projectId": "proj-1"}


def _mock_account_auth():
    """Mock the account-scope introspection to a valid live session."""
    return respx.post(f"{BASE_URL}/api/internal/validate-user-token").mock(
        return_value=Response(200, json=ACCOUNT_OK_BODY)
    )


def _mock_delete(url, body, status_code=200):
    """Mock one internal DELETE route."""
    return respx.delete(url).mock(return_value=Response(status_code, json=body))


def _client():
    return TestClient(app, raise_server_exceptions=False)


def _delete(path, params, headers=USER_HEADER):
    return _client().delete(f"/api/v1/public{path}", params=params, headers=headers)


def _sent(route):
    return json.loads(route.calls.last.request.content)


def _deleted(resource, name):
    return {"deleted": True, "reason": REASON, resource: {"id": f"{resource[:4]}-1", "name": name}}


# (public path, minimal valid query, internal DELETE url, success body)
_DELETE_ROUTES = [
    (
        "/workspaces/ws-1",
        {"name": "Alpha", "reason": REASON},
        f"{INTERNAL}/workspaces/ws-1",
        {
            "deleted": True,
            "reason": REASON,
            "cascaded": {"projects": 2, "accessKeys": 3, "memberships": 1},
            "workspace": {"id": "ws-1", "name": "Alpha"},
        },
    ),
    (
        "/projects/proj-1",
        {"reason": REASON},
        f"{INTERNAL}/projects/proj-1",
        {"deleted": True, "reason": REASON, "project": {"id": "proj-1", "name": "Checkout"}},
    ),
    (
        "/detectors/det-1",
        {"project_id": "proj-1", "reason": REASON},
        f"{INTERNAL}/detectors/det-1",
        {"deleted": True, "reason": REASON, "detector": {"id": "det-1", "name": "Timeouts"}},
    ),
    (
        "/dashboards/dash-1",
        {"project_id": "proj-1", "reason": REASON},
        f"{INTERNAL}/dashboards/dash-1",
        {
            "deleted": True,
            "reason": REASON,
            "cascaded": {"widgets": 4},
            "dashboard": {"id": "dash-1", "name": "Spend"},
        },
    ),
    (
        "/widgets/wid-1",
        {"project_id": "proj-1", "reason": REASON},
        f"{INTERNAL}/widgets/wid-1",
        {"deleted": True, "reason": REASON, "widget": {"id": "wid-1", "name": "Cost"}},
    ),
    (
        "/alerts/alr-1",
        {"project_id": "proj-1", "reason": REASON},
        f"{INTERNAL}/alerts/alr-1",
        {
            "deleted": True,
            "reason": REASON,
            "pageCleared": True,
            "alert": {"id": "alr-1", "name": "P99 latency"},
        },
    ),
]


# ── auth gating (every route) ───────────────────────────────────────────


@pytest.mark.parametrize(("path", "params", "url", "body"), _DELETE_ROUTES)
def test_delete_requires_authorization(path, params, url, body):
    """No Authorization header → 401 before any internal call."""
    resp = _client().delete(f"/api/v1/public{path}", params=params)
    assert resp.status_code == 401


@respx.mock
@pytest.mark.parametrize(("path", "params", "url", "body"), _DELETE_ROUTES)
def test_delete_rejects_api_key_with_403(path, params, url, body):
    """An API key is project-scoped; deletes require a user credential and are
    refused before any lookup."""
    write = _mock_delete(url, body)
    resp = _delete(path, params, headers=KEY_HEADER)
    assert resp.status_code == 403
    assert write.call_count == 0


# ── happy paths: the forwarded body and the shared response shape ───────


@respx.mock
def test_delete_workspace_forwards_the_typed_name_and_reason():
    """The typed workspace name and the reason travel in the internal body
    beside the actor; the response echoes the reason and the cascade counts."""
    _mock_account_auth()
    write = _mock_delete(f"{INTERNAL}/workspaces/ws-1", _DELETE_ROUTES[0][3])

    resp = _delete("/workspaces/ws-1", {"name": "Alpha", "reason": REASON})

    assert resp.status_code == 200
    assert resp.json() == {
        "deleted": True,
        "reason": REASON,
        "cascaded": {"projects": 2, "accessKeys": 3, "memberships": 1},
        "workspace": {"id": "ws-1", "name": "Alpha"},
    }
    # Exact-body equality also pins that agentSessionId is absent.
    assert _sent(write) == {**ENVELOPE, "name": "Alpha"}


@respx.mock
def test_delete_project_forwards_the_reason_only():
    _mock_account_auth()
    write = _mock_delete(f"{INTERNAL}/projects/proj-1", _DELETE_ROUTES[1][3])

    resp = _delete("/projects/proj-1", {"reason": REASON})

    assert resp.status_code == 200
    assert resp.json() == {
        "deleted": True,
        "reason": REASON,
        "project": {"id": "proj-1", "name": "Checkout"},
    }
    assert _sent(write) == ENVELOPE


@respx.mock
def test_delete_detector_forwards_project_tenancy():
    _mock_account_auth()
    write = _mock_delete(f"{INTERNAL}/detectors/det-1", _DELETE_ROUTES[2][3])

    resp = _delete("/detectors/det-1", {"project_id": "proj-1", "reason": REASON})

    assert resp.status_code == 200
    assert resp.json() == {
        "deleted": True,
        "reason": REASON,
        "detector": {"id": "det-1", "name": "Timeouts"},
    }
    assert _sent(write) == PROJECT_ENVELOPE


@respx.mock
def test_delete_dashboard_reports_the_widget_cascade():
    _mock_account_auth()
    write = _mock_delete(f"{INTERNAL}/dashboards/dash-1", _DELETE_ROUTES[3][3])

    resp = _delete("/dashboards/dash-1", {"project_id": "proj-1", "reason": REASON})

    assert resp.status_code == 200
    assert resp.json() == {
        "deleted": True,
        "reason": REASON,
        "cascaded": {"widgets": 4},
        "dashboard": {"id": "dash-1", "name": "Spend"},
    }
    assert _sent(write) == PROJECT_ENVELOPE


@respx.mock
def test_delete_widget_happy_path():
    _mock_account_auth()
    write = _mock_delete(f"{INTERNAL}/widgets/wid-1", _DELETE_ROUTES[4][3])

    resp = _delete("/widgets/wid-1", {"project_id": "proj-1", "reason": REASON})

    assert resp.status_code == 200
    assert resp.json() == {
        "deleted": True,
        "reason": REASON,
        "widget": {"id": "wid-1", "name": "Cost"},
    }
    assert _sent(write) == PROJECT_ENVELOPE


@respx.mock
def test_delete_alert_reports_a_cleared_page():
    _mock_account_auth()
    write = _mock_delete(f"{INTERNAL}/alerts/alr-1", _DELETE_ROUTES[5][3])

    resp = _delete("/alerts/alr-1", {"project_id": "proj-1", "reason": REASON})

    assert resp.status_code == 200
    assert resp.json() == {
        "deleted": True,
        "reason": REASON,
        "page_cleared": True,
        "alert": {"id": "alr-1", "name": "P99 latency"},
    }
    assert _sent(write) == PROJECT_ENVELOPE


@respx.mock
def test_delete_alert_without_a_page_reports_false():
    _mock_account_auth()
    _mock_delete(
        f"{INTERNAL}/alerts/alr-1",
        {"deleted": True, "reason": REASON, "alert": {"id": "alr-1", "name": "P99 latency"}},
    )

    resp = _delete("/alerts/alr-1", {"project_id": "proj-1", "reason": REASON})

    assert resp.status_code == 200
    assert resp.json()["page_cleared"] is False


@respx.mock
def test_delete_echoes_the_reason_the_service_recorded():
    """The public ``reason`` is the one the audit row holds (the service's
    echo), not the raw query string."""
    _mock_account_auth()
    _mock_delete(
        f"{INTERNAL}/detectors/det-1",
        {"deleted": True, "reason": "trimmed reason", "detector": {"id": "det-1", "name": "T"}},
    )

    resp = _delete("/detectors/det-1", {"project_id": "proj-1", "reason": "  trimmed reason  "})

    assert resp.status_code == 200
    assert resp.json()["reason"] == "trimmed reason"


# ── the reason and tenancy are required on the API itself ───────────────


@respx.mock
@pytest.mark.parametrize(("path", "params", "url", "body"), _DELETE_ROUTES)
def test_delete_without_a_reason_is_422_and_touches_nothing(path, params, url, body):
    _mock_account_auth()
    write = _mock_delete(url, body)

    resp = _delete(path, {k: v for k, v in params.items() if k != "reason"})

    assert resp.status_code == 422
    assert write.call_count == 0


@respx.mock
@pytest.mark.parametrize("reason", ["", "no", "   ", " x ", "x" * 501])
def test_delete_with_a_blank_short_or_oversized_reason_is_422(reason):
    _mock_account_auth()
    write = _mock_delete(f"{INTERNAL}/detectors/det-1", _DELETE_ROUTES[2][3])

    resp = _delete("/detectors/det-1", {"project_id": "proj-1", "reason": reason})

    assert resp.status_code == 422
    assert write.call_count == 0


@respx.mock
def test_delete_reason_at_the_bounds_is_accepted():
    _mock_account_auth()
    write = _mock_delete(f"{INTERNAL}/detectors/det-1", _DELETE_ROUTES[2][3])

    for reason in ("why", "x" * 500):
        resp = _delete("/detectors/det-1", {"project_id": "proj-1", "reason": reason})
        assert resp.status_code == 200
        assert _sent(write)["reason"] == reason


@respx.mock
@pytest.mark.parametrize(
    "path", ["/detectors/det-1", "/dashboards/dash-1", "/widgets/wid-1", "/alerts/alr-1"]
)
def test_project_scoped_delete_requires_project_id(path):
    _mock_account_auth()
    routes = [
        respx.delete(url).mock(return_value=Response(200, json=body))
        for _, _, url, body in _DELETE_ROUTES
    ]

    resp = _delete(path, {"reason": REASON})

    assert resp.status_code == 422
    assert all(route.call_count == 0 for route in routes)


@respx.mock
def test_delete_workspace_requires_the_typed_name():
    _mock_account_auth()
    write = _mock_delete(f"{INTERNAL}/workspaces/ws-1", _DELETE_ROUTES[0][3])

    resp = _delete("/workspaces/ws-1", {"reason": REASON})

    assert resp.status_code == 422
    assert write.call_count == 0


# ── upstream error passthrough and fail-closed 503s ─────────────────────


@respx.mock
@pytest.mark.parametrize(
    ("path", "params", "url", "status_code", "message"),
    [
        (
            "/workspaces/ws-1",
            {"name": "Wrong", "reason": REASON},
            f"{INTERNAL}/workspaces/ws-1",
            409,
            "name does not match the workspace name",
        ),
        (
            "/dashboards/dash-1",
            {"project_id": "proj-1", "reason": REASON},
            f"{INTERNAL}/dashboards/dash-1",
            409,
            "Cannot delete a project's last dashboard",
        ),
        (
            "/detectors/det-9",
            {"project_id": "proj-1", "reason": REASON},
            f"{INTERNAL}/detectors/det-9",
            404,
            "Detector not found",
        ),
        (
            "/projects/proj-1",
            {"reason": REASON},
            f"{INTERNAL}/projects/proj-1",
            403,
            "Requires ADMIN role or higher",
        ),
        (
            "/alerts/alr-1",
            {"project_id": "proj-1", "reason": REASON},
            f"{INTERNAL}/alerts/alr-1",
            400,
            "Invalid request",
        ),
    ],
)
def test_delete_forwards_upstream_client_errors_verbatim(path, params, url, status_code, message):
    _mock_account_auth()
    _mock_delete(url, {"error": message}, status_code=status_code)

    resp = _delete(path, params)

    assert resp.status_code == status_code
    assert resp.json() == {"detail": message}


@respx.mock
def test_delete_passthrough_without_error_string_uses_fallback():
    _mock_account_auth()
    respx.delete(f"{INTERNAL}/widgets/wid-1").mock(
        return_value=Response(409, content=b"<html>gateway page</html>")
    )

    resp = _delete("/widgets/wid-1", {"project_id": "proj-1", "reason": REASON})

    assert resp.status_code == 409
    assert resp.json() == {"detail": "Name already in use"}


@respx.mock
def test_delete_network_error_is_503():
    _mock_account_auth()
    respx.delete(f"{INTERNAL}/projects/proj-1").mock(
        side_effect=httpx.ConnectError("Connection refused")
    )

    resp = _delete("/projects/proj-1", {"reason": REASON})

    assert resp.status_code == 503
    assert resp.json() == {"detail": "Write service unavailable"}


@respx.mock
def test_delete_upstream_401_is_503():
    """A 401 from the internal route means OUR secret is misconfigured — the
    caller's credential already passed, so surface an outage, not a 401."""
    _mock_account_auth()
    _mock_delete(f"{INTERNAL}/projects/proj-1", {"error": "Unauthorized"}, status_code=401)

    resp = _delete("/projects/proj-1", {"reason": REASON})

    assert resp.status_code == 503


@respx.mock
@pytest.mark.parametrize(("path", "params", "url", "body"), _DELETE_ROUTES)
def test_delete_malformed_upstream_envelope_is_503(path, params, url, body):
    """A 200 body without the resource envelope fails closed on every route."""
    _mock_account_auth()
    _mock_delete(url, {"deleted": True, "reason": REASON})

    resp = _delete(path, params)

    assert resp.status_code == 503
    assert resp.json() == {"detail": "Write service error"}


@respx.mock
@pytest.mark.parametrize(
    "body",
    [
        {"deleted": True, "reason": REASON, "cascaded": [4], "dashboard": {"id": "d", "name": "S"}},
        {"deleted": True, "reason": REASON, "dashboard": {"id": "d", "name": None}},
        {"deleted": True, "reason": None, "dashboard": {"id": "d", "name": "S"}},
    ],
)
def test_delete_wrong_typed_envelope_is_503(body):
    _mock_account_auth()
    _mock_delete(f"{INTERNAL}/dashboards/dash-1", body)

    resp = _delete("/dashboards/dash-1", {"project_id": "proj-1", "reason": REASON})

    assert resp.status_code == 503
