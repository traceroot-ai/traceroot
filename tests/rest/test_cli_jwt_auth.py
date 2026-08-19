"""Tests for the CLI access-JWT authentication path in public/deps.py.

Covers offline verification (real Ed25519 signing), the account- and
project-scope AuthResult construction, and the security rejections (alg pinning,
audience/issuer/expiry, unknown kid, JWKS fail-closed). The session-token and
API-key paths are covered by test_auth_deps.py / test_public_dual_auth.py.
"""

import base64
import json
import time
from types import SimpleNamespace

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from fastapi import HTTPException
from httpx import Response
from jwt.algorithms import OKPAlgorithm

from rest.routers.public import deps
from rest.routers.public.deps import (
    _is_jwt,
    authenticate_account_caller,
    authenticate_public_caller,
)
from rest.routers.public.jwks_cache import JwksCache, JwksUnavailableError

BASE_URL = "http://localhost:3000"
JWKS_URL = f"{BASE_URL}/api/auth/jwks"
UPA_URL = f"{BASE_URL}/api/internal/user-project-access"
KID = "kid-1"


@pytest.fixture
def signer(respx_mock, monkeypatch):
    """A fresh Ed25519 signer + JWKS mock + a cache pointed at it."""
    priv = Ed25519PrivateKey.generate()
    jwk = OKPAlgorithm.to_jwk(priv.public_key(), as_dict=True)
    jwk.update(kid=KID, alg="EdDSA", use="sig")
    respx_mock.get(JWKS_URL).mock(return_value=Response(200, json={"keys": [jwk]}))
    monkeypatch.setattr(deps, "get_jwks_cache", lambda: JwksCache(JWKS_URL))
    return SimpleNamespace(priv=priv, respx=respx_mock)


def _mint(
    priv, *, sub="user-1", aud="traceroot-api", iss="traceroot", exp_delta=900, kid=KID, drop=()
):
    now = int(time.time())
    payload = {"sub": sub, "aud": aud, "iss": iss, "iat": now, "exp": now + exp_delta}
    for claim in drop:
        payload.pop(claim, None)
    headers = {"kid": kid} if kid else {}
    return jwt.encode(payload, priv, algorithm="EdDSA", headers=headers)


def _mock_project_access(respx_mock):
    return respx_mock.post(UPA_URL).mock(
        return_value=Response(
            200,
            json={
                "valid": True,
                "hasAccess": True,
                "userId": "user-1",
                "role": "ADMIN",
                "workspaceId": "ws-456",
                "billingPlan": "pro",
                "projectId": "proj-123",
            },
        )
    )


class TestIsJwt:
    def test_discrimination(self):
        assert _is_jwt("a.b.c") is True
        assert _is_jwt("opaque-session-token") is False
        assert _is_jwt("a.b") is False
        # Empty signature (e.g. an alg=none token) is NOT treated as a JWT — it
        # routes to the session-token path, which rejects it as a bad session.
        assert _is_jwt("a.b.") is False


class TestJwtHappyPath:
    async def test_project_scope_resolves_membership(self, signer):
        route = _mock_project_access(signer.respx)
        token = _mint(signer.priv)

        result = await authenticate_public_caller(
            authorization=f"Bearer {token}", project_id="proj-123"
        )

        # The verified sub (not any client-supplied value) is forwarded to the
        # internal route, alongside the requested project.
        assert json.loads(route.calls.last.request.content) == {
            "userId": "user-1",
            "projectId": "proj-123",
        }
        assert result.kind == "user"
        assert result.user_id == "user-1"
        assert result.role == "ADMIN"
        assert result.workspace_id == "ws-456"
        assert result.billing_plan == "pro"
        assert result.project_id == "proj-123"
        assert result.ingestion_blocked is True

    async def test_account_scope_needs_no_introspection(self, signer):
        token = _mint(signer.priv)

        result = await authenticate_account_caller(authorization=f"Bearer {token}")

        assert result.kind == "user"
        assert result.user_id == "user-1"
        assert result.project_id == ""
        assert result.workspace_id == ""
        assert result.ingestion_blocked is True

    async def test_project_scope_no_access_is_403(self, signer):
        signer.respx.post(UPA_URL).mock(return_value=Response(403, json={"hasAccess": False}))
        token = _mint(signer.priv)

        with pytest.raises(HTTPException) as exc:
            await authenticate_public_caller(authorization=f"Bearer {token}", project_id="proj-123")
        assert exc.value.status_code == 403

    async def test_project_scope_200_hasaccess_false_is_403(self, signer):
        # Defense-in-depth: a 200 body that explicitly denies access must 403,
        # never be read as a grant (guards against internal-route contract drift).
        signer.respx.post(UPA_URL).mock(
            return_value=Response(
                200,
                json={
                    "valid": True,
                    "hasAccess": False,
                    "userId": "user-1",
                    "role": "ADMIN",
                    "workspaceId": "ws-456",
                    "billingPlan": "pro",
                    "projectId": "proj-123",
                },
            )
        )
        with pytest.raises(HTTPException) as exc:
            await authenticate_public_caller(
                authorization=f"Bearer {_mint(signer.priv)}", project_id="proj-123"
            )
        assert exc.value.status_code == 403


