"""Unit tests for the public whoami endpoint (GET /api/v1/public/whoami)."""

from typing import get_args, get_type_hints

import httpx
import pytest
import respx
from fastapi.testclient import TestClient
from httpx import Response

from rest.main import app
from rest.routers.public.deps import ApiKeyScope, AuthResult, authenticate_api_key
from rest.schemas.public import WhoamiResponse
from shared.config import settings

BASE_URL = "http://localhost:3000"


def make_identity_auth(scope=None) -> AuthResult:
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
        scope=scope,
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

    def test_an_https_deployment_does_not_report_its_api_host_as_http(self, monkeypatch):
        """The scheme survives a proxy that terminates TLS somewhere else.

        Regression: a deployment reachable only over HTTPS answered this route
        with ``host`` on ``http://`` while reporting ``ui_base_url`` on
        ``https://`` — one response disagreeing with itself about its own
        deployment. The cause is that uvicorn trusts ``X-Forwarded-Proto`` only
        from ``forwarded_allow_ips`` (default ``127.0.0.1``), which a load
        balancer on another address is not, so ``request.base_url`` falls back
        to ``http``. A client that stores the reported host then writes a URL
        that redirects, or fails outright where the redirect is not followed.
        """
        monkeypatch.setattr(
            settings, "traceroot_public_ui_url", "https://staging.example.ai", raising=False
        )
        app.dependency_overrides[authenticate_api_key] = lambda: make_identity_auth("ingest")
        client = TestClient(app)
        data = client.get(
            "/api/v1/public/whoami",
            headers={"Authorization": "Bearer tr_secrettoken"},
        ).json()
        assert data["host"].startswith("https://")
        assert not data["host"].startswith("http://")

    def test_a_plain_http_deployment_is_left_alone(self, monkeypatch):
        """No spurious upgrade: a local deployment really is served over HTTP.

        The upgrade is driven by configuration rather than applied blindly, so
        a deployment whose own UI origin is HTTP keeps the scheme it was
        reached on. Without this, running against a local stack would hand the
        command-line tool an ``https`` URL nothing is listening on.
        """
        monkeypatch.setattr(
            settings, "traceroot_public_ui_url", "http://localhost:3000", raising=False
        )
        app.dependency_overrides[authenticate_api_key] = lambda: make_identity_auth("ingest")
        client = TestClient(app)
        data = client.get(
            "/api/v1/public/whoami",
            headers={"Authorization": "Bearer tr_secrettoken"},
        ).json()
        assert data["host"].startswith("http://")

    @pytest.mark.parametrize("scope", ["ingest", "admin"])
    def test_reports_the_keys_scope(self, scope):
        """A key holder can ask what their key is allowed to do."""
        app.dependency_overrides[authenticate_api_key] = lambda: make_identity_auth(scope)
        client = TestClient(app)
        resp = client.get(
            "/api/v1/public/whoami",
            headers={"Authorization": "Bearer tr_secrettoken"},
        )
        assert resp.status_code == 200
        assert resp.json()["key_scope"] == scope

    def test_a_key_predating_scoping_reports_the_scope_it_is_treated_as(self):
        """A key from before scoping existed answers with what it actually gets.

        Such a key was backfilled to ``admin`` by the migration that added the
        column, so that is what it is treated as and that is what it reports —
        not a guess, and not an omission the caller has to interpret.
        """
        app.dependency_overrides[authenticate_api_key] = lambda: make_identity_auth("admin")
        client = TestClient(app)
        data = client.get(
            "/api/v1/public/whoami",
            headers={"Authorization": "Bearer tr_secrettoken"},
        ).json()
        assert data["key_scope"] == "admin"

    def test_the_scope_is_present_even_when_the_credential_carries_none(self):
        """The field is never absent and never null, whatever reached the route.

        A credential resolved without a scope — an older control plane, which
        reports no such field — must still produce a well-formed response. It
        reports the narrow scope, which is what enforcement would decide for it,
        so the answer a holder gets and the answer a route gives cannot differ.
        """
        app.dependency_overrides[authenticate_api_key] = lambda: make_identity_auth(None)
        client = TestClient(app)
        resp = client.get(
            "/api/v1/public/whoami",
            headers={"Authorization": "Bearer tr_secrettoken"},
        )
        assert resp.status_code == 200
        assert resp.json()["key_scope"] == "ingest"

    @respx.mock
    def test_scope_survives_the_whole_authentication_path(self):
        """End to end: what the control plane reports is what whoami answers.

        The tests above override the credential, so they would still pass if the
        scope never came off the validate response. This one goes through
        ``authenticate_api_key`` for real against a mocked control plane.
        """
        respx.post(f"{BASE_URL}/api/internal/validate-api-key").mock(
            return_value=Response(
                200,
                json={
                    "valid": True,
                    "projectId": "proj-123",
                    "workspaceId": "ws-456",
                    "billingPlan": "pro",
                    "ingestionBlocked": False,
                    "scope": "admin",
                },
            )
        )
        client = TestClient(app, raise_server_exceptions=False)
        resp = client.get(
            "/api/v1/public/whoami",
            headers={"Authorization": "Bearer tr-key"},
        )
        assert resp.status_code == 200, resp.text
        assert resp.json()["key_scope"] == "admin"

    @respx.mock
    def test_an_older_control_plane_still_yields_a_well_formed_response(self):
        """A validate response with no scope field is not an error for this route.

        This is the deployment where the control plane predates the field. A
        current client must keep working against it, so the response is complete
        and the scope reads as the narrow one.
        """
        respx.post(f"{BASE_URL}/api/internal/validate-api-key").mock(
            return_value=Response(
                200,
                json={
                    "valid": True,
                    "projectId": "proj-123",
                    "workspaceId": "ws-456",
                    "billingPlan": "pro",
                    "ingestionBlocked": False,
                },
            )
        )
        client = TestClient(app, raise_server_exceptions=False)
        resp = client.get(
            "/api/v1/public/whoami",
            headers={"Authorization": "Bearer tr-key"},
        )
        assert resp.status_code == 200, resp.text
        assert resp.json()["key_scope"] == "ingest"

    def test_reporting_the_scope_needs_no_extra_permission(self):
        """No new credential and no new route: the same key, the same endpoint.

        A key reads its own scope. If this ever required more than the key that
        whoami already accepts, a holder could not ask the question the field
        exists to answer.
        """
        app.dependency_overrides[authenticate_api_key] = lambda: make_identity_auth("ingest")
        client = TestClient(app)
        resp = client.get(
            "/api/v1/public/whoami",
            headers={"Authorization": "Bearer tr_secrettoken"},
        )
        assert resp.status_code == 200
        assert resp.json()["key_scope"] == "ingest"

    def test_names_hint_and_ui_base_url_present(self):
        """whoami must surface human-readable names, the key hint, and ui_base_url."""
        app.dependency_overrides[authenticate_api_key] = lambda: make_identity_auth()
        client = TestClient(app)
        data = client.get(
            "/api/v1/public/whoami",
            headers={"Authorization": "Bearer tr_secrettoken"},
        ).json()
        for field in (
            "project_name",
            "workspace_name",
            "key_hint",
            "key_scope",
            "ui_base_url",
            "host",
        ):
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


def test_reported_scopes_are_the_auth_layers_scopes():
    """The response's scope values must be the ones the auth layer resolves.

    ``WhoamiResponse`` spells the two values out rather than importing
    ``ApiKeyScope``, to keep the schemas module from reaching into a router. That
    is only safe while the two cannot disagree, which is what this asserts.
    """
    reported = get_args(get_type_hints(WhoamiResponse)["key_scope"])
    assert reported == get_args(ApiKeyScope)
