"""Integration tests for the dual-credential public read auth.

These exercise the REAL ``authenticate_public_caller`` dependency through a
swapped read route (``list_traces``), mocking the internal introspection routes
with ``respx``. They complement the dependency-level tests by proving the user
credential is wired end-to-end through the routes, and that an API key still
behaves identically (same body shape, project scoping, and mismatch guard).

The API-key override-based suites in ``test_public_traces_read.py`` cover the
byte-identical key-auth response contract; here the token value matters because
the real dependency discriminates on the ``tr-`` prefix.
"""

import time
from unittest.mock import MagicMock

import jwt
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
_JWT_KID = "kid-dual-1"

USER_HEADER = {"Authorization": "Bearer user-session-token"}
KEY_HEADER = {"Authorization": "Bearer tr-some-key"}

# A validate-user-token 200 "member" body: the introspection route resolved the
# token to a project the user can read.
USER_OK_BODY = {
    "valid": True,
    "projectId": "proj-A",
    "workspaceId": "ws-1",
    "billingPlan": "enterprise",
    "role": "member",
    "userId": "u1",
}

EMPTY_LIST = {"data": [], "meta": {"page": 0, "limit": 50, "total": 0}}


def _stub_reader(monkeypatch) -> MagicMock:
    """Replace the trace reader with a mock that returns an empty page.

    Args:
        monkeypatch: pytest monkeypatch fixture (auto-reverts the patch).

    Returns:
        MagicMock: The stubbed reader, for call-arg assertions.
    """
    reader = MagicMock()
    reader.list_traces.return_value = EMPTY_LIST
    import rest.routers.public.traces_read as mod

    monkeypatch.setattr(mod, "get_trace_reader_service", lambda: reader)
    return reader


@respx.mock
def test_user_token_with_project_id_reads_like_key_path(monkeypatch):
    """A user token + ?project_id resolves via validate-user-token and reads the
    same body shape as the key path, scoped to the resolved project."""
    respx.post(f"{BASE_URL}/api/internal/validate-user-token").mock(
        return_value=Response(200, json=USER_OK_BODY)
    )
    reader = _stub_reader(monkeypatch)
    resp = TestClient(app).get("/api/v1/public/traces?project_id=proj-A", headers=USER_HEADER)
    assert resp.status_code == 200
    assert resp.json() == EMPTY_LIST
    # The read is scoped to the project resolved from the token, not a client value.
    assert reader.list_traces.call_args.kwargs["project_id"] == "proj-A"


def test_user_token_without_project_id_is_400_naming_list_projects():
    """A user credential is only meaningful scoped to a project: absent
    project_id is a 400 that points the caller at list_projects."""
    client = TestClient(app, raise_server_exceptions=False)
    resp = client.get("/api/v1/public/traces", headers=USER_HEADER)
    assert resp.status_code == 400
    assert "list_projects" in resp.json()["detail"]


@respx.mock
def test_user_token_without_access_is_403():
    """A valid token with no access to the project surfaces the validator's 403."""
    respx.post(f"{BASE_URL}/api/internal/validate-user-token").mock(
        return_value=Response(403, json={"valid": False, "hasAccess": False})
    )
    client = TestClient(app, raise_server_exceptions=False)
    resp = client.get("/api/v1/public/traces?project_id=proj-A", headers=USER_HEADER)
    assert resp.status_code == 403


@respx.mock
def test_key_with_mismatched_project_id_is_400():
    """A tr- key whose project contradicts an explicit ?project_id is a 400
    (absent-or-equal rule), exercised through the real dependency."""
    respx.post(f"{BASE_URL}/api/internal/validate-api-key").mock(
        return_value=Response(
            200,
            json={
                "valid": True,
                "projectId": "proj-A",
                "workspaceId": "ws-1",
                "billingPlan": "enterprise",
                "ingestionBlocked": False,
            },
        )
    )
    client = TestClient(app, raise_server_exceptions=False)
    resp = client.get("/api/v1/public/traces?project_id=other", headers=KEY_HEADER)
    assert resp.status_code == 400
    assert "does not match" in resp.json()["detail"]


@respx.mock
def test_key_with_matching_project_id_succeeds(monkeypatch):
    """A tr- key with a confirming ?project_id reads normally — the cross-check
    only rejects contradictions, exercised through the real dependency."""
    respx.post(f"{BASE_URL}/api/internal/validate-api-key").mock(
        return_value=Response(
            200,
            json={
                "valid": True,
                "projectId": "proj-A",
                "workspaceId": "ws-1",
                "billingPlan": "enterprise",
                "ingestionBlocked": False,
            },
        )
    )
    reader = _stub_reader(monkeypatch)
    resp = TestClient(app).get("/api/v1/public/traces?project_id=proj-A", headers=KEY_HEADER)
    assert resp.status_code == 200
    assert resp.json() == EMPTY_LIST
    assert reader.list_traces.call_args.kwargs["project_id"] == "proj-A"


def _install_jwt_signer(monkeypatch):
    """Register a mocked JWKS and point the deps cache at it; return the signer."""
    priv = Ed25519PrivateKey.generate()
    jwk = OKPAlgorithm.to_jwk(priv.public_key(), as_dict=True)
    jwk.update(kid=_JWT_KID, alg="EdDSA", use="sig")
    respx.get(JWKS_URL).mock(return_value=Response(200, json={"keys": [jwk]}))
    monkeypatch.setattr(deps, "get_jwks_cache", lambda: JwksCache(JWKS_URL))
    return priv


