"""Tests for access-key scope on the public API: how it is read, and how it refuses.

The control plane stores a scope on every access key and reports it from
``validate-api-key``. These tests cover the Python half: narrowing what is
reported (``parse_scope``), carrying it onto the resolved credential
(``AuthResult.scope``), and refusing a key that does not carry enough of it.

Two properties are load-bearing and each has a test that fails loudly if the
behaviour is reverted:

* **A key that predates scoping keeps working.** The column arrived with
  ``DEFAULT 'admin'`` precisely so that adding it could not narrow a live
  credential, so such a key reports ``admin`` and is refused nothing.
* **A control plane that reports no scope is not a full-access grant.** Absence
  resolves to ``ingest`` — the narrow scope — not to ``admin`` and not to a 503
  that would take ingestion down for the length of a rolling deploy.
"""

import re
from pathlib import Path

import pytest
import respx
from fastapi import Depends, FastAPI, HTTPException
from fastapi.testclient import TestClient
from httpx import Response

from rest.routers.public.deps import (
    INSUFFICIENT_SCOPE_DETAIL,
    AuthResult,
    authenticate_api_key,
    parse_scope,
    require_admin_key_scope,
    require_scope,
)

BASE_URL = "http://localhost:3000"
VALIDATE_URL = f"{BASE_URL}/api/internal/validate-api-key"

CONTROL_PLANE_AUTH = (
    Path(__file__).resolve().parents[2] / "frontend" / "ui" / "src" / "lib" / "public-auth.ts"
)


def _mock_validate(**extra):
    """Mock validate-api-key with a valid body, plus/minus the given fields."""
    body = {
        "valid": True,
        "projectId": "proj-123",
        "workspaceId": "ws-456",
        "billingPlan": "pro",
        "ingestionBlocked": False,
    }
    body.update(extra)
    return respx.post(VALIDATE_URL).mock(return_value=Response(200, json=body))


def _key_auth(scope) -> AuthResult:
    """An API-key credential carrying the given scope."""
    return AuthResult(
        project_id="proj-123",
        workspace_id="ws-456",
        billing_plan="pro",
        ingestion_blocked=False,
        kind="api_key",
        scope=scope,
    )


def _user_auth() -> AuthResult:
    """A user credential, which carries no key scope at all."""
    return AuthResult(
        kind="user",
        project_id="proj-123",
        workspace_id="ws-456",
        billing_plan="pro",
        ingestion_blocked=True,
        user_id="user-789",
        role="ADMIN",
    )


# ── parse_scope ─────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "reported,expected",
    [
        ("admin", "admin"),
        ("ingest", "ingest"),
        # Fail closed on anything this build does not recognise.
        ("Admin", "ingest"),
        ("ADMIN", "ingest"),
        ("admin ", "ingest"),
        ("owner", "ingest"),
        ("", "ingest"),
        # Non-strings, including the ones that would be truthy.
        (None, "ingest"),
        (True, "ingest"),
        (1, "ingest"),
        (["admin"], "ingest"),
        ({"scope": "admin"}, "ingest"),
    ],
)
def test_parse_scope_narrows_to_a_known_scope(reported, expected):
    assert parse_scope(reported) == expected


def test_parse_scope_mirrors_the_control_plane_rule():
    """The rule is `=== "admin"`, so only that one value widens the scope."""
    source = CONTROL_PLANE_AUTH.read_text(encoding="utf-8")
    assert 'return value === "admin" ? "admin" : "ingest";' in source


# ── AuthResult.scope ────────────────────────────────────────────────────


@respx.mock
async def test_reported_admin_scope_reaches_the_auth_result():
    _mock_validate(scope="admin")
    assert (await authenticate_api_key("Bearer tr-key")).scope == "admin"


@respx.mock
async def test_reported_ingest_scope_reaches_the_auth_result():
    _mock_validate(scope="ingest")
    assert (await authenticate_api_key("Bearer tr-key")).scope == "ingest"


@respx.mock
async def test_an_absent_scope_is_ingest_not_admin():
    """A control plane older than the field reports nothing — the narrow scope.

    Reverting the ``parse_scope`` call to ``data.get("scope")`` leaves this None,
    and ``require_scope`` then reads it as the narrow scope too — so the
    assertion that pins the direction of failure is the admin one below.
    """
    _mock_validate()
    assert (await authenticate_api_key("Bearer tr-key")).scope == "ingest"


@respx.mock
async def test_an_absent_scope_does_not_fail_the_request():
    """Absence is not malformed: the request authenticates, it does not 503.

    Every other missing field on this response is an auth-service error. A
    missing scope is not, because the narrow scope it resolves to already denies
    everything the field guards — and failing the request instead would stop
    ingestion for every key for the length of a rolling deploy.
    """
    _mock_validate()
    result = await authenticate_api_key("Bearer tr-key")
    assert result.project_id == "proj-123"
    assert result.ingestion_blocked is False


@respx.mock
@pytest.mark.parametrize("reported", ["owner", "", None, 7, ["admin"]])
async def test_an_unrecognised_scope_is_never_read_as_admin(reported):
    """A scope this build does not know must not widen into full project rights."""
    _mock_validate(scope=reported)
    assert (await authenticate_api_key("Bearer tr-key")).scope == "ingest"


