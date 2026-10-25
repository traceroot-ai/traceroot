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
from fastapi.routing import APIRoute
from fastapi.testclient import TestClient
from httpx import Response
from jwt.algorithms import OKPAlgorithm
from starlette.requests import Request

from rest.main import app
from rest.rate_limit import (
    BUCKET_WRITE,
    is_request_rate_limit_exempt,
    key_write,
    limiter,
    set_rate_limit_identity,
)
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
@pytest.mark.parametrize("upstream_body", [{}, {"error": None}, {"error": {"code": "conflict"}}])
def test_an_error_without_a_string_message_fails_closed(upstream_body):
    """`{detail}` is always a string, so an error body that has none is ambiguous."""
    _mock_account_auth()
    _mock_internal("user-create-project-key", upstream_body, status_code=409)

    resp = TestClient(app).post(
        "/api/v1/public/projects/proj-1/api-keys", json={"name": "x"}, headers=USER_HEADER
    )

    assert resp.status_code == 503
    assert resp.json() == {"detail": "Project service error"}


@respx.mock
@pytest.mark.parametrize("missing", ["id", "key"])
def test_a_mint_success_without_its_key_fails_closed(missing):
    """A 201 that carries no usable key must not read as a key minted."""
    _mock_account_auth()
    body = {field: value for field, value in CREATED_KEY.items() if field != missing}
    _mock_internal("user-create-project-key", body, status_code=201)

    resp = TestClient(app).post(
        "/api/v1/public/projects/proj-1/api-keys", json={"name": "x"}, headers=USER_HEADER
    )

    assert resp.status_code == 503
    assert resp.json() == {"detail": "Project service error"}
    assert "tr-secret-value" not in resp.text


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
def test_an_oversized_declared_length_is_refused_before_the_body_is_read():
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


@respx.mock
def test_a_body_that_declares_no_length_is_still_refused():
    """The branch that actually enforces the cap.

    A declared ``Content-Length`` is only a hint, and the docstring on
    ``_read_capped_body`` says as much: a chunked or mis-declared body has no
    trustworthy length, so the streaming check is what does the work. Sending the
    bytes without a usable length is the only way to exercise it — the
    declared-length test above still passes with that check deleted.
    """
    _mock_account_auth()
    internal = _mock_internal("user-create-project-key", CREATED_KEY)

    def chunks():
        # 80 KiB in ten chunks, over the 64 KiB ceiling, streamed so httpx uses
        # chunked transfer encoding and sends no Content-Length at all.
        for _ in range(10):
            yield b"x" * 8192

    resp = TestClient(app).post(
        "/api/v1/public/projects/proj-1/api-keys",
        content=chunks(),
        headers={**USER_HEADER, "Content-Type": "application/json"},
    )

    assert resp.status_code == 413
    assert resp.json() == {"detail": "Request body too large"}
    assert not internal.called


# ── Revoking a key on the same credential ────────────────────────────────

REVOKE_PATH = "/api/v1/public/projects/proj-1/api-keys/key-1"
REVOKED = {"deleted": True}


def test_the_revoke_route_is_wired_like_the_mint():
    """Hidden, on the write bucket, and behind the same two dependencies."""
    routes = [
        r
        for r in app.routes
        if isinstance(r, APIRoute)
        and r.path == "/api/v1/public/projects/{project_id}/api-keys/{key_id}"
    ]
    assert len(routes) == 1
    (route,) = routes
    assert route.methods == {"DELETE"}
    assert route.include_in_schema is False

    calls = [d.call for d in route.dependant.dependencies]
    assert deps.authenticate_and_stamp_account_caller in calls
    assert deps.require_live_session in calls

    (group,) = limiter._dynamic_route_limits["rest.routers.public.projects.revoke_project_api_key"]
    assert group.key_function is key_write
    assert group.exempt_when is is_request_rate_limit_exempt
    request = Request({"type": "http", "headers": [], "state": {}})
    set_rate_limit_identity(request, "", "free", "u1")
    assert [limit.scope for limit in group.with_request(request)] == [BUCKET_WRITE]


@respx.mock
def test_revoking_a_key_forwards_the_resolved_user_and_answers_204():
    _mock_account_auth()
    internal = _mock_internal("user-revoke-project-key", REVOKED, status_code=200)

    resp = TestClient(app).delete(REVOKE_PATH, headers=USER_HEADER)

    assert resp.status_code == 204
    assert resp.content == b""
    assert json.loads(internal.calls.last.request.content) == {
        "userId": "u1",
        "projectId": "proj-1",
        "keyId": "key-1",
    }
    # The user's credential stays in this process; only the internal secret crosses.
    assert "authorization" not in internal.calls.last.request.headers


@respx.mock
def test_a_revoke_success_that_does_not_say_deleted_fails_closed():
    """A 204 here tells the CLI its cleanup is done, so it needs the route's word."""
    _mock_account_auth()
    _mock_internal("user-revoke-project-key", {"valid": True}, status_code=200)

    resp = TestClient(app).delete(REVOKE_PATH, headers=USER_HEADER)

    assert resp.status_code == 503
    assert resp.json() == {"detail": "Project service error"}


