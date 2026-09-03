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


# ── liveness gate coverage across every write route ─────────────────────

# The four write routes beyond create_workspace, each with its minimal valid
# body and the internal write route it would reach if the gate failed open.
_OTHER_WRITE_ROUTES = [
    (
        "/api/v1/public/projects",
        {"workspace_id": "ws-1", "name": "P1"},
        PROJECT_WRITE_URL,
    ),
    (
        "/api/v1/public/detectors",
        {"project_id": "proj-1", "name": "D", "template": "custom", "prompt": "p"},
        f"{BASE_URL}/api/internal/write/detectors",
    ),
    (
        "/api/v1/public/dashboards",
        {"project_id": "proj-1", "name": "Spend"},
        f"{BASE_URL}/api/internal/write/dashboards",
    ),
    (
        "/api/v1/public/widgets",
        {
            "project_id": "proj-1",
            "dashboard_id": "dash-1",
            "title": "Cost",
            "type": "query",
            "spec": {},
        },
        f"{BASE_URL}/api/internal/write/widgets",
    ),
]


@respx.mock
@pytest.mark.parametrize(("path", "body", "write_url"), _OTHER_WRITE_ROUTES)
def test_jwt_write_with_revoked_session_is_401_on_every_write_route(
    monkeypatch, path, body, write_url
):
    """Every write route blocks a JWT whose minting session was revoked.

    The liveness dependency is wired per route, so create_workspace passing
    proves nothing about the other four — without this, deleting ``_live``
    from any of them would let a revoked CLI session keep writing until its
    JWT expired, with CI green.
    """
    priv = _install_jwt_signer(monkeypatch)
    respx.post(LIVE_URL).mock(return_value=Response(200, json={"live": False}))
    write = respx.post(write_url).mock(return_value=Response(200, json={}))
    token = _mint_jwt(priv, extra_claims={"sid": "sess-1"})

    resp = _client().post(path, json=body, headers={"Authorization": f"Bearer {token}"})

    assert resp.status_code == 401
    assert resp.json() == {"detail": "Session revoked or expired"}
    assert write.call_count == 0


# ── write rate bucket enforcement (route level) ─────────────────────────

# Success envelope per internal write route, so throttle tests see clean 200s
# until the bucket trips.
_WRITE_ENVELOPES = {
    WS_WRITE_URL: {"created": True, "workspace": WORKSPACE_ROW},
    PROJECT_WRITE_URL: {"created": True, "project": PROJECT_ROW},
    f"{BASE_URL}/api/internal/write/detectors": {
        "created": True,
        "detector": {
            "id": "d1",
            "name": "D",
            "projectId": "proj-1",
            "enabled": True,
            "sampleRate": 10,
        },
    },
    f"{BASE_URL}/api/internal/write/dashboards": {
        "created": True,
        "dashboard": {"id": "da1", "name": "Spend", "projectId": "proj-1"},
    },
    f"{BASE_URL}/api/internal/write/widgets": {
        "created": True,
        "widget": {"id": "w1", "dashboardId": "dash-1", "title": "Cost", "type": "query"},
    },
}

_ALL_WRITE_ROUTES = [
    ("/api/v1/public/workspaces", {"name": "Alpha"}, WS_WRITE_URL)
] + _OTHER_WRITE_ROUTES


@pytest.fixture()
def _enabled_memory_limiter(monkeypatch):
    """Enable the app's REAL limiter on fresh in-memory storage.

    The route decorators captured the module-level limiter instance at import
    time, so the fixture flips that instance on and swaps its storage/strategy
    for a per-test MemoryStorage — hermetic (no Redis), reset every test, and
    exercising the exact decorators production runs. The free write tier is
    pinned to 2/minute so the third request trips the bucket.
    """
    from limits.storage import MemoryStorage
    from limits.strategies import FixedWindowRateLimiter

    from rest import rate_limit
    from shared.config import _PLAN_LIMITS_WRITE

    storage = MemoryStorage()
    monkeypatch.setattr(rate_limit.limiter, "enabled", True)
    monkeypatch.setattr(rate_limit.limiter, "_storage", storage)
    monkeypatch.setattr(rate_limit.limiter, "_limiter", FixedWindowRateLimiter(storage))
    monkeypatch.setitem(_PLAN_LIMITS_WRITE, "free", "2/minute")


@respx.mock
@pytest.mark.parametrize(("path", "body", "write_url"), _ALL_WRITE_ROUTES)
def test_every_write_route_throttles_on_the_write_bucket(
    _enabled_memory_limiter, path, body, write_url
):
    """Each of the five write routes 429s once the write bucket is exhausted.

    The decorator is wired per route, so a unit test of ``key_write``'s key
    string proves nothing about the routes — without this, dropping the
    decorator (or a ``scope=`` typo) would silently turn a public write into
    an unmetered create endpoint with CI green.
    """
    _mock_account_auth()
    respx.post(write_url).mock(return_value=Response(200, json=_WRITE_ENVELOPES[write_url]))
    client = _client()

    statuses = [client.post(path, json=body, headers=USER_HEADER).status_code for _ in range(3)]

    assert statuses == [200, 200, 429]


@respx.mock
def test_reads_do_not_consume_the_write_bucket(_enabled_memory_limiter):
    """Read traffic and write traffic draw from independent buckets."""
    _mock_account_auth()
    respx.post(f"{BASE_URL}/api/internal/user-memberships").mock(
        return_value=Response(200, json={"workspaces": []})
    )
    _mock_workspace_write()
    client = _client()

    # A read first: if it drew from the write bucket, the writes below would
    # trip one request early.
    assert client.get("/api/v1/public/workspaces", headers=USER_HEADER).status_code == 200
    statuses = [
        client.post(
            "/api/v1/public/workspaces", json={"name": "Alpha"}, headers=USER_HEADER
        ).status_code
        for _ in range(3)
    ]
    assert statuses == [200, 200, 429]
    # And the exhausted write bucket does not throttle reads either.
    assert client.get("/api/v1/public/workspaces", headers=USER_HEADER).status_code == 200


# ── proxy encode backstop ───────────────────────────────────────────────


@respx.mock
def test_post_internal_write_unencodable_payload_fails_closed_as_503():
    """A payload httpx cannot JSON-encode fails closed as a controlled 503.

    The schema layer rejects non-finite floats with a 422, so this backstop
    should be unreachable — but if a NaN ever slips through, the encode's
    ValueError must map to the shared 503, never escape as an uncaught 500.
    """
    import asyncio

    from fastapi import HTTPException

    from rest.routers.public.account_write import _post_internal_write

    with pytest.raises(HTTPException) as exc_info:
        asyncio.run(
            _post_internal_write("/api/internal/write/widgets", {"spec": {"v": float("nan")}})
        )

    assert exc_info.value.status_code == 503
