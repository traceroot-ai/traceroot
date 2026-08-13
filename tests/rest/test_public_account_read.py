"""Integration tests for the account-scope discovery reads.

These exercise the REAL account-scope dependency (``authenticate_account_caller``)
and the account routes end-to-end, mocking the internal routes with ``respx``.
BOTH account-scope credential kinds are covered: a raw session token
(introspected via ``validate-user-token``) and a CLI access JWT (verified offline
against a mocked JWKS). Either way the workspace/project listing is delegated to
``user-memberships``, keyed by the resolved user id. An API key (``tr-``) is
rejected with 403.
"""

import json
import time

import httpx
import jwt
import respx
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from fastapi.testclient import TestClient
from httpx import Response
from jwt.algorithms import OKPAlgorithm

from rest.main import app
from rest.routers.public import deps
from rest.routers.public.jwks_cache import JwksCache

BASE_URL = "http://localhost:3000"
JWKS_URL = f"{BASE_URL}/api/auth/jwks"
_JWT_KID = "kid-acct-1"

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
    membership = _mock_memberships()
    resp = TestClient(app).get("/api/v1/public/workspaces", headers=USER_HEADER)
    assert resp.status_code == 200
    assert resp.json() == {
        "data": [
            {"id": "ws-1", "name": "Alpha", "role": "admin"},
            {"id": "ws-2", "name": "Beta", "role": "viewer"},
        ]
    }
    # The session-token path also forwards the resolved user id (from the
    # validate-user-token introspection), never the raw session token.
    assert json.loads(membership.calls.last.request.content) == {"userId": "u1"}


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


# ── CLI access JWT account path (offline verify → list by resolved user id) ──


def _install_jwt_signer(monkeypatch):
    """Register a mocked JWKS and point the deps cache at it; return the signer."""
    priv = Ed25519PrivateKey.generate()
    jwk = OKPAlgorithm.to_jwk(priv.public_key(), as_dict=True)
    jwk.update(kid=_JWT_KID, alg="EdDSA", use="sig")
    respx.get(JWKS_URL).mock(return_value=Response(200, json={"keys": [jwk]}))
    monkeypatch.setattr(deps, "get_jwks_cache", lambda: JwksCache(JWKS_URL))
    return priv


def _mint_jwt(priv, *, sub="u1"):
    now = int(time.time())
    return jwt.encode(
        {"sub": sub, "aud": "traceroot-api", "iss": "traceroot", "iat": now, "exp": now + 900},
        priv,
        algorithm="EdDSA",
        headers={"kid": _JWT_KID},
    )


@respx.mock
def test_list_workspaces_accepts_a_cli_access_jwt(monkeypatch):
    """A CLI access JWT is verified offline, then lists via user-memberships by user id."""
    priv = _install_jwt_signer(monkeypatch)
    membership = _mock_memberships()
    token = _mint_jwt(priv, sub="u1")

    resp = TestClient(app).get(
        "/api/v1/public/workspaces", headers={"Authorization": f"Bearer {token}"}
    )

    assert resp.status_code == 200
    assert resp.json() == {
        "data": [
            {"id": "ws-1", "name": "Alpha", "role": "admin"},
            {"id": "ws-2", "name": "Beta", "role": "viewer"},
        ]
    }
    # Regression guard: the JWT's subject (user id) is forwarded to the internal
    # listing route — never the raw JWT, which user-memberships can't resolve.
    assert json.loads(membership.calls.last.request.content) == {"userId": "u1"}


@respx.mock
def test_list_projects_accepts_a_cli_access_jwt(monkeypatch):
    priv = _install_jwt_signer(monkeypatch)
    membership = _mock_memberships()
    token = _mint_jwt(priv, sub="u1")

    resp = TestClient(app).get(
        "/api/v1/public/projects", headers={"Authorization": f"Bearer {token}"}
    )

    assert resp.status_code == 200
    assert resp.json() == {
        "data": [
            {"id": "proj-1", "name": "P1", "workspace_id": "ws-1", "workspace_name": "Alpha"},
            {"id": "proj-2", "name": "P2", "workspace_id": "ws-1", "workspace_name": "Alpha"},
            {"id": "proj-3", "name": "P3", "workspace_id": "ws-2", "workspace_name": "Beta"},
        ]
    }
    assert json.loads(membership.calls.last.request.content) == {"userId": "u1"}
