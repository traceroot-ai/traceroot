"""Integration tests for the account-scope discovery reads.

These exercise the REAL account-scope dependency (``authenticate_account_caller``)
and the account routes end-to-end, mocking BOTH internal routes with ``respx``:
``validate-user-token`` (the account-scope auth introspection, no projectId) and
``user-memberships`` (the workspace/project listing). A user session token is
required; an API key (``tr-``) is rejected with 403.
"""

import httpx
import pytest
import respx
from fastapi import HTTPException
from fastapi.testclient import TestClient
from httpx import Response

from rest.main import app
from rest.routers.public.account_read import _bearer_token

BASE_URL = "http://localhost:3000"

USER_HEADER = {"Authorization": "Bearer user-session-token"}
KEY_HEADER = {"Authorization": "Bearer tr-some-key"}

# The account-scope validate-user-token 200 body (no project requested).
ACCOUNT_OK_BODY = {"valid": True, "userId": "u1", "email": "u@example.com"}

MEMBERSHIPS_BODY = {
    "workspaces": [
        {
            "id": "ws-1",
            "name": "Alpha",
            "role": "admin",
            "projects": [
                {"id": "proj-1", "name": "P1"},
                {"id": "proj-2", "name": "P2"},
            ],
        },
        {
            "id": "ws-2",
            "name": "Beta",
            "role": "viewer",
            "projects": [{"id": "proj-3", "name": "P3"}],
        },
    ]
}


def _mock_account_auth():
    """Mock the account-scope introspection to a valid live session."""
    return respx.post(f"{BASE_URL}/api/internal/validate-user-token").mock(
        return_value=Response(200, json=ACCOUNT_OK_BODY)
    )


def _mock_memberships(body=MEMBERSHIPS_BODY, status_code=200):
    """Mock the internal user-memberships listing route."""
    return respx.post(f"{BASE_URL}/api/internal/user-memberships").mock(
        return_value=Response(status_code, json=body)
    )


@respx.mock
def test_list_workspaces_returns_user_workspaces():
    _mock_account_auth()
    _mock_memberships()
    resp = TestClient(app).get("/api/v1/public/workspaces", headers=USER_HEADER)
    assert resp.status_code == 200
    assert resp.json() == {
        "data": [
            {"id": "ws-1", "name": "Alpha", "role": "admin"},
            {"id": "ws-2", "name": "Beta", "role": "viewer"},
        ]
    }


@respx.mock
def test_list_projects_flattens_across_workspaces():
    _mock_account_auth()
    _mock_memberships()
    resp = TestClient(app).get("/api/v1/public/projects", headers=USER_HEADER)
    assert resp.status_code == 200
    assert resp.json() == {
        "data": [
            {"id": "proj-1", "name": "P1", "workspace_id": "ws-1", "workspace_name": "Alpha"},
            {"id": "proj-2", "name": "P2", "workspace_id": "ws-1", "workspace_name": "Alpha"},
            {"id": "proj-3", "name": "P3", "workspace_id": "ws-2", "workspace_name": "Beta"},
        ]
    }


@respx.mock
def test_list_projects_filters_by_workspace_id():
    _mock_account_auth()
    _mock_memberships()
    resp = TestClient(app).get("/api/v1/public/projects?workspace_id=ws-2", headers=USER_HEADER)
    assert resp.status_code == 200
    assert resp.json() == {
        "data": [
            {"id": "proj-3", "name": "P3", "workspace_id": "ws-2", "workspace_name": "Beta"},
        ]
    }


@respx.mock
def test_list_workspaces_rejects_api_key_with_403():
    """An API key is project-scoped and cannot enumerate an account."""
    membership = _mock_memberships()
    client = TestClient(app, raise_server_exceptions=False)
    resp = client.get("/api/v1/public/workspaces", headers=KEY_HEADER)
    assert resp.status_code == 403
    # It must never reach the listing call.
    assert membership.call_count == 0


@respx.mock
def test_list_projects_rejects_api_key_with_403():
    membership = _mock_memberships()
    client = TestClient(app, raise_server_exceptions=False)
    resp = client.get("/api/v1/public/projects", headers=KEY_HEADER)
    assert resp.status_code == 403
    assert membership.call_count == 0


@respx.mock
def test_list_workspaces_invalid_token_is_401():
    respx.post(f"{BASE_URL}/api/internal/validate-user-token").mock(
        return_value=Response(401, json={"valid": False, "error": "invalid or expired token"})
    )
    client = TestClient(app, raise_server_exceptions=False)
    resp = client.get("/api/v1/public/workspaces", headers=USER_HEADER)
    assert resp.status_code == 401


