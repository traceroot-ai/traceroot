"""Integration tests for the account-scope public writes (workspace/project).

These exercise the REAL account-scope dependency plus the write-path liveness
dependency and the create routes end-to-end, mocking the internal routes with
``respx``. The routes are thin proxies to the Next.js internal write routes, so
the tests pin three contracts: the outgoing internal body (camelCase, actor
stamped, ``transport: "public-api"``, no ``agentSessionId``), the response
translation (including the ``created`` idempotency flag), and end-to-end error
message parity — the write service's own strings surface unchanged as the
public API's ``detail``.
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
WS_WRITE_URL = f"{BASE_URL}/api/internal/write/workspaces"
PROJECT_WRITE_URL = f"{BASE_URL}/api/internal/write/projects"
_JWT_KID = "kid-acct-write-1"

USER_HEADER = {"Authorization": "Bearer user-session-token"}
KEY_HEADER = {"Authorization": "Bearer tr-some-key"}

# The account-scope validate-user-token 200 body (no project requested).
ACCOUNT_OK_BODY = {"valid": True, "userId": "u1", "email": "u@example.com"}

WORKSPACE_ROW = {"id": "ws-new", "name": "Alpha", "role": "ADMIN"}
PROJECT_ROW = {"id": "proj-new", "name": "P1", "workspaceId": "ws-1"}


def _mock_account_auth():
    """Mock the account-scope introspection to a valid live session."""
    return respx.post(f"{BASE_URL}/api/internal/validate-user-token").mock(
        return_value=Response(200, json=ACCOUNT_OK_BODY)
    )


def _mock_workspace_write(body=None, status_code=200):
    """Mock the internal workspace write route."""
    if body is None:
        body = {"created": True, "workspace": WORKSPACE_ROW}
    return respx.post(WS_WRITE_URL).mock(return_value=Response(status_code, json=body))


def _mock_project_write(body=None, status_code=200):
    """Mock the internal project write route."""
    if body is None:
        body = {"created": True, "project": PROJECT_ROW}
    return respx.post(PROJECT_WRITE_URL).mock(return_value=Response(status_code, json=body))


def _client():
    return TestClient(app, raise_server_exceptions=False)


# ── auth gating ─────────────────────────────────────────────────────────


def test_create_workspace_requires_authorization():
    """No Authorization header → 401 before any internal call."""
    resp = _client().post("/api/v1/public/workspaces", json={"name": "Alpha"})
    assert resp.status_code == 401


@respx.mock
def test_create_workspace_rejects_api_key_with_403():
    """An API key is project-scoped and cannot act on an account."""
    write = _mock_workspace_write()
    resp = _client().post("/api/v1/public/workspaces", json={"name": "Alpha"}, headers=KEY_HEADER)
    assert resp.status_code == 403
    assert write.call_count == 0


# ── happy paths + body translation ──────────────────────────────────────


@respx.mock
def test_create_workspace_happy_path():
    """The internal body carries the introspected actor, public transport, and
    no agentSessionId; the response translates the row plus the created flag."""
    _mock_account_auth()
    write = _mock_workspace_write()

    resp = _client().post("/api/v1/public/workspaces", json={"name": "Alpha"}, headers=USER_HEADER)

    assert resp.status_code == 200
    assert resp.json() == {"id": "ws-new", "name": "Alpha", "role": "ADMIN", "created": True}
    # Exact-body equality also pins that agentSessionId is absent.
    assert json.loads(write.calls.last.request.content) == {
        "actorUserId": "u1",
        "name": "Alpha",
        "transport": "public-api",
    }


@respx.mock
def test_create_workspace_idempotent_hit_reports_created_false():
    """An idempotent re-create surfaces the existing row with created: false."""
    _mock_account_auth()
    _mock_workspace_write(body={"created": False, "workspace": WORKSPACE_ROW})

    resp = _client().post("/api/v1/public/workspaces", json={"name": "Alpha"}, headers=USER_HEADER)

    assert resp.status_code == 200
    assert resp.json() == {"id": "ws-new", "name": "Alpha", "role": "ADMIN", "created": False}


@respx.mock
def test_create_project_translates_trace_ttl_days():
    """snake_case public fields cross to the camelCase internal body."""
    _mock_account_auth()
    write = _mock_project_write()

    resp = _client().post(
        "/api/v1/public/projects",
        json={"workspace_id": "ws-1", "name": "P1", "trace_ttl_days": 30},
        headers=USER_HEADER,
    )

    assert resp.status_code == 200
    assert resp.json() == {"id": "proj-new", "name": "P1", "workspace_id": "ws-1", "created": True}
    assert json.loads(write.calls.last.request.content) == {
        "actorUserId": "u1",
        "workspaceId": "ws-1",
        "name": "P1",
        "traceTtlDays": 30,
        "transport": "public-api",
    }


@respx.mock
def test_create_project_omits_absent_trace_ttl_days():
    """An unset optional is left out of the internal body entirely (the internal
    zod distinguishes absent from null in places; absent is always safe)."""
    _mock_account_auth()
    write = _mock_project_write()

    resp = _client().post(
        "/api/v1/public/projects",
        json={"workspace_id": "ws-1", "name": "P1"},
        headers=USER_HEADER,
    )

    assert resp.status_code == 200
    assert json.loads(write.calls.last.request.content) == {
        "actorUserId": "u1",
        "workspaceId": "ws-1",
        "name": "P1",
        "transport": "public-api",
    }


# ── upstream error passthrough (end-to-end message parity) ──────────────


@respx.mock
def test_create_project_forwards_the_service_role_message():
    """The write service's own 403 string is the public detail, verbatim."""
    _mock_account_auth()
    _mock_project_write(body={"error": "Requires MEMBER role or higher"}, status_code=403)

    resp = _client().post(
        "/api/v1/public/projects",
        json={"workspace_id": "ws-1", "name": "P1"},
        headers=USER_HEADER,
    )

    assert resp.status_code == 403
    assert resp.json() == {"detail": "Requires MEMBER role or higher"}


