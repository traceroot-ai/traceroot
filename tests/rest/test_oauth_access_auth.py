"""Tests for OAuth access-token authentication (assistant connectors).

An OAuth token is a different credential class from the CLI access JWT: it is
issued for the MCP resource, names the one project the user chose at consent,
carries the read scope, and is re-checked against the live grant on every
request. These tests cover the accept path and each rejection, using real
Ed25519 signing like test_cli_jwt_auth.py.
"""

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
    authenticate_account_caller,
    authenticate_and_stamp_public_caller,
    authenticate_public_caller,
)
from rest.routers.public.jwks_cache import JwksCache
from shared.config import settings

BASE_URL = "http://localhost:3000"
JWKS_URL = f"{BASE_URL}/api/auth/jwks"
GRANT_URL = f"{BASE_URL}/api/internal/oauth-grant-access"
ISSUER = "http://localhost:3000/api/auth"
RESOURCE = "http://localhost:8200/mcp"
KID = "kid-1"


@pytest.fixture
def signer(respx_mock, monkeypatch):
    priv = Ed25519PrivateKey.generate()
    jwk = OKPAlgorithm.to_jwk(priv.public_key(), as_dict=True)
    jwk.update(kid=KID, alg="EdDSA", use="sig")
    respx_mock.get(JWKS_URL).mock(return_value=Response(200, json={"keys": [jwk]}))
    monkeypatch.setattr(deps, "get_jwks_cache", lambda: JwksCache(JWKS_URL))
    monkeypatch.setattr(settings, "traceroot_oauth_issuer", ISSUER)
    monkeypatch.setattr(settings, "traceroot_oauth_audiences", RESOURCE)
    return SimpleNamespace(priv=priv, respx=respx_mock)


def _mint(priv, *, drop=(), **overrides):
    now = int(time.time())
    payload = {
        "sub": "user-1",
        "iss": ISSUER,
        "aud": RESOURCE,
        "iat": now,
        "exp": now + 900,
        "jti": "tok-1",
        "client_id": "client-1",
        "scope": "mcp:read offline_access",
        "project_id": "proj-123",
    }
    payload.update(overrides)
    for claim in drop:
        payload.pop(claim, None)
    return jwt.encode(payload, priv, algorithm="EdDSA", headers={"kid": KID})


def _grant(respx_mock, status=200, **body):
    base = {
        "valid": True,
        "hasAccess": True,
        "userId": "user-1",
        "role": "MEMBER",
        "workspaceId": "ws-456",
        "billingPlan": "pro",
        "projectId": "proj-123",
    }
    base.update(body)
    return respx_mock.post(GRANT_URL).mock(return_value=Response(status, json=base))


def _request(method="GET", route_name="list_traces"):
    return SimpleNamespace(
        method=method,
        scope={"route": SimpleNamespace(name=route_name)},
        state=SimpleNamespace(),
    )


class TestAcceptPath:
    async def test_resolves_the_granted_project_without_a_project_id_param(self, signer):
        route = _grant(signer.respx)

        result = await authenticate_public_caller(
            authorization=f"Bearer {_mint(signer.priv)}", project_id=None
        )

        # The verified claims, not anything the caller sent, are forwarded.
        assert json.loads(route.calls.last.request.content) == {
            "userId": "user-1",
            "projectId": "proj-123",
            "clientId": "client-1",
        }
        assert result.kind == "user"
        assert result.project_id == "proj-123"
        assert result.user_id == "user-1"
        assert result.workspace_id == "ws-456"
        assert result.oauth_client_id == "client-1"
        assert result.ingestion_blocked is True

    async def test_a_matching_project_id_param_is_accepted(self, signer):
        _grant(signer.respx)
        result = await authenticate_public_caller(
            authorization=f"Bearer {_mint(signer.priv)}", project_id="proj-123"
        )
        assert result.project_id == "proj-123"


