"""Unit tests for the write-path liveness dependency and write rate bucket.

Writes are higher-stakes than reads, so a JWT credential (verified offline for
reads) additionally checks its ``sid`` against the live session row before a
write proceeds — revocation is instant where it matters. These tests exercise
``require_live_session`` directly with constructed ``AuthResult`` values (the
dependency's contract is the unit under test), the ``sid`` surface of
``_verify_access_jwt``, and the ``write`` rate-limit bucket key shapes.
"""

import json
import time

import httpx
import jwt
import pytest
import respx
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from fastapi import HTTPException, Request
from httpx import Response
from jwt.algorithms import OKPAlgorithm

from rest import rate_limit
from rest.routers.public import deps
from rest.routers.public.deps import (
    AuthResult,
    _verify_access_jwt,
    require_live_session,
)
from rest.routers.public.jwks_cache import JwksCache
from shared.config import settings

BASE_URL = "http://localhost:3000"
LIVE_URL = f"{BASE_URL}/api/internal/validate-session-live"
JWKS_URL = f"{BASE_URL}/api/auth/jwks"
_JWT_KID = "kid-write-1"


def _user_auth(session_id: str | None) -> AuthResult:
    """Build a user-credential AuthResult carrying the given session id."""
    return AuthResult(
        kind="user",
        project_id="",
        workspace_id="",
        billing_plan="free",
        ingestion_blocked=True,
        user_id="u1",
        session_id=session_id,
    )


def _mock_live(body, status_code: int = 200):
    """Mock the internal validate-session-live route."""
    return respx.post(LIVE_URL).mock(return_value=Response(status_code, json=body))


# ── require_live_session ────────────────────────────────────────────────


@respx.mock
async def test_jwt_write_passes_when_session_live():
    """A live session row lets the write proceed (dependency returns None)."""
    route = _mock_live({"live": True})

    assert await require_live_session(_user_auth("sess-1")) is None

    assert route.call_count == 1
    assert json.loads(route.calls.last.request.content) == {"sessionId": "sess-1"}


@respx.mock
async def test_jwt_write_401_when_session_revoked():
    """A revoked/expired session row blocks the write with a 401."""
    _mock_live({"live": False})

    with pytest.raises(HTTPException) as exc_info:
        await require_live_session(_user_auth("sess-1"))

    assert exc_info.value.status_code == 401
    assert exc_info.value.detail == "Session revoked or expired"


@respx.mock
async def test_write_dependency_503_on_introspection_error():
    """A network error reaching the liveness route fails closed with a 503."""
    respx.post(LIVE_URL).mock(side_effect=httpx.ConnectError("Connection refused"))

    with pytest.raises(HTTPException) as exc_info:
        await require_live_session(_user_auth("sess-1"))

    assert exc_info.value.status_code == 503


@respx.mock
async def test_write_dependency_503_on_unexpected_status():
    """A non-200 from the liveness route is an outage, not a verdict → 503."""
    _mock_live({"error": "boom"}, status_code=500)

    with pytest.raises(HTTPException) as exc_info:
        await require_live_session(_user_auth("sess-1"))

    assert exc_info.value.status_code == 503


@respx.mock
@pytest.mark.parametrize(
    "response",
    [
        Response(200, content=b"<html>not json</html>"),  # non-JSON body
        Response(200, json=["not", "a", "dict"]),  # non-object body
        Response(200, json={}),  # missing live field
        Response(200, json={"live": "yes"}),  # non-bool live
    ],
)
async def test_write_dependency_503_on_malformed_live_body(response):
    """A 200 whose body lacks a boolean ``live`` is malformed → 503, never a grant."""
    respx.post(LIVE_URL).mock(return_value=response)

    with pytest.raises(HTTPException) as exc_info:
        await require_live_session(_user_auth("sess-1"))

    assert exc_info.value.status_code == 503


@respx.mock
async def test_session_token_path_skips_live_check():
    """A session-token credential (no sid) already proved liveness — no hop."""
    route = _mock_live({"live": True})

    assert await require_live_session(_user_auth(None)) is None

    assert route.call_count == 0


# ── _verify_access_jwt sid surface ──────────────────────────────────────


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
    claims = {
        "sub": sub,
        "aud": "traceroot-api",
        "iss": "traceroot",
        "iat": now,
        "exp": now + 900,
    }
    claims.update(extra_claims or {})
    return jwt.encode(claims, priv, algorithm="EdDSA", headers={"kid": _JWT_KID})


@respx.mock
async def test_verify_access_jwt_returns_sid(monkeypatch):
    """The verified (sub, sid) pair surfaces; an absent sid comes back None."""
    priv = _install_jwt_signer(monkeypatch)

    with_sid = _mint_jwt(priv, sub="u1", extra_claims={"sid": "sess-1"})
    assert await _verify_access_jwt(with_sid) == ("u1", "sess-1")

    without_sid = _mint_jwt(priv, sub="u1")
    assert await _verify_access_jwt(without_sid) == ("u1", None)


@respx.mock
async def test_verify_access_jwt_non_string_sid_is_none(monkeypatch):
    """A malformed (non-string) sid never raises — it degrades to None."""
    priv = _install_jwt_signer(monkeypatch)

    token = _mint_jwt(priv, sub="u1", extra_claims={"sid": 123})
    assert await _verify_access_jwt(token) == ("u1", None)


# ── write rate bucket ───────────────────────────────────────────────────


def _stamped_request(workspace_id: str, plan: str, user_id: str | None) -> Request:
    """Build a bare Request and stamp the rate-limit identity onto it."""
    request = Request({"type": "http", "headers": [], "state": {}})
    rate_limit.set_rate_limit_identity(request, workspace_id, plan, user_id)
    return request


def test_key_write_shapes():
    """key_write mirrors key_read's three key shapes under the write bucket."""
    # Account scope (user, no workspace): per-user key.
    account = rate_limit.key_write(_stamped_request("", "free", "user-9"))
    assert account == "rl:write:free:user-9"

    # Project scope with a user credential: workspace + trailing user segment.
    project = rate_limit.key_write(_stamped_request("ws-abc", "pro", "user-1"))
    assert project == "rl:write:pro:ws-abc:user-1"

    # Key auth (no user stamped): workspace-only.
    key_auth = rate_limit.key_write(_stamped_request("ws-abc", "pro", None))
    assert key_auth == "rl:write:pro:ws-abc"


def test_key_write_stamps_write_bucket_on_request_state():
    """key_write records its bucket for the 429 log/metric path."""
    request = _stamped_request("ws-abc", "pro", None)
    rate_limit.key_write(request)
    assert request.state.rl_bucket == rate_limit.BUCKET_WRITE


def test_write_tier_matches_read_tier():
    """The write tier launches with the read numbers on every plan."""
    for plan in ("free", "starter", "pro", "enterprise"):
        assert settings.rate_limit.limit_for("write", plan) == settings.rate_limit.limit_for(
            "read", plan
        )
    # An unknown-bucket lookup still falls back to read, so a real write table
    # must resolve through the write entry, not the fallback — guard by name.
    assert rate_limit.BUCKET_WRITE == "write"