@respx.mock
def test_list_projects_invalid_token_is_401():
    respx.post(f"{BASE_URL}/api/internal/validate-user-token").mock(
        return_value=Response(401, json={"valid": False, "error": "invalid or expired token"})
    )
    client = TestClient(app, raise_server_exceptions=False)
    resp = client.get("/api/v1/public/projects", headers=USER_HEADER)
    assert resp.status_code == 401


@respx.mock
def test_list_workspaces_internal_listing_failure_is_503():
    """A valid token but a failing listing call fails closed with a 503."""
    _mock_account_auth()
    _mock_memberships(body={}, status_code=500)
    client = TestClient(app, raise_server_exceptions=False)
    resp = client.get("/api/v1/public/workspaces", headers=USER_HEADER)
    assert resp.status_code == 503


@respx.mock
def test_list_projects_internal_listing_failure_is_503():
    _mock_account_auth()
    _mock_memberships(body={}, status_code=500)
    client = TestClient(app, raise_server_exceptions=False)
    resp = client.get("/api/v1/public/projects", headers=USER_HEADER)
    assert resp.status_code == 503


def test_list_workspaces_requires_authorization():
    """No Authorization header → 401 before any internal call."""
    client = TestClient(app, raise_server_exceptions=False)
    resp = client.get("/api/v1/public/workspaces")
    assert resp.status_code == 401


@respx.mock
def test_list_workspaces_network_error_is_503():
    """A network error reaching the internal listing route fails closed (503)."""
    _mock_account_auth()
    respx.post(f"{BASE_URL}/api/internal/user-memberships").mock(
        side_effect=httpx.ConnectError("Connection refused")
    )
    client = TestClient(app, raise_server_exceptions=False)
    resp = client.get("/api/v1/public/workspaces", headers=USER_HEADER)
    assert resp.status_code == 503


@respx.mock
def test_list_workspaces_malformed_json_is_503():
    """A 200 with a non-JSON body from the listing route fails closed (503)."""
    _mock_account_auth()
    respx.post(f"{BASE_URL}/api/internal/user-memberships").mock(
        return_value=Response(200, content=b"<html>not json</html>")
    )
    client = TestClient(app, raise_server_exceptions=False)
    resp = client.get("/api/v1/public/workspaces", headers=USER_HEADER)
    assert resp.status_code == 503


@respx.mock
def test_list_workspaces_missing_workspaces_array_is_503():
    """A 200 body without a ``workspaces`` array is malformed → 503."""
    _mock_account_auth()
    _mock_memberships(body={"unexpected": "shape"})
    client = TestClient(app, raise_server_exceptions=False)
    resp = client.get("/api/v1/public/workspaces", headers=USER_HEADER)
    assert resp.status_code == 503


@respx.mock
def test_list_workspaces_malformed_item_is_503_not_500():
    """A workspace item missing a required field fails closed with a 503."""
    _mock_account_auth()
    _mock_memberships(body={"workspaces": [{"name": "Alpha", "role": "admin"}]})  # no "id"
    client = TestClient(app, raise_server_exceptions=False)
    resp = client.get("/api/v1/public/workspaces", headers=USER_HEADER)
    assert resp.status_code == 503


@respx.mock
def test_list_projects_malformed_project_item_is_503_not_500():
    """A project item missing a required field fails closed with a 503."""
    _mock_account_auth()
    _mock_memberships(
        body={
            "workspaces": [
                {"id": "ws-1", "name": "Alpha", "role": "admin", "projects": [{"id": "proj-1"}]}
            ]
        }  # project missing "name"
    )
    client = TestClient(app, raise_server_exceptions=False)
    resp = client.get("/api/v1/public/projects", headers=USER_HEADER)
    assert resp.status_code == 503


@respx.mock
def test_list_projects_missing_projects_array_is_503():
    """A workspace item without a ``projects`` array is malformed → 503, not an
    incomplete 200."""
    _mock_account_auth()
    _mock_memberships(body={"workspaces": [{"id": "ws-1", "name": "Alpha", "role": "admin"}]})
    client = TestClient(app, raise_server_exceptions=False)
    resp = client.get("/api/v1/public/projects", headers=USER_HEADER)
    assert resp.status_code == 503


# ── _bearer_token (route helper, defensive re-parse) ─────────────────────


def test_bearer_token_extracts_valid_header():
    assert _bearer_token("Bearer sess-token-abc") == "sess-token-abc"


@pytest.mark.parametrize("header", [None, "", "BadFormat token123", "Bearer ", "Bearer   "])
def test_bearer_token_missing_or_malformed_raises_401(header):
    with pytest.raises(HTTPException) as exc_info:
        _bearer_token(header)
    assert exc_info.value.status_code == 401