@respx.mock
def test_create_project_forwards_upstream_404():
    _mock_account_auth()
    _mock_project_write(body={"error": "Workspace not found"}, status_code=404)

    resp = _client().post(
        "/api/v1/public/projects",
        json={"workspace_id": "ws-missing", "name": "P1"},
        headers=USER_HEADER,
    )

    assert resp.status_code == 404
    assert resp.json() == {"detail": "Workspace not found"}


@respx.mock
def test_create_workspace_forwards_upstream_400_message():
    _mock_account_auth()
    _mock_workspace_write(
        body={"error": "name must be a non-empty string (max 100 chars)"}, status_code=400
    )

    resp = _client().post("/api/v1/public/workspaces", json={"name": " "}, headers=USER_HEADER)

    assert resp.status_code == 400
    assert resp.json() == {"detail": "name must be a non-empty string (max 100 chars)"}


@respx.mock
def test_create_workspace_passthrough_without_error_string_uses_fallback():
    """A passthrough status whose body carries no error string falls back to a
    generic per-status detail — the raw body is never surfaced."""
    _mock_account_auth()
    respx.post(WS_WRITE_URL).mock(return_value=Response(403, content=b"<html>gateway page</html>"))

    resp = _client().post("/api/v1/public/workspaces", json={"name": "Alpha"}, headers=USER_HEADER)

    assert resp.status_code == 403
    assert resp.json() == {"detail": "Forbidden"}


@respx.mock
def test_create_project_malformed_upstream_body_is_503():
    """A 200 body without the resource envelope is malformed → 503, never a 500."""
    _mock_account_auth()
    _mock_project_write(body={"created": True})

    resp = _client().post(
        "/api/v1/public/projects",
        json={"workspace_id": "ws-1", "name": "P1"},
        headers=USER_HEADER,
    )

    assert resp.status_code == 503


@respx.mock
def test_create_workspace_network_error_is_503():
    """A network error reaching the internal write route fails closed (503)."""
    _mock_account_auth()
    respx.post(WS_WRITE_URL).mock(side_effect=httpx.ConnectError("Connection refused"))

    resp = _client().post("/api/v1/public/workspaces", json={"name": "Alpha"}, headers=USER_HEADER)

    assert resp.status_code == 503


@respx.mock
def test_create_workspace_upstream_401_is_503():
    """A 401 from the internal route means OUR secret is misconfigured — the
    caller's credential already passed, so surface an outage, not a 401."""
    _mock_account_auth()
    _mock_workspace_write(body={"error": "Unauthorized"}, status_code=401)

    resp = _client().post("/api/v1/public/workspaces", json={"name": "Alpha"}, headers=USER_HEADER)

    assert resp.status_code == 503