def _mint_jwt(priv, *, sub="u1"):
    now = int(time.time())
    return jwt.encode(
        {"sub": sub, "aud": "traceroot-api", "iss": "traceroot", "iat": now, "exp": now + 900},
        priv,
        algorithm="EdDSA",
        headers={"kid": _JWT_KID},
    )


@respx.mock
def test_cli_access_jwt_reads_like_key_path(monkeypatch):
    """A CLI access JWT + ?project_id verifies offline against the JWKS, resolves
    the project via user-project-access, and reads the same body shape as the key
    and session paths — proving the JWT branch is wired end-to-end through the
    route, not just the dependency."""
    priv = _install_jwt_signer(monkeypatch)
    respx.post(f"{BASE_URL}/api/internal/user-project-access").mock(
        return_value=Response(
            200,
            json={
                "valid": True,
                "hasAccess": True,
                "userId": "u1",
                "role": "member",
                "workspaceId": "ws-1",
                "billingPlan": "enterprise",
                "projectId": "proj-A",
            },
        )
    )
    reader = _stub_reader(monkeypatch)
    token = _mint_jwt(priv, sub="u1")
    resp = TestClient(app).get(
        "/api/v1/public/traces?project_id=proj-A",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 200
    assert resp.json() == EMPTY_LIST
    # The read is scoped to the project the JWT's user was granted, not a client value.
    assert reader.list_traces.call_args.kwargs["project_id"] == "proj-A"


def _stub_detector_reader(monkeypatch) -> MagicMock:
    """Replace the detector reader with a mock returning an empty (items, total) page.

    The route injects the reader via ``Depends(get_detector_reader_service)`` (not
    an in-body call like traces/sessions), so patch it through FastAPI's
    ``dependency_overrides`` — the conftest auto-clears these after each test.
    """
    reader = MagicMock()
    reader.list_detectors.return_value = ([], 0)
    from rest.routers.public.detectors_read import get_detector_reader_service

    app.dependency_overrides[get_detector_reader_service] = lambda: reader
    return reader


def _stub_session_reader(monkeypatch) -> MagicMock:
    """Replace the (shared) trace reader with a mock returning an empty session page."""
    reader = MagicMock()
    reader.list_sessions.return_value = {
        "data": [],
        "meta": {"page": 0, "limit": 50, "total": 0},
    }
    import rest.routers.public.sessions_read as mod

    monkeypatch.setattr(mod, "get_trace_reader_service", lambda: reader)
    return reader


@respx.mock
def test_detectors_user_token_reads_through_real_dual_auth(monkeypatch):
    """The detectors list route resolves the real DualStampedAuth dependency: a
    user token + ?project_id is introspected via validate-user-token and reads."""
    respx.post(f"{BASE_URL}/api/internal/validate-user-token").mock(
        return_value=Response(200, json=USER_OK_BODY)
    )
    reader = _stub_detector_reader(monkeypatch)
    resp = TestClient(app).get("/api/v1/public/detectors?project_id=proj-A", headers=USER_HEADER)
    assert resp.status_code == 200
    # The read is scoped to the project resolved from the token, not a client value.
    assert reader.list_detectors.call_args.kwargs["project_id"] == "proj-A"


@respx.mock
def test_detectors_user_token_without_access_is_403(monkeypatch):
    """A valid token with no access to the project surfaces the validator's 403,
    proving auth runs before the reader (which is never consulted)."""
    respx.post(f"{BASE_URL}/api/internal/validate-user-token").mock(
        return_value=Response(403, json={"valid": False, "hasAccess": False})
    )
    reader = _stub_detector_reader(monkeypatch)
    client = TestClient(app, raise_server_exceptions=False)
    resp = client.get("/api/v1/public/detectors?project_id=proj-A", headers=USER_HEADER)
    assert resp.status_code == 403
    assert reader.list_detectors.call_count == 0


@respx.mock
def test_sessions_user_token_reads_through_real_dual_auth(monkeypatch):
    """Same real-dependency wiring for the sessions list route."""
    respx.post(f"{BASE_URL}/api/internal/validate-user-token").mock(
        return_value=Response(200, json=USER_OK_BODY)
    )
    reader = _stub_session_reader(monkeypatch)
    resp = TestClient(app).get("/api/v1/public/sessions?project_id=proj-A", headers=USER_HEADER)
    assert resp.status_code == 200
    assert reader.list_sessions.call_args.kwargs["project_id"] == "proj-A"


@respx.mock
def test_sessions_user_token_without_access_is_403(monkeypatch):
    respx.post(f"{BASE_URL}/api/internal/validate-user-token").mock(
        return_value=Response(403, json={"valid": False, "hasAccess": False})
    )
    reader = _stub_session_reader(monkeypatch)
    client = TestClient(app, raise_server_exceptions=False)
    resp = client.get("/api/v1/public/sessions?project_id=proj-A", headers=USER_HEADER)
    assert resp.status_code == 403
    assert reader.list_sessions.call_count == 0
