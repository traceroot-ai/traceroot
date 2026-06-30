"""Unit tests for the public whoami endpoint (GET /api/v1/public/whoami)."""

import httpx
import respx
from fastapi.testclient import TestClient
from httpx import Response

from rest.main import app
from rest.routers.public.deps import AuthResult, authenticate_api_key

BASE_URL = "http://localhost:3000"


def make_identity_auth() -> AuthResult:
    """An AuthResult carrying the resolved identity fields whoami surfaces."""
    return AuthResult(
        project_id="proj-123",
        workspace_id="ws-456",
        billing_plan="pro",
        ingestion_blocked=False,
        project_name="My Project",
        workspace_name="My Workspace",
        key_name="CI key",
        key_hint="tr_ab…yz",
    )


class TestWhoami:
    def test_valid_key_returns_identity(self):
        """A valid key resolves to project/workspace identity + hosts."""
        app.dependency_overrides[authenticate_api_key] = lambda: make_identity_auth()
        client = TestClient(app)
        resp = client.get(
            "/api/v1/public/whoami",
            headers={"Authorization": "Bearer tr_secrettoken"},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["project_id"] == "proj-123"
        assert data["project_name"] == "My Project"
        assert data["workspace_id"] == "ws-456"
        assert data["workspace_name"] == "My Workspace"
        assert data["key_name"] == "CI key"
        assert data["key_hint"] == "tr_ab…yz"

    def test_names_hint_and_ui_base_url_present(self):
        """whoami must surface human-readable names, the key hint, and ui_base_url."""
        app.dependency_overrides[authenticate_api_key] = lambda: make_identity_auth()
        client = TestClient(app)
        data = client.get(
            "/api/v1/public/whoami",
            headers={"Authorization": "Bearer tr_secrettoken"},
        ).json()
        for field in ("project_name", "workspace_name", "key_hint", "ui_base_url", "host"):
            assert field in data
        assert data["ui_base_url"]  # non-empty

    def test_ui_base_url_uses_public_setting_not_internal(self, monkeypatch):
        """ui_base_url must come from the host-usable public UI URL, never the
        internal backend-to-web URL (which can be a Docker service host)."""
        from shared.config import settings

        monkeypatch.setattr(settings, "traceroot_ui_url", "http://web:3000")
        monkeypatch.setattr(settings, "traceroot_public_ui_url", "http://localhost:3000")
        app.dependency_overrides[authenticate_api_key] = lambda: make_identity_auth()
        client = TestClient(app)
        data = client.get(
            "/api/v1/public/whoami",
            headers={"Authorization": "Bearer tr_secrettoken"},
        ).json()
        assert data["ui_base_url"] == "http://localhost:3000"
        assert "web:3000" not in data["ui_base_url"]

    def test_does_not_return_full_token(self):
        """The full API token must never appear in the response."""
        app.dependency_overrides[authenticate_api_key] = lambda: make_identity_auth()
        client = TestClient(app)
        resp = client.get(
            "/api/v1/public/whoami",
            headers={"Authorization": "Bearer tr_secrettoken"},
        )
        assert resp.status_code == 200
        body = resp.text
        assert "tr_secrettoken" not in body
        assert "Bearer" not in body

    def test_missing_auth_header_returns_401(self):
        """No Authorization header is rejected at the HTTP layer before any auth call."""
        client = TestClient(app, raise_server_exceptions=False)
        resp = client.get("/api/v1/public/whoami")
        assert resp.status_code == 401

    @respx.mock
    def test_invalid_key_returns_401(self):
        """An invalid key (validate-api-key says invalid) yields 401."""
        respx.post(f"{BASE_URL}/api/internal/validate-api-key").mock(
            return_value=Response(200, json={"valid": False, "error": "Invalid API key"})
        )
        client = TestClient(app, raise_server_exceptions=False)
        resp = client.get(
            "/api/v1/public/whoami",
            headers={"Authorization": "Bearer bad-key"},
        )
        assert resp.status_code == 401

    @respx.mock
    def test_auth_service_unavailable_returns_503(self):
        """If the auth service is unreachable, whoami returns 503."""
        respx.post(f"{BASE_URL}/api/internal/validate-api-key").mock(
            side_effect=httpx.ConnectError("Connection refused")
        )
        client = TestClient(app, raise_server_exceptions=False)
        resp = client.get(
            "/api/v1/public/whoami",
            headers={"Authorization": "Bearer some-key"},
        )
        assert resp.status_code == 503


def test_whoami_route_is_registered_with_the_limiter():
    """whoami shares the per-workspace `read` budget — it must be wired in.

    Importing ``rest.main`` registers the decorated endpoint on the module-level
    limiter regardless of whether enforcement is enabled in this env.
    """
    from rest.rate_limit import limiter

    assert "rest.routers.public.whoami.whoami" in limiter._dynamic_route_limits


def test_whoami_success_returns_200_with_headers_when_limiter_enabled(monkeypatch):
    """With the limiter enabled (cloud), a successful whoami must still 200 and
    carry X-RateLimit-* headers — i.e. the route declares the ``response`` param
    slowapi needs for header injection (missing it 500s every call).
    """
    import rest.rate_limit as rate_limit
    from rest.routers.public.deps import authenticate_api_key

    monkeypatch.setattr(rate_limit.limiter, "enabled", True)
    app.dependency_overrides[authenticate_api_key] = make_identity_auth
    try:
        client = TestClient(app, raise_server_exceptions=False)
        resp = client.get("/api/v1/public/whoami", headers={"Authorization": "Bearer x"})
        assert resp.status_code == 200, resp.text
        assert "X-RateLimit-Limit" in resp.headers
    finally:
        app.dependency_overrides.clear()
