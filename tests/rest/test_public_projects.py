"""Integration tests for the wizard's two project writes.

These exercise the REAL account-scope dependency (``authenticate_account_caller``)
and the project write routes end-to-end, mocking the internal routes with
``respx``. The point running through them is the same: the routes authenticate a
*user* credential and forward only the resolved user id to the control plane,
never the raw credential.

Both writes are deliberately narrow — see the module docstring on
``rest.routers.public.projects``.
"""

import json

import httpx
import pytest
import respx
from fastapi.testclient import TestClient
from httpx import Response

from rest.main import app

BASE_URL = "http://localhost:3000"

USER_HEADER = {"Authorization": "Bearer user-session-token"}
KEY_HEADER = {"Authorization": "Bearer tr-some-key"}

ACCOUNT_OK_BODY = {"valid": True, "userId": "u1", "email": "u@example.com"}

CREATED_PROJECT = {
    "valid": True,
    "project_id": "proj-1",
    "project_name": "checkout",
    "workspace_id": "ws-1",
    "workspace_name": "Alpha",
    "created_at": "2026-08-18T00:00:00.000Z",
}

CREATED_KEY = {
    "valid": True,
    "id": "key-1",
    "name": "laptop",
    "hint": "tr-abcd",
    "project_id": "proj-1",
    "project_name": "checkout",
    "scope": "admin",
    "expires_at": None,
    "created_at": "2026-08-18T00:00:00.000Z",
    "key": "tr-secret-value",
}


def _mock_account_auth():
    """Mock the account-scope introspection to a valid live session."""
    return respx.post(f"{BASE_URL}/api/internal/validate-user-token").mock(
        return_value=Response(200, json=ACCOUNT_OK_BODY)
    )


def _mock_internal(route, body, status_code=201):
    """Mock one of the internal write routes."""
    return respx.post(f"{BASE_URL}/api/internal/{route}").mock(
        return_value=Response(status_code, json=body)
    )


@respx.mock
def test_minting_a_key_reaches_the_project_scoped_route():
    _mock_account_auth()
    internal = _mock_internal("user-create-project-key", CREATED_KEY)

    resp = TestClient(app).post(
        "/api/v1/public/projects/proj-1/api-keys",
        json={"name": "laptop", "scope": "admin"},
        headers=USER_HEADER,
    )

    assert resp.status_code == 201
    assert resp.json()["key"] == "tr-secret-value"
    assert json.loads(internal.calls.last.request.content) == {
        "userId": "u1",
        "projectId": "proj-1",
        "name": "laptop",
        "scope": "admin",
    }


@respx.mock
def test_a_project_api_key_cannot_mint_a_project_key():
    """This is an account-scope write; a project key is refused before any write."""
    internal = _mock_internal("user-create-project-key", CREATED_PROJECT)

    resp = TestClient(app).post(
        "/api/v1/public/projects/proj-1/api-keys", json={"name": "laptop"}, headers=KEY_HEADER
    )

    assert resp.status_code == 403
    assert not internal.called


@respx.mock
def test_a_request_with_no_credential_never_reaches_the_control_plane():
    internal = _mock_internal("user-create-project-key", CREATED_PROJECT)

    resp = TestClient(app).post("/api/v1/public/projects/proj-1/api-keys", json={"name": "laptop"})

    assert resp.status_code == 401
    assert not internal.called


@respx.mock
@pytest.mark.parametrize(
    ("status_code", "upstream_body", "expected_detail"),
    [
        (
            409,
            {"error": "A project named 'x' already exists"},
            "A project named 'x' already exists",
        ),
        (
            403,
            {"error": "Insufficient workspace permissions"},
            "Insufficient workspace permissions",
        ),
        (404, {"error": "Workspace not found"}, "Workspace not found"),
    ],
)
def test_control_plane_errors_keep_their_status_in_the_public_shape(
    status_code, upstream_body, expected_detail
):
    """`{error}` upstream becomes `{detail}` here — the shape public clients read."""
    _mock_account_auth()
    _mock_internal("user-create-project-key", upstream_body, status_code=status_code)

    resp = TestClient(app).post(
        "/api/v1/public/projects/proj-1/api-keys", json={"name": "x"}, headers=USER_HEADER
    )

    assert resp.status_code == status_code
    assert resp.json() == {"detail": expected_detail}


@respx.mock
def test_a_non_json_upstream_body_fails_closed_without_leaking_it():
    _mock_account_auth()
    respx.post(f"{BASE_URL}/api/internal/user-create-project-key").mock(
        return_value=Response(500, text="<html>stack trace</html>")
    )

    resp = TestClient(app).post(
        "/api/v1/public/projects/proj-1/api-keys", json={"name": "x"}, headers=USER_HEADER
    )

    assert resp.status_code == 503
    assert resp.json() == {"detail": "Project service error"}
    assert "stack trace" not in resp.text


@respx.mock
def test_an_unreachable_control_plane_is_a_503():
    _mock_account_auth()
    respx.post(f"{BASE_URL}/api/internal/user-create-project-key").mock(
        side_effect=httpx.ConnectError("boom")
    )

    resp = TestClient(app).post(
        "/api/v1/public/projects/proj-1/api-keys", json={"name": "x"}, headers=USER_HEADER
    )

    assert resp.status_code == 503
    assert resp.json() == {"detail": "Project service unavailable"}


@respx.mock
def test_a_non_json_request_body_is_rejected_before_any_write():
    _mock_account_auth()
    internal = _mock_internal("user-create-project-key", CREATED_PROJECT)

    resp = TestClient(app).post(
        "/api/v1/public/projects/proj-1/api-keys",
        content="not json",
        headers={**USER_HEADER, "Content-Type": "application/json"},
    )

    assert resp.status_code == 400
    assert not internal.called