class TestJwtRejections:
    async def test_hs256_alg_confusion_rejected(self, signer):
        # A token signed HS256 (the classic public-key-as-HMAC-secret attack)
        # must be rejected by the EdDSA pin, before any key is applied.
        now = int(time.time())
        token = jwt.encode(
            {"sub": "user-1", "aud": "traceroot-api", "iss": "traceroot", "exp": now + 900},
            "attacker-secret",
            algorithm="HS256",
            headers={"kid": KID},
        )
        with pytest.raises(HTTPException) as exc:
            await authenticate_account_caller(authorization=f"Bearer {token}")
        assert exc.value.status_code == 401

    async def test_attacker_key_with_trusted_kid_rejected(self, signer):
        # A token signed by an attacker's OWN Ed25519 key but carrying our
        # trusted kid must fail signature verification against the real JWKS
        # public key — the core guarantee of offline verification.
        attacker = Ed25519PrivateKey.generate()
        token = _mint(attacker)
        with pytest.raises(HTTPException) as exc:
            await authenticate_account_caller(authorization=f"Bearer {token}")
        assert exc.value.status_code == 401

    async def test_wrong_audience_rejected(self, signer):
        token = _mint(signer.priv, aud="some-other-api")
        with pytest.raises(HTTPException) as exc:
            await authenticate_account_caller(authorization=f"Bearer {token}")
        assert exc.value.status_code == 401

    async def test_wrong_issuer_rejected(self, signer):
        token = _mint(signer.priv, iss="evil")
        with pytest.raises(HTTPException) as exc:
            await authenticate_account_caller(authorization=f"Bearer {token}")
        assert exc.value.status_code == 401

    async def test_expired_rejected(self, signer):
        token = _mint(signer.priv, exp_delta=-10)
        with pytest.raises(HTTPException) as exc:
            await authenticate_account_caller(authorization=f"Bearer {token}")
        assert exc.value.status_code == 401

    async def test_missing_sub_rejected(self, signer):
        token = _mint(signer.priv, drop=("sub",))
        with pytest.raises(HTTPException) as exc:
            await authenticate_account_caller(authorization=f"Bearer {token}")
        assert exc.value.status_code == 401

    async def test_unknown_kid_rejected(self, signer):
        token = _mint(signer.priv, kid="not-our-kid")
        with pytest.raises(HTTPException) as exc:
            await authenticate_account_caller(authorization=f"Bearer {token}")
        assert exc.value.status_code == 401

    async def test_no_kid_rejected(self, signer):
        token = _mint(signer.priv, kid=None)
        with pytest.raises(HTTPException) as exc:
            await authenticate_account_caller(authorization=f"Bearer {token}")
        assert exc.value.status_code == 401

    async def test_non_string_kid_rejected(self, signer):
        # The header is attacker-controlled JSON, and jwt.encode refuses to mint
        # a non-string kid — so hand-craft the token the way an attacker would.
        # A list kid must be a clean 401, never a TypeError-turned-500 from the
        # JWKS lookup (pyjwt's header parse rejects it today; the explicit type
        # guard in _verify_access_jwt keeps that true if pyjwt's behavior moves).
        def b64(part: dict) -> str:
            return base64.urlsafe_b64encode(json.dumps(part).encode()).rstrip(b"=").decode()

        token = b64({"alg": "EdDSA", "kid": ["kid-1"]}) + "." + b64({"sub": "user-1"}) + ".AAAA"
        with pytest.raises(HTTPException) as exc:
            await authenticate_account_caller(authorization=f"Bearer {token}")
        assert exc.value.status_code == 401

    async def test_non_string_kid_guard_holds_without_pyjwt(self, signer, monkeypatch):
        # Pin OUR guard, not pyjwt's: bypass pyjwt's header validation so the
        # isinstance check is the only thing standing between a list kid and the
        # JWKS lookup. Deleting the guard must fail this test.
        monkeypatch.setattr(
            deps.jwt, "get_unverified_header", lambda _token: {"alg": "EdDSA", "kid": ["kid-1"]}
        )
        token = _mint(signer.priv)
        with pytest.raises(HTTPException) as exc:
            await authenticate_account_caller(authorization=f"Bearer {token}")
        assert exc.value.status_code == 401

    async def test_jwks_unavailable_fails_closed(self, signer, monkeypatch):
        class _Down:
            async def get_signing_key(self, kid):
                raise JwksUnavailableError("down")

        monkeypatch.setattr(deps, "get_jwks_cache", lambda: _Down())
        token = _mint(signer.priv)

        with pytest.raises(HTTPException) as exc:
            await authenticate_account_caller(authorization=f"Bearer {token}")
        assert exc.value.status_code == 503

    async def test_missing_exp_rejected(self, signer):
        # The require=["exp", "sub"] guard rejects a token with no expiry, before
        # any anonymous/forever-valid token can be accepted.
        token = _mint(signer.priv, drop=("exp",))
        with pytest.raises(HTTPException) as exc:
            await authenticate_account_caller(authorization=f"Bearer {token}")
        assert exc.value.status_code == 401

    async def test_empty_sub_rejected(self, signer):
        # An empty-string sub passes the require-presence check but is not a usable
        # identity: the `if not sub` guard rejects it.
        token = _mint(signer.priv, sub="")
        with pytest.raises(HTTPException) as exc:
            await authenticate_account_caller(authorization=f"Bearer {token}")
        assert exc.value.status_code == 401

    async def test_non_string_sub_rejected(self, signer):
        # A non-string sub (the `not isinstance(sub, str)` guard) is likewise rejected.
        token = _mint(signer.priv, sub=123)
        with pytest.raises(HTTPException) as exc:
            await authenticate_account_caller(authorization=f"Bearer {token}")
        assert exc.value.status_code == 401

    async def test_unparseable_jwt_shaped_token(self):
        # "a.b.c" is JWT-shaped (three non-empty segments) so it reaches
        # _verify_access_jwt, whose get_unverified_header raises before any JWKS
        # lookup — a 401, never an uncaught crash. No signer/JWKS needed.
        with pytest.raises(HTTPException) as exc:
            await authenticate_account_caller(authorization="Bearer a.b.c")
        assert exc.value.status_code == 401

    async def test_jwt_project_empty_workspace_fails_closed(self, signer):
        # A verified JWT whose user-project-access 200 carries an empty workspaceId
        # would collapse tenants into one rate-limit bucket → fail closed (503).
        signer.respx.post(UPA_URL).mock(
            return_value=Response(
                200,
                json={
                    "valid": True,
                    "hasAccess": True,
                    "userId": "user-1",
                    "role": "ADMIN",
                    "billingPlan": "pro",
                    "projectId": "proj-123",
                    "workspaceId": "",
                },
            )
        )
        with pytest.raises(HTTPException) as exc:
            await authenticate_public_caller(
                authorization=f"Bearer {_mint(signer.priv)}", project_id="proj-123"
            )
        assert exc.value.status_code == 503
        assert exc.value.detail == "Authentication service error"

    async def test_jwt_project_missing_fields_fails_closed(self, signer):
        # Same path, but the 200 omits required project fields (workspaceId/role/…)
        # → malformed introspection → fail closed (503), never an uncaught 500.
        signer.respx.post(UPA_URL).mock(
            return_value=Response(
                200,
                json={
                    "valid": True,
                    "hasAccess": True,
                    "userId": "user-1",
                    "projectId": "proj-123",
                },
            )
        )
        with pytest.raises(HTTPException) as exc:
            await authenticate_public_caller(
                authorization=f"Bearer {_mint(signer.priv)}", project_id="proj-123"
            )
        assert exc.value.status_code == 503
        assert exc.value.detail == "Authentication service error"
