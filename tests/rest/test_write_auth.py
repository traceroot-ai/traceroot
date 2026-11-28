"""Tests for the public-write rate bucket and authenticated identity stamping."""

import time

import jwt
import respx
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from fastapi import Request
from httpx import Response
from jwt.algorithms import OKPAlgorithm

from rest import rate_limit
from rest.routers.public import deps
from rest.routers.public.jwks_cache import JwksCache
from shared.config import settings

BASE_URL = "http://localhost:3000"
LIVE_URL = f"{BASE_URL}/api/internal/validate-session-live"
JWKS_URL = f"{BASE_URL}/api/auth/jwks"
_JWT_KID = "kid-write-1"


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


# ── write rate bucket ───────────────────────────────────────────────────


def _stamped_request(workspace_id: str, plan: str, user_id: str | None) -> Request:
    """Build a bare Request and stamp the rate-limit identity onto it."""
    request = Request({"type": "http", "headers": [], "state": {}})
    rate_limit.set_rate_limit_identity(request, workspace_id, plan, user_id)
    return request


def test_key_write_composition_format_only():
    """key_write composes the three key shapes — FORMAT check only.

    These hand-stamped identities pin the key-composition contract for the
    future per-plan design; production cannot produce the paid/workspace
    shapes today (every account credential is stamped plan="free" with no
    workspace — see the reality test below).
    """
    # Account scope (user, no workspace): per-user key.
    account = rate_limit.key_write(_stamped_request("", "free", "user-9"))
    assert account == "rl:write:free:user-9"

    # Project scope with a user credential: workspace + trailing user segment.
    project = rate_limit.key_write(_stamped_request("ws-abc", "pro", "user-1"))
    assert project == "rl:write:pro:ws-abc:user-1"

    # Key auth (no user stamped): workspace-only.
    key_auth = rate_limit.key_write(_stamped_request("ws-abc", "pro", None))
    assert key_auth == "rl:write:pro:ws-abc"


@respx.mock
async def test_write_key_reality_every_account_credential_is_free(monkeypatch):
    """Production write keys are ``rl:write:free:{user_id}`` — nothing else.

    Drives the real dependency chain the write routes use — credential →
    ``authenticate_account_caller`` → ``authenticate_and_stamp_account_caller``
    → ``key_write`` — with a verified CLI JWT. ``_account_result_for_user``
    stamps every account credential as plan "free" with no workspace, so the
    "free" row of ``_PLAN_LIMITS_WRITE`` is the effective global write limit.
    If you land per-request plan resolution, this fails on purpose: update it
    together with ``_PLAN_LIMITS_WRITE``'s comment and the format-only test above.
    """
    priv = _install_jwt_signer(monkeypatch)
    token = _mint_jwt(priv, sub="user-42", extra_claims={"sid": "sess-1"})
    respx.post(LIVE_URL).mock(return_value=Response(200, json={"live": True}))

    auth = await deps.authenticate_account_caller(authorization=f"Bearer {token}")
    request = Request({"type": "http", "headers": [], "state": {}})
    await deps.authenticate_and_stamp_account_caller(request, auth)

    assert rate_limit.key_write(request) == "rl:write:free:user-42"


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
