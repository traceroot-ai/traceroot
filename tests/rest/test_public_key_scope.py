"""Tests for access-key scope on the public API: how it is read.

The control plane stores a scope on every access key and reports it from
``validate-api-key``. These tests cover the Python half: narrowing what is
reported (``parse_scope``) and carrying it onto the resolved credential
(``AuthResult.scope``).

Two properties are load-bearing and each has a test that fails loudly if the
behaviour is reverted:

* **A key that predates scoping keeps working.** The column arrived with
  ``DEFAULT 'admin'`` precisely so that adding it could not narrow a live
  credential, so such a key reports the wide scope rather than being narrowed.
* **A control plane that reports no scope is not a full-access grant.** Absence
  resolves to ``ingest`` — the narrow scope — not to ``admin`` and not to a 503
  that would take ingestion down for the length of a rolling deploy.
"""

from pathlib import Path

import pytest
import respx
from httpx import Response

from rest.routers.public.deps import (
    AuthResult,
    authenticate_api_key,
    parse_scope,
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
    already in use. Such a key therefore reports ``admin`` — the wide scope — and
    is narrowed to nothing.
    """
    _mock_validate(scope="admin")
    assert (await authenticate_api_key("Bearer tr-key")).scope == "admin"


def test_a_user_credential_carries_no_scope():
    """Scope is a property of a key; a signed-in member's authority is their role."""
    assert _user_auth().scope is None
