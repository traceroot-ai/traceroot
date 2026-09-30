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
import time

import httpx
import jwt
import pytest
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
LIVE_URL = f"{BASE_URL}/api/internal/validate-session-live"
_JWT_KID = "kid-proj-key-1"

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


# ── CLI access JWT: the minting write is gated on session liveness ──────


def _install_jwt_signer(monkeypatch):
    """Register a mocked JWKS and point the deps cache at it; return the signer."""
    priv = Ed25519PrivateKey.generate()
    jwk = OKPAlgorithm.to_jwk(priv.public_key(), as_dict=True)
    jwk.update(kid=_JWT_KID, alg="EdDSA", use="sig")
    respx.get(JWKS_URL).mock(return_value=Response(200, json={"keys": [jwk]}))
    monkeypatch.setattr(deps, "get_jwks_cache", lambda: JwksCache(JWKS_URL))
    return priv


def _mint_jwt(priv, *, sub="u1", extra_claims=None):
    now = int(time.time())
    claims = {"sub": sub, "aud": "traceroot-api", "iss": "traceroot", "iat": now, "exp": now + 900}
    claims.update(extra_claims or {})
    return jwt.encode(claims, priv, algorithm="EdDSA", headers={"kid": _JWT_KID})


@respx.mock
def test_a_revoked_session_cannot_mint_a_key(monkeypatch):
    """The reason this route needs the liveness check more than the other writes.

    The credential it mints does not expire by default, so a key obtained after
    the session was revoked outlives the revocation entirely: signing out would
    no longer contain the compromise.
    """
    priv = _install_jwt_signer(monkeypatch)
    respx.post(LIVE_URL).mock(return_value=Response(200, json={"live": False}))
    internal = _mock_internal("user-create-project-key", CREATED_KEY)
    token = _mint_jwt(priv, extra_claims={"sid": "sess-1"})

    resp = TestClient(app, raise_server_exceptions=False).post(
        "/api/v1/public/projects/proj-1/api-keys",
        json={"name": "laptop"},
        headers={"Authorization": f"Bearer {token}"},
    )

    assert resp.status_code == 401
    assert resp.json() == {"detail": "Session revoked or expired"}
    assert not internal.called


@respx.mock
def test_a_live_session_mints_and_is_actually_checked(monkeypatch):
    """The liveness hop is taken, rather than the 201 coming from a skipped check."""
    priv = _install_jwt_signer(monkeypatch)
    live = respx.post(LIVE_URL).mock(return_value=Response(200, json={"live": True}))
    internal = _mock_internal("user-create-project-key", CREATED_KEY)
    token = _mint_jwt(priv, extra_claims={"sid": "sess-1"})

    resp = TestClient(app, raise_server_exceptions=False).post(
        "/api/v1/public/projects/proj-1/api-keys",
        json={"name": "laptop"},
        headers={"Authorization": f"Bearer {token}"},
    )

    assert resp.status_code == 201
    assert live.call_count == 1
    # And it checked THIS token's session, not some other one: the `sid` claim is
    # the whole of what makes the gate mean anything, and a regression that sent an
    # empty or wrong session id would still have produced one call.
    assert json.loads(live.calls.last.request.content) == {"sessionId": "sess-1"}
    assert internal.called


@respx.mock
def test_an_oversized_body_is_refused_before_it_is_parsed():
    """Nothing downstream bounds this: `name` is only checked after the parse."""
    _mock_account_auth()
    internal = _mock_internal("user-create-project-key", CREATED_KEY)

    resp = TestClient(app).post(
        "/api/v1/public/projects/proj-1/api-keys",
        content=b'{"name": "x"}',
        headers={
            **USER_HEADER,
            "Content-Type": "application/json",
            "Content-Length": str(128 * 1024),
        },
    )

    assert resp.status_code == 413
    assert resp.json() == {"detail": "Request body too large"}
    assert not internal.called
