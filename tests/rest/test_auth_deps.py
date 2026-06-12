"""Unit tests for authentication dependencies.

Tests authenticate_api_key (public API auth) and get_project_access (user auth)
with mocked httpx calls.
"""

import logging

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

    @respx.mock
    async def test_valid_key_with_identity(self):
        """When validate-api-key returns names/hint, AuthResult captures them."""
        respx.post(f"{BASE_URL}/api/internal/validate-api-key").mock(
            return_value=Response(
                200,
                json={
                    "valid": True,
                    "projectId": "proj-123",
                    "projectName": "My Project",
                    "workspaceId": "ws-456",
                    "workspaceName": "My Workspace",
                    "keyName": "CI key",
                    "keyHint": "tr_ab…yz",
                    "billingPlan": "pro",
                    "ingestionBlocked": False,
                },
            )
        )
        result = await authenticate_api_key("Bearer test-api-key")
        assert result.project_name == "My Project"
        assert result.workspace_name == "My Workspace"
        assert result.key_name == "CI key"
        assert result.key_hint == "tr_ab…yz"

    @respx.mock
    async def test_valid_key_without_identity_defaults_to_none(self):
        """Identity fields are optional: absent in the response means None (no crash)."""
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
        assert result.project_name is None
        assert result.key_hint is None

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

    @respx.mock
    async def test_malformed_200_invalid_json_returns_503(self):
        """A 200 with a non-JSON body is a malformed upstream response → controlled 503."""
        respx.post(f"{BASE_URL}/api/internal/validate-api-key").mock(
            return_value=Response(200, content=b"<html>not json</html>")
        )
        with pytest.raises(HTTPException) as exc_info:
            await authenticate_api_key("Bearer test-key")
        assert exc_info.value.status_code == 503
        assert exc_info.value.detail == "Authentication service error"

    @respx.mock
    async def test_200_missing_required_fields_returns_503(self):
        """A valid-looking 200 missing required fields is malformed → controlled 503."""
        respx.post(f"{BASE_URL}/api/internal/validate-api-key").mock(
            return_value=Response(200, json={"valid": True})  # no projectId/workspaceId/billingPlan
        )
        with pytest.raises(HTTPException) as exc_info:
            await authenticate_api_key("Bearer test-key")
        assert exc_info.value.status_code == 503
        assert exc_info.value.detail == "Authentication service error"

    @respx.mock
    async def test_200_missing_ingestion_blocked_returns_503(self):
        """ingestionBlocked gates billing enforcement: a valid:true response that
        omits it is malformed → 503 (fail closed). Never silently default to "not
        blocked", which would bypass the free-plan ingestion limit.
        """
        respx.post(f"{BASE_URL}/api/internal/validate-api-key").mock(
            return_value=Response(
                200,
                json={
                    "valid": True,
                    "projectId": "proj-123",
                    "workspaceId": "ws-456",
                    "billingPlan": "free",
                    # ingestionBlocked deliberately omitted
                },
            )
        )
        with pytest.raises(HTTPException) as exc_info:
            await authenticate_api_key("Bearer test-key")
        assert exc_info.value.status_code == 503
        assert exc_info.value.detail == "Authentication service error"

    @respx.mock
    async def test_200_non_bool_ingestion_blocked_returns_503(self):
        """A non-boolean ingestionBlocked is malformed → 503; don't coerce truthiness
        (e.g. null/"false"/0 must not be read as "not blocked").
        """
        respx.post(f"{BASE_URL}/api/internal/validate-api-key").mock(
            return_value=Response(
                200,
                json={
                    "valid": True,
                    "projectId": "proj-123",
                    "workspaceId": "ws-456",
                    "billingPlan": "free",
                    "ingestionBlocked": None,
                },
            )
        )
        with pytest.raises(HTTPException) as exc_info:
            await authenticate_api_key("Bearer test-key")
        assert exc_info.value.status_code == 503
        assert exc_info.value.detail == "Authentication service error"

    @respx.mock
    async def test_token_not_logged_on_malformed_response(self, caplog):
        """The raw API token must never appear in logs, even on the error path."""
        respx.post(f"{BASE_URL}/api/internal/validate-api-key").mock(
            return_value=Response(200, content=b"oops")
        )
        with caplog.at_level(logging.DEBUG), pytest.raises(HTTPException):
            await authenticate_api_key("Bearer tr_supersecrettoken")
        assert "tr_supersecrettoken" not in caplog.text


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