@respx.mock
async def test_a_key_predating_scoping_keeps_full_access():
    """The migration backfilled existing keys to ``admin``; nothing refuses them.

    ``20260818000000_add_access_key_scope`` added the column with
    ``DEFAULT 'admin'`` so that adding it could not silently narrow a credential
    already in use. Such a key therefore reports ``admin``, and the strictest
    requirement this service can express still lets it through.
    """
    _mock_validate(scope="admin")
    result = await authenticate_api_key("Bearer tr-key")
    assert result.scope == "admin"
    assert require_scope(result, "admin") is None


def test_a_user_credential_carries_no_scope():
    """Scope is a property of a key; a signed-in member's authority is their role."""
    assert _user_auth().scope is None


# ── require_scope ───────────────────────────────────────────────────────


def test_admin_key_passes_an_admin_requirement():
    assert require_scope(_key_auth("admin"), "admin") is None


def test_ingest_key_is_refused_an_admin_requirement():
    with pytest.raises(HTTPException) as exc_info:
        require_scope(_key_auth("ingest"), "admin")
    assert exc_info.value.status_code == 403
    assert exc_info.value.detail == INSUFFICIENT_SCOPE_DETAIL


def test_a_key_with_no_reported_scope_is_refused_an_admin_requirement():
    """The fail-closed direction, asserted where it decides an outcome.

    An ``AuthResult`` whose scope never got populated — an older control plane,
    or a construction that predates the field — must be refused, not waved
    through. This is the assertion that fails if the narrowing is removed.
    """
    with pytest.raises(HTTPException) as exc_info:
        require_scope(_key_auth(None), "admin")
    assert exc_info.value.status_code == 403


@pytest.mark.parametrize("scope", ["ingest", "admin", None])
def test_every_key_passes_an_ingest_requirement(scope):
    """``ingest`` is the floor every valid key already meets."""
    assert require_scope(_key_auth(scope), "ingest") is None


@pytest.mark.parametrize("required", ["ingest", "admin"])
def test_a_user_credential_is_not_scope_checked(required):
    """A scope requirement must never refuse a signed-in project member.

    Fabricating ``ingest`` for a user instead of leaving it None would turn
    every admin-scoped route into one no human could call.
    """
    assert require_scope(_user_auth(), required) is None


def test_refusal_is_403_not_401():
    """The key is genuine, so re-authenticating cannot help — this is authorization."""
    with pytest.raises(HTTPException) as exc_info:
        require_scope(_key_auth("ingest"), "admin")
    assert exc_info.value.status_code != 401


def test_refusal_detail_matches_the_control_plane():
    """Both layers enforce; the caller must not be able to tell which refused.

    The control plane answers this exact string from ``requireApiKeyProject``.
    Changing either side alone makes the layer identifiable, so this reads the
    message out of the control plane's source and compares it.
    """
    source = CONTROL_PLANE_AUTH.read_text(encoding="utf-8")
    messages = re.findall(r'publicError\(\s*"([^"]+)",\s*403,?\s*\)', source)
    assert messages == [INSUFFICIENT_SCOPE_DETAIL], messages


def test_refusal_body_is_the_detail_shape_the_public_api_speaks():
    """``{"detail": …}`` is what the public API and its SDK clients parse.

    FastAPI renders ``HTTPException.detail`` into that shape, and the control
    plane hand-builds the same one; this asserts the rendered body rather than
    the exception, because the body is the contract.
    """
    app = FastAPI()

    @app.get("/needs-admin", dependencies=[Depends(require_admin_key_scope)])
    async def needs_admin() -> dict[str, bool]:
        return {"ok": True}

    app.dependency_overrides[authenticate_api_key] = lambda: _key_auth("ingest")
    resp = TestClient(app, raise_server_exceptions=False).get("/needs-admin")
    assert resp.status_code == 403
    assert resp.json() == {"detail": INSUFFICIENT_SCOPE_DETAIL}


# ── the route dependencies ──────────────────────────────────────────────


def _app_with(dependency, inner, auth: AuthResult) -> TestClient:
    """A throwaway app whose one route depends on ``dependency``.

    The dependency is exercised on a route of its own rather than on a
    production one because which production routes require ``admin`` — the three
    key-management gateways in ``api_keys.py``, and nothing else — is pinned by
    ``test_public_route_scopes.py``. What is under test here is the dependency's
    own contract, so the route only has to exist.
    """
    app = FastAPI()

    @app.get("/needs-admin", dependencies=[Depends(dependency)])
    async def needs_admin() -> dict[str, bool]:
        return {"ok": True}

    app.dependency_overrides[inner] = lambda: auth
    return TestClient(app, raise_server_exceptions=False)


@pytest.mark.parametrize("scope,status_code", [("admin", 200), ("ingest", 403), (None, 403)])
def test_require_admin_key_scope_gates_a_key_only_route(scope, status_code):
    client = _app_with(require_admin_key_scope, authenticate_api_key, _key_auth(scope))
    assert client.get("/needs-admin").status_code == status_code


def test_scope_dependencies_share_the_credential_they_check():
    """Composing one onto a route must not cost a second validate-api-key hop.

    Each dependency takes the same inner annotation the stamped auth takes, so
    FastAPI resolves the credential once per request and caches it. Depending on
    a differently-wrapped copy instead would double every request's round-trip to
    the control plane, which is why this asserts the inner callable by identity.
    """
    assert (
        require_admin_key_scope.__annotations__["auth"].__metadata__[0].dependency
        is authenticate_api_key
    )