@respx.mock
def test_a_project_api_key_cannot_revoke_on_the_user_route():
    internal = _mock_internal("user-revoke-project-key", REVOKED, status_code=200)

    resp = TestClient(app).delete(REVOKE_PATH, headers=KEY_HEADER)

    assert resp.status_code == 403
    assert not internal.called


@respx.mock
def test_a_revoke_with_no_credential_never_reaches_the_control_plane():
    internal = _mock_internal("user-revoke-project-key", REVOKED, status_code=200)

    resp = TestClient(app).delete(REVOKE_PATH)

    assert resp.status_code == 401
    assert not internal.called


@respx.mock
@pytest.mark.parametrize(
    ("status_code", "upstream_error"),
    [
        (404, "Access key not found"),
        (404, "Project not found"),
        (403, "Requires ADMIN role or higher"),
        (403, "Not a member of this workspace"),
    ],
)
def test_revoke_errors_keep_their_status_in_the_public_shape(status_code, upstream_error):
    _mock_account_auth()
    _mock_internal("user-revoke-project-key", {"error": upstream_error}, status_code=status_code)

    resp = TestClient(app).delete(REVOKE_PATH, headers=USER_HEADER)

    assert resp.status_code == status_code
    assert resp.json() == {"detail": upstream_error}


@respx.mock
def test_a_revoke_that_gets_no_json_back_fails_closed():
    _mock_account_auth()
    respx.post(f"{BASE_URL}/api/internal/user-revoke-project-key").mock(
        return_value=Response(500, text="<html>stack trace</html>")
    )

    resp = TestClient(app).delete(REVOKE_PATH, headers=USER_HEADER)

    assert resp.status_code == 503
    assert "stack trace" not in resp.text


@respx.mock
@pytest.mark.parametrize(
    ("key_id", "detail"),
    [
        # Dot-segments. The server unquotes the path before routing, so `%2e%2e`
        # is how `..` gets past a client that would normalize it itself.
        ("%2e%2e", "Not found"),
        ("%2e", "Not found"),
        # Double-encoded traversal arrives with a literal `%`.
        ("%252e%252e", "Not found"),
        # Backslash traversal.
        ("..%5C..%5Cinternal", "Not found"),
        # A query, a fragment, a scheme separator or whitespace in the id.
        ("key-1%3Fx%3D1", "Not found"),
        ("key-1%23frag", "Not found"),
        ("http:evil.example", "Not found"),
        ("key%201", "Not found"),
        ("k" * 129, "Not found"),
        # `%2F` also arrives unquoted, and `{key_id}` is `[^/]+`, so these never
        # match the route and FastAPI's own 404 answers them. Listed because the
        # attempt is the same, and so is what matters: 404, and nothing forwarded.
        ("..%2F..%2Finternal%2Fvalidate-api-key", "Not Found"),
        ("http:%2F%2Fevil.example%2Fx", "Not Found"),
    ],
)
def test_a_key_id_that_is_not_one_opaque_segment_is_404_and_never_forwarded(key_id, detail):
    _mock_account_auth()
    internal = _mock_internal("user-revoke-project-key", REVOKED, status_code=200)

    resp = TestClient(app).delete(
        f"/api/v1/public/projects/proj-1/api-keys/{key_id}", headers=USER_HEADER
    )

    assert resp.status_code == 404, resp.text
    assert resp.json() == {"detail": detail}
    assert not internal.called


@respx.mock
def test_a_real_key_id_still_forwards_unchanged():
    """The guard above must not cost a legitimate revoke: key ids are UUIDs."""
    _mock_account_auth()
    internal = _mock_internal("user-revoke-project-key", REVOKED, status_code=200)
    key_id = "0b9c2f14-6c3f-4a0e-9c3a-4d9a1f2b3c4d"

    resp = TestClient(app).delete(
        f"/api/v1/public/projects/proj-1/api-keys/{key_id}", headers=USER_HEADER
    )

    assert resp.status_code == 204
    assert json.loads(internal.calls.last.request.content)["keyId"] == key_id


@respx.mock
def test_a_revoked_session_cannot_revoke_a_key(monkeypatch):
    priv = _install_jwt_signer(monkeypatch)
    respx.post(LIVE_URL).mock(return_value=Response(200, json={"live": False}))
    internal = _mock_internal("user-revoke-project-key", REVOKED, status_code=200)
    token = _mint_jwt(priv, extra_claims={"sid": "sess-1"})

    resp = TestClient(app, raise_server_exceptions=False).delete(
        REVOKE_PATH, headers={"Authorization": f"Bearer {token}"}
    )

    assert resp.status_code == 401
    assert resp.json() == {"detail": "Session revoked or expired"}
    assert not internal.called
