"""Unit tests for authentication dependencies.

Tests authenticate_api_key (public API auth) and get_project_access (user auth)
with mocked httpx calls.
"""

import httpx
import pytest
import respx
from fastapi import HTTPException
from httpx import Response

from rest.routers.deps import get_project_access
from rest.routers.public.traces import AuthResult, authenticate_api_key

BASE_URL = "http://localhost:3000"


# ── authenticate_api_key ────────────────────────────────────────────────


class TestAuthenticateApiKey:
    @respx.mock
    async def test_valid_key(self):
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
        result = await authenticate_api_key("Bearer test-api-key")
        assert isinstance(result, AuthResult)
        assert result.project_id == "proj-123"
        assert result.workspace_id == "ws-456"
        assert result.billing_plan == "pro"
        assert result.ingestion_blocked is False

    async def test_missing_header(self):
        with pytest.raises(HTTPException) as exc_info:
            await authenticate_api_key(None)
        assert exc_info.value.status_code == 401

    async def test_bad_format(self):
        with pytest.raises(HTTPException) as exc_info:
            await authenticate_api_key("BadFormat token123")
        assert exc_info.value.status_code == 401

    @respx.mock
    async def test_invalid_key(self):
        respx.post(f"{BASE_URL}/api/internal/validate-api-key").mock(
            return_value=Response(200, json={"valid": False, "error": "Invalid API key"})
        )
        with pytest.raises(HTTPException) as exc_info:
            await authenticate_api_key("Bearer bad-key")
        assert exc_info.value.status_code == 401

    @respx.mock
    async def test_service_down(self):
        respx.post(f"{BASE_URL}/api/internal/validate-api-key").mock(
            side_effect=httpx.ConnectError("Connection refused")
        )
        with pytest.raises(HTTPException) as exc_info:
            await authenticate_api_key("Bearer test-key")
        assert exc_info.value.status_code == 503

    @respx.mock
    async def test_auth_service_401(self):
        respx.post(f"{BASE_URL}/api/internal/validate-api-key").mock(return_value=Response(401))
        with pytest.raises(HTTPException) as exc_info:
            await authenticate_api_key("Bearer bad-key")
        assert exc_info.value.status_code == 401

    @respx.mock
    async def test_auth_service_500(self):
        respx.post(f"{BASE_URL}/api/internal/validate-api-key").mock(return_value=Response(500))
        with pytest.raises(HTTPException) as exc_info:
            await authenticate_api_key("Bearer test-key")
        assert exc_info.value.status_code == 503


# ── get_project_access ──────────────────────────────────────────────────


class TestGetProjectAccess:
    @respx.mock
    async def test_valid_access(self):
        respx.post(f"{BASE_URL}/api/internal/validate-project-access").mock(
            return_value=Response(200, json={"hasAccess": True, "role": "ADMIN"})
        )
        result = await get_project_access("proj-123", "user-456")
        assert result.project_id == "proj-123"
        assert result.user_id == "user-456"
        assert result.role == "ADMIN"

    async def test_missing_user_id(self):
        with pytest.raises(HTTPException) as exc_info:
            await get_project_access("proj-123", None)
        assert exc_info.value.status_code == 401

    @respx.mock
    async def test_forbidden(self):
        respx.post(f"{BASE_URL}/api/internal/validate-project-access").mock(
            return_value=Response(200, json={"hasAccess": False, "error": "No access"})
        )
        with pytest.raises(HTTPException) as exc_info:
            await get_project_access("proj-123", "user-456")
        assert exc_info.value.status_code == 403

    @respx.mock
    async def test_not_found(self):
        respx.post(f"{BASE_URL}/api/internal/validate-project-access").mock(
            return_value=Response(200, json={"hasAccess": False, "error": "Project not found"})
        )
        with pytest.raises(HTTPException) as exc_info:
            await get_project_access("proj-123", "user-456")
        assert exc_info.value.status_code == 404

    @respx.mock
    async def test_service_down(self):
        respx.post(f"{BASE_URL}/api/internal/validate-project-access").mock(
            side_effect=httpx.ConnectError("Connection refused")
        )
        with pytest.raises(HTTPException) as exc_info:
            await get_project_access("proj-123", "user-456")
        assert exc_info.value.status_code == 503

    @respx.mock
    async def test_auth_service_401(self):
        respx.post(f"{BASE_URL}/api/internal/validate-project-access").mock(
            return_value=Response(401)
        )
        with pytest.raises(HTTPException) as exc_info:
            await get_project_access("proj-123", "user-456")
        assert exc_info.value.status_code == 401