@respx.mock
def test_create_workspace_malformed_upstream_body_is_503():
    """A 200 body without the resource envelope is malformed → 503, never a 500."""
    _mock_account_auth()
    _mock_workspace_write(body={"created": True})

    resp = _client().post("/api/v1/public/workspaces", json={"name": "Alpha"}, headers=USER_HEADER)

    assert resp.status_code == 503


@respx.mock
@pytest.mark.parametrize(
    "workspace",
    [
        {"id": 123, "name": "Alpha", "role": "ADMIN"},  # non-string id
        {"id": "ws-new", "name": None, "role": "ADMIN"},  # null name
    ],
)
def test_create_workspace_wrong_typed_envelope_is_503(workspace):
    """A 200 envelope whose fields are wrongly typed fails closed, never a 500.

    The response model rejects these, and that rejection must map to the same
    controlled 503 as a missing envelope.
    """
    _mock_account_auth()
    _mock_workspace_write(body={"created": True, "workspace": workspace})

    resp = _client().post("/api/v1/public/workspaces", json={"name": "Alpha"}, headers=USER_HEADER)

    assert resp.status_code == 503


@respx.mock
def test_create_project_wrong_typed_envelope_is_503():
    """A 200 project envelope with a wrongly typed field fails closed (503)."""
    _mock_account_auth()
    _mock_project_write(
        body={"created": True, "project": {"id": "p", "name": "P1", "workspaceId": 7}}
    )

    resp = _client().post(
        "/api/v1/public/projects",
        json={"workspace_id": "ws-1", "name": "P1"},
        headers=USER_HEADER,
    )

    assert resp.status_code == 503


# ── CLI access JWT write path (offline verify + session liveness) ───────


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
def test_jwt_write_with_revoked_session_is_401(monkeypatch):
    """A JWT whose minting session was revoked is blocked before the write."""
    priv = _install_jwt_signer(monkeypatch)
    respx.post(LIVE_URL).mock(return_value=Response(200, json={"live": False}))
    write = _mock_workspace_write()
    token = _mint_jwt(priv, extra_claims={"sid": "sess-1"})

    resp = _client().post(
        "/api/v1/public/workspaces",
        json={"name": "Alpha"},
        headers={"Authorization": f"Bearer {token}"},
    )

    assert resp.status_code == 401
    assert resp.json() == {"detail": "Session revoked or expired"}
    assert write.call_count == 0


@respx.mock
def test_jwt_write_with_live_session_succeeds(monkeypatch):
    """A JWT with a live sid passes the liveness check and writes as its subject."""
    priv = _install_jwt_signer(monkeypatch)
    live = respx.post(LIVE_URL).mock(return_value=Response(200, json={"live": True}))
    write = _mock_workspace_write()
    token = _mint_jwt(priv, extra_claims={"sid": "sess-1"})

    resp = _client().post(
        "/api/v1/public/workspaces",
        json={"name": "Alpha"},
        headers={"Authorization": f"Bearer {token}"},
    )

    assert resp.status_code == 200
    assert resp.json() == {"id": "ws-new", "name": "Alpha", "role": "ADMIN", "created": True}
    assert live.call_count == 1
    assert json.loads(live.calls.last.request.content) == {"sessionId": "sess-1"}
    assert json.loads(write.calls.last.request.content) == {
        "actorUserId": "u1",
        "name": "Alpha",
        "transport": "public-api",
    }


@respx.mock
def test_jwt_without_sid_is_rejected(monkeypatch):
    """A JWT carrying no sid is rejected rather than writing unchecked.

    Without a sid there is no session to verify, so accepting the token would
    let it write past a revoked session until it expired.
    """
    priv = _install_jwt_signer(monkeypatch)
    live = respx.post(LIVE_URL).mock(return_value=Response(200, json={"live": True}))
    write = _mock_workspace_write()
    token = _mint_jwt(priv, extra_claims={"sid": None})

    resp = _client().post(
        "/api/v1/public/workspaces",
        json={"name": "Alpha"},
        headers={"Authorization": f"Bearer {token}"},
    )

    assert resp.status_code == 401
    assert live.call_count == 0
    assert write.call_count == 0