class TestRejections:
    async def _status(self, token, project_id=None):
        with pytest.raises(HTTPException) as e:
            await authenticate_public_caller(authorization=f"Bearer {token}", project_id=project_id)
        return e.value.status_code

    async def test_another_project_is_refused_even_if_the_user_belongs_to_it(self, signer):
        _grant(signer.respx)
        assert await self._status(_mint(signer.priv), project_id="proj-other") == 403

    async def test_wrong_audience(self, signer):
        _grant(signer.respx)
        assert await self._status(_mint(signer.priv, aud="https://elsewhere.example/mcp")) == 401

    async def test_expired(self, signer):
        _grant(signer.respx)
        assert await self._status(_mint(signer.priv, exp=int(time.time()) - 600)) == 401

    @pytest.mark.parametrize("scope", ["", "offline_access", "mcp:write", "mcp:readonly"])
    async def test_without_the_read_scope(self, signer, scope):
        _grant(signer.respx)
        assert await self._status(_mint(signer.priv, scope=scope)) == 401

    @pytest.mark.parametrize("claim", ["project_id", "client_id", "jti", "sub", "scope"])
    async def test_missing_claim(self, signer, claim):
        _grant(signer.respx)
        assert await self._status(_mint(signer.priv, drop=(claim,))) == 401

    async def test_signed_by_an_unknown_key(self, signer):
        _grant(signer.respx)
        other = Ed25519PrivateKey.generate()
        assert await self._status(_mint(other)) == 401

    async def test_oauth_disabled_when_unconfigured(self, signer, monkeypatch):
        _grant(signer.respx)
        monkeypatch.setattr(settings, "traceroot_oauth_audiences", "")
        # With nothing configured the token is not an OAuth token at all; it
        # falls through to the CLI path, which pins another issuer and refuses it.
        assert await self._status(_mint(signer.priv), project_id="proj-123") == 401

    async def test_revoked_grant(self, signer):
        signer.respx.post(GRANT_URL).mock(return_value=Response(401, json={"valid": False}))
        assert await self._status(_mint(signer.priv)) == 401

    async def test_user_removed_from_project(self, signer):
        signer.respx.post(GRANT_URL).mock(return_value=Response(403, json={}))
        assert await self._status(_mint(signer.priv)) == 403

    async def test_introspection_outage_fails_closed(self, signer):
        signer.respx.post(GRANT_URL).mock(return_value=Response(500))
        assert await self._status(_mint(signer.priv)) == 503

    async def test_grant_naming_another_project_fails_closed(self, signer):
        _grant(signer.respx, projectId="proj-999")
        assert await self._status(_mint(signer.priv)) == 503

    async def test_account_routes_refuse_it(self, signer):
        # The account and write paths pin the CLI issuer, so this token cannot
        # enumerate workspaces or reach anything built on them.
        with pytest.raises(HTTPException) as e:
            await authenticate_account_caller(authorization=f"Bearer {_mint(signer.priv)}")
        assert e.value.status_code == 401


class TestReadOnly:
    async def _stamped(self, signer, method, route_name):
        _grant(signer.respx)
        auth = await authenticate_public_caller(
            authorization=f"Bearer {_mint(signer.priv)}", project_id=None
        )
        return await authenticate_and_stamp_public_caller(_request(method, route_name), auth)

    async def test_get_is_allowed(self, signer):
        assert (await self._stamped(signer, "GET", "list_traces")).project_id == "proj-123"

    @pytest.mark.parametrize("route_name", ["run_sql", "run_widget_query"])
    async def test_read_only_posts_are_allowed(self, signer, route_name):
        assert (await self._stamped(signer, "POST", route_name)).project_id == "proj-123"

    @pytest.mark.parametrize("method", ["POST", "PUT", "PATCH", "DELETE"])
    async def test_any_other_write_is_refused(self, signer, method):
        with pytest.raises(HTTPException) as e:
            await self._stamped(signer, method, "create_alert")
        assert e.value.status_code == 403
        assert e.value.detail == "OAuth tokens are read-only"
