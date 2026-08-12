"""Unit tests for authentication dependencies.

Tests authenticate_api_key (public API auth) and get_project_access (user auth)
with mocked httpx calls.
"""

import json
import logging

import httpx
import pytest
import respx
from fastapi import HTTPException, Request
from httpx import Response

from rest.rate_limit import (
    is_request_rate_limit_exempt,
    mark_request_rate_limit_exempt,
)
from rest.routers.deps import get_project_access
from rest.routers.public.deps import (
    authenticate_account_caller,
    authenticate_and_stamp_account_caller,
    authenticate_and_stamp_public_caller,
    authenticate_public_caller,
    authenticate_user_token,
)
from rest.routers.public.traces import AuthResult, authenticate_api_key
from shared.config import normalize_plan

BASE_URL = "http://localhost:3000"


def _mock_valid_key(project_id: str = "proj-123"):
    """Mock validate-api-key returning a valid member key for ``project_id``."""
    return respx.post(f"{BASE_URL}/api/internal/validate-api-key").mock(
        return_value=Response(
            200,
            json={
                "valid": True,
                "projectId": project_id,
                "workspaceId": "ws-456",
                "billingPlan": "pro",
                "ingestionBlocked": False,
            },
        )
    )


def _mock_valid_user_token(project_id: str = "proj-123"):
    """Mock validate-user-token returning the project-member 200 shape."""
    return respx.post(f"{BASE_URL}/api/internal/validate-user-token").mock(
        return_value=Response(
            200,
            json={
                "valid": True,
                "userId": "user-789",
                "role": "ADMIN",
                "workspaceId": "ws-456",
                "billingPlan": "pro",
                "projectId": project_id,
            },
        )
    )


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
    async def test_200_empty_workspace_id_returns_503(self):
        """An empty (not just absent) workspaceId would collapse tenants into one
        shared ingest bucket, so a valid:true response with workspaceId="" is
        malformed → 503 (parity with the dashboard-read auth path).
        """
        respx.post(f"{BASE_URL}/api/internal/validate-api-key").mock(
            return_value=Response(
                200,
                json={
                    "valid": True,
                    "projectId": "proj-123",
                    "workspaceId": "",
                    "billingPlan": "free",
                    "ingestionBlocked": False,
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
            return_value=Response(
                200,
                json={"hasAccess": True, "role": "ADMIN", "workspaceId": "ws-456"},
            )
        )
        result = await get_project_access("proj-123", "user-456")
        assert result.project_id == "proj-123"
        assert result.user_id == "user-456"
        assert result.role == "ADMIN"
        assert result.workspace_id == "ws-456"

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

    @respx.mock
    async def test_200_missing_workspace_id_returns_503(self):
        """hasAccess:true without a workspaceId is malformed: the workspace keys
        the per-workspace rate limiter, so a missing one must fail loudly (503)
        rather than silently collapse tenants into a shared bucket.
        """
        respx.post(f"{BASE_URL}/api/internal/validate-project-access").mock(
            return_value=Response(200, json={"hasAccess": True, "role": "ADMIN"})
        )
        with pytest.raises(HTTPException) as exc_info:
            await get_project_access("proj-123", "user-456")
        assert exc_info.value.status_code == 503
        assert exc_info.value.detail == "Authentication service error"


# ── authenticate_user_token ─────────────────────────────────────────────


class TestAuthenticateUserToken:
    @respx.mock
    async def test_valid_member_token(self):
        _mock_valid_user_token()
        result = await authenticate_user_token("sess-token-abc", "proj-123")
        assert result.kind == "user"
        assert result.project_id == "proj-123"
        assert result.workspace_id == "ws-456"
        assert result.billing_plan == "pro"
        assert result.role == "ADMIN"
        assert result.user_id == "user-789"
        # A user session token must never be usable to ingest.
        assert result.ingestion_blocked is True

    @respx.mock
    async def test_401_returns_401(self):
        respx.post(f"{BASE_URL}/api/internal/validate-user-token").mock(
            return_value=Response(401, json={"valid": False, "error": "invalid or expired token"})
        )
        with pytest.raises(HTTPException) as exc_info:
            await authenticate_user_token("bad-token", "proj-123")
        assert exc_info.value.status_code == 401

    @respx.mock
    async def test_403_no_access_returns_403(self):
        respx.post(f"{BASE_URL}/api/internal/validate-user-token").mock(
            return_value=Response(403, json={"valid": True, "hasAccess": False})
        )
        with pytest.raises(HTTPException) as exc_info:
            await authenticate_user_token("sess-token", "proj-999")
        assert exc_info.value.status_code == 403
        assert "proj-999" in exc_info.value.detail

    @respx.mock
    async def test_service_down_returns_503(self):
        respx.post(f"{BASE_URL}/api/internal/validate-user-token").mock(
            side_effect=httpx.ConnectError("Connection refused")
        )
        with pytest.raises(HTTPException) as exc_info:
            await authenticate_user_token("sess-token", "proj-123")
        assert exc_info.value.status_code == 503

    @respx.mock
    async def test_unexpected_status_returns_503(self):
        respx.post(f"{BASE_URL}/api/internal/validate-user-token").mock(return_value=Response(500))
        with pytest.raises(HTTPException) as exc_info:
            await authenticate_user_token("sess-token", "proj-123")
        assert exc_info.value.status_code == 503

    @respx.mock
    async def test_malformed_json_returns_503(self):
        respx.post(f"{BASE_URL}/api/internal/validate-user-token").mock(
            return_value=Response(200, content=b"<html>not json</html>")
        )
        with pytest.raises(HTTPException) as exc_info:
            await authenticate_user_token("sess-token", "proj-123")
        assert exc_info.value.status_code == 503
        assert exc_info.value.detail == "Authentication service error"

    @respx.mock
    async def test_200_missing_required_fields_returns_503(self):
        respx.post(f"{BASE_URL}/api/internal/validate-user-token").mock(
            return_value=Response(200, json={"valid": True, "userId": "user-789"})
        )
        with pytest.raises(HTTPException) as exc_info:
            await authenticate_user_token("sess-token", "proj-123")
        assert exc_info.value.status_code == 503
        assert exc_info.value.detail == "Authentication service error"

    @respx.mock
    async def test_200_non_dict_body_returns_503(self):
        """A 200 whose JSON body is a non-object (array/string) is malformed → 503."""
        respx.post(f"{BASE_URL}/api/internal/validate-user-token").mock(
            return_value=Response(200, json=["not", "an", "object"])
        )
        with pytest.raises(HTTPException) as exc_info:
            await authenticate_user_token("sess-token", "proj-123")
        assert exc_info.value.status_code == 503
        assert exc_info.value.detail == "Authentication service error"

    @respx.mock
    async def test_200_valid_false_returns_401(self):
        respx.post(f"{BASE_URL}/api/internal/validate-user-token").mock(
            return_value=Response(200, json={"valid": False, "error": "nope"})
        )
        with pytest.raises(HTTPException) as exc_info:
            await authenticate_user_token("sess-token", "proj-123")
        assert exc_info.value.status_code == 401

    @respx.mock
    async def test_200_empty_workspace_id_returns_503(self):
        respx.post(f"{BASE_URL}/api/internal/validate-user-token").mock(
            return_value=Response(
                200,
                json={
                    "valid": True,
                    "userId": "user-789",
                    "role": "ADMIN",
                    "workspaceId": "",
                    "billingPlan": "pro",
                    "projectId": "proj-123",
                },
            )
        )
        with pytest.raises(HTTPException) as exc_info:
            await authenticate_user_token("sess-token", "proj-123")
        assert exc_info.value.status_code == 503
        assert exc_info.value.detail == "Authentication service error"

    @respx.mock
    async def test_token_not_logged_on_malformed_response(self, caplog):
        """The raw session token must never appear in logs, even on the error path."""
        respx.post(f"{BASE_URL}/api/internal/validate-user-token").mock(
            return_value=Response(200, content=b"oops")
        )
        with caplog.at_level(logging.DEBUG), pytest.raises(HTTPException):
            await authenticate_user_token("supersecretsessiontoken", "proj-123")
        assert "supersecretsessiontoken" not in caplog.text


# ── authenticate_public_caller (unified dependency) ──────────────────────


class TestAuthenticatePublicCaller:
    @respx.mock
    async def test_tr_token_routes_to_key_validator(self):
        """A tr- token hits validate-api-key and never validate-user-token."""
        _mock_valid_key()
        user_route = respx.post(f"{BASE_URL}/api/internal/validate-user-token").mock(
            return_value=Response(200, json={"valid": True})
        )
        result = await authenticate_public_caller("Bearer tr-abc123", project_id=None)
        assert result.kind == "api_key"
        assert result.project_id == "proj-123"
        assert user_route.call_count == 0

    @respx.mock
    async def test_non_tr_token_with_project_routes_to_user_validator(self):
        _mock_valid_user_token()
        result = await authenticate_public_caller("Bearer sess-token-abc", project_id="proj-123")
        assert result.kind == "user"
        assert result.role == "ADMIN"
        assert result.workspace_id == "ws-456"
        assert result.billing_plan == "pro"
        assert result.user_id == "user-789"
        assert result.ingestion_blocked is True

    async def test_non_tr_token_without_project_returns_400(self):
        with pytest.raises(HTTPException) as exc_info:
            await authenticate_public_caller("Bearer sess-token-abc", project_id=None)
        assert exc_info.value.status_code == 400
        assert "list_projects" in exc_info.value.detail

    @respx.mock
    async def test_key_with_matching_project_ok(self):
        _mock_valid_key("proj-123")
        result = await authenticate_public_caller("Bearer tr-abc123", project_id="proj-123")
        assert result.kind == "api_key"
        assert result.project_id == "proj-123"

    @respx.mock
    async def test_key_with_mismatched_project_returns_400(self):
        _mock_valid_key("proj-123")
        with pytest.raises(HTTPException) as exc_info:
            await authenticate_public_caller("Bearer tr-abc123", project_id="proj-999")
        assert exc_info.value.status_code == 400
        assert "does not match" in exc_info.value.detail

    @respx.mock
    async def test_user_token_403_hasaccess_false(self):
        respx.post(f"{BASE_URL}/api/internal/validate-user-token").mock(
            return_value=Response(403, json={"valid": True, "hasAccess": False})
        )
        with pytest.raises(HTTPException) as exc_info:
            await authenticate_public_caller("Bearer sess-token", project_id="proj-123")
        assert exc_info.value.status_code == 403

    @respx.mock
    async def test_user_token_401(self):
        respx.post(f"{BASE_URL}/api/internal/validate-user-token").mock(
            return_value=Response(401, json={"valid": False, "error": "invalid"})
        )
        with pytest.raises(HTTPException) as exc_info:
            await authenticate_public_caller("Bearer sess-token", project_id="proj-123")
        assert exc_info.value.status_code == 401

    @respx.mock
    async def test_user_path_network_error_returns_503(self):
        respx.post(f"{BASE_URL}/api/internal/validate-user-token").mock(
            side_effect=httpx.ConnectError("Connection refused")
        )
        with pytest.raises(HTTPException) as exc_info:
            await authenticate_public_caller("Bearer sess-token", project_id="proj-123")
        assert exc_info.value.status_code == 503

    @respx.mock
    async def test_tr_token_never_reaches_user_validator_even_with_project(self):
        """Discrimination safety: a tr- value routes to the key validator even
        when a project_id is passed — it must never hit validate-user-token.
        """
        _mock_valid_key("proj-123")
        user_route = respx.post(f"{BASE_URL}/api/internal/validate-user-token").mock(
            return_value=Response(200, json={"valid": True})
        )
        result = await authenticate_public_caller("Bearer tr-abc123", project_id="proj-123")
        assert result.kind == "api_key"
        assert user_route.call_count == 0

    async def test_missing_header_returns_401(self):
        with pytest.raises(HTTPException) as exc_info:
            await authenticate_public_caller(None)
        assert exc_info.value.status_code == 401

    async def test_bad_format_returns_401(self):
        with pytest.raises(HTTPException) as exc_info:
            await authenticate_public_caller("BadFormat token123")
        assert exc_info.value.status_code == 401

    async def test_empty_token_returns_401(self):
        """`Bearer ` with an empty token is a malformed credential → 401, not a 503."""
        with pytest.raises(HTTPException) as exc_info:
            await authenticate_public_caller("Bearer ")
        assert exc_info.value.status_code == 401

    @respx.mock
    async def test_uppercase_prefix_routes_to_key_validator(self):
        """A `TR-` (uppercase) value is key-shaped: route to the key validator,
        where it is hashed, and never POST it unhashed to validate-user-token.
        """
        _mock_valid_key()
        user_route = respx.post(f"{BASE_URL}/api/internal/validate-user-token").mock(
            return_value=Response(200, json={"valid": True})
        )
        result = await authenticate_public_caller("Bearer TR-abc123", project_id="proj-123")
        assert result.kind == "api_key"
        assert user_route.call_count == 0

    @respx.mock
    async def test_leading_space_prefix_routes_to_key_validator(self):
        """A stray-space `Bearer  tr-…` (token " tr-…") is still key-shaped and
        must route to the key validator, never to validate-user-token.
        """
        _mock_valid_key()
        user_route = respx.post(f"{BASE_URL}/api/internal/validate-user-token").mock(
            return_value=Response(200, json={"valid": True})
        )
        result = await authenticate_public_caller("Bearer  tr-abc123", project_id="proj-123")
        assert result.kind == "api_key"
        assert user_route.call_count == 0


# ── authenticate_and_stamp_public_caller (stamping wrapper) ──────────────


class TestAuthenticateAndStampPublicCaller:
    @staticmethod
    def _bare_request() -> Request:
        return Request({"type": "http", "headers": [], "state": {}})

    async def test_key_result_clears_exempt_and_stamps_identity(self):
        """A KEY AuthResult clears the exempt flag and stamps workspace+plan."""
        # Poison the exempt flag first so we prove the wrapper clears it.
        mark_request_rate_limit_exempt()
        request = self._bare_request()
        auth = AuthResult(
            kind="api_key",
            project_id="proj-123",
            workspace_id="ws-456",
            billing_plan="pro",
            ingestion_blocked=False,
        )
        result = await authenticate_and_stamp_public_caller(request, auth)
        assert result is auth
        assert is_request_rate_limit_exempt() is False
        assert request.state.rl_workspace_id == "ws-456"
        assert request.state.rl_billing_plan == normalize_plan("pro")

    async def test_user_result_clears_exempt_and_stamps_identity(self):
        """A USER AuthResult (project-scoped) stamps the same identity fields."""
        mark_request_rate_limit_exempt()
        request = self._bare_request()
        auth = AuthResult(
            kind="user",
            project_id="proj-123",
            workspace_id="ws-456",
            billing_plan="pro",
            ingestion_blocked=True,
            role="ADMIN",
            user_id="user-789",
        )
        result = await authenticate_and_stamp_public_caller(request, auth)
        assert result is auth
        assert is_request_rate_limit_exempt() is False
        assert request.state.rl_workspace_id == "ws-456"
        assert request.state.rl_billing_plan == normalize_plan("pro")


# ── authenticate_account_caller (account-scope, user-only) ───────────────


def _mock_valid_account_token(user_id: str = "user-789"):
    """Mock validate-user-token returning the account-scope 200 shape (no project)."""
    return respx.post(f"{BASE_URL}/api/internal/validate-user-token").mock(
        return_value=Response(
            200, json={"valid": True, "userId": user_id, "email": "u@example.com"}
        )
    )


class TestAuthenticateAccountCaller:
    @respx.mock
    async def test_valid_user_token_returns_account_result(self):
        route = _mock_valid_account_token()
        result = await authenticate_account_caller("Bearer sess-token-abc")
        assert result.kind == "user"
        assert result.user_id == "user-789"
        # Account scope has no single project/workspace.
        assert result.project_id == ""
        assert result.workspace_id == ""
        assert result.billing_plan == "free"
        assert result.ingestion_blocked is True
        # The account introspection is called WITHOUT a projectId.
        sent = json.loads(route.calls.last.request.content)
        assert "projectId" not in sent

    @respx.mock
    async def test_api_key_rejected_with_403(self):
        """A tr- (API key) value is project-scoped and cannot enumerate an account."""
        user_route = respx.post(f"{BASE_URL}/api/internal/validate-user-token").mock(
            return_value=Response(200, json={"valid": True, "userId": "u"})
        )
        with pytest.raises(HTTPException) as exc_info:
            await authenticate_account_caller("Bearer tr-abc123")
        assert exc_info.value.status_code == 403
        assert "user login" in exc_info.value.detail
        # It must never reach the token validator.
        assert user_route.call_count == 0

    @respx.mock
    async def test_uppercase_key_prefix_rejected_with_403(self):
        with pytest.raises(HTTPException) as exc_info:
            await authenticate_account_caller("Bearer TR-abc123")
        assert exc_info.value.status_code == 403

    async def test_missing_header_returns_401(self):
        with pytest.raises(HTTPException) as exc_info:
            await authenticate_account_caller(None)
        assert exc_info.value.status_code == 401

    async def test_bad_format_returns_401(self):
        with pytest.raises(HTTPException) as exc_info:
            await authenticate_account_caller("BadFormat token123")
        assert exc_info.value.status_code == 401

    async def test_empty_token_returns_401(self):
        with pytest.raises(HTTPException) as exc_info:
            await authenticate_account_caller("Bearer ")
        assert exc_info.value.status_code == 401

    @respx.mock
    async def test_invalid_token_401_returns_401(self):
        respx.post(f"{BASE_URL}/api/internal/validate-user-token").mock(
            return_value=Response(401, json={"valid": False, "error": "invalid or expired token"})
        )
        with pytest.raises(HTTPException) as exc_info:
            await authenticate_account_caller("Bearer bad-token")
        assert exc_info.value.status_code == 401

    @respx.mock
    async def test_valid_false_returns_401(self):
        respx.post(f"{BASE_URL}/api/internal/validate-user-token").mock(
            return_value=Response(200, json={"valid": False, "error": "nope"})
        )
        with pytest.raises(HTTPException) as exc_info:
            await authenticate_account_caller("Bearer sess-token")
        assert exc_info.value.status_code == 401

    @respx.mock
    async def test_network_error_returns_503(self):
        respx.post(f"{BASE_URL}/api/internal/validate-user-token").mock(
            side_effect=httpx.ConnectError("Connection refused")
        )
        with pytest.raises(HTTPException) as exc_info:
            await authenticate_account_caller("Bearer sess-token")
        assert exc_info.value.status_code == 503

    @respx.mock
    async def test_unexpected_status_returns_503(self):
        respx.post(f"{BASE_URL}/api/internal/validate-user-token").mock(return_value=Response(500))
        with pytest.raises(HTTPException) as exc_info:
            await authenticate_account_caller("Bearer sess-token")
        assert exc_info.value.status_code == 503

    @respx.mock
    async def test_malformed_json_returns_503(self):
        respx.post(f"{BASE_URL}/api/internal/validate-user-token").mock(
            return_value=Response(200, content=b"<html>not json</html>")
        )
        with pytest.raises(HTTPException) as exc_info:
            await authenticate_account_caller("Bearer sess-token")
        assert exc_info.value.status_code == 503
        assert exc_info.value.detail == "Authentication service error"

    @respx.mock
    async def test_200_missing_user_id_returns_503(self):
        """A valid:true account response without userId is malformed → 503 (fail closed)."""
        respx.post(f"{BASE_URL}/api/internal/validate-user-token").mock(
            return_value=Response(200, json={"valid": True})
        )
        with pytest.raises(HTTPException) as exc_info:
            await authenticate_account_caller("Bearer sess-token")
        assert exc_info.value.status_code == 503
        assert exc_info.value.detail == "Authentication service error"

    @respx.mock
    async def test_token_not_logged_on_malformed_response(self, caplog):
        respx.post(f"{BASE_URL}/api/internal/validate-user-token").mock(
            return_value=Response(200, content=b"oops")
        )
        with caplog.at_level(logging.DEBUG), pytest.raises(HTTPException):
            await authenticate_account_caller("Bearer supersecretsessiontoken")
        assert "supersecretsessiontoken" not in caplog.text


class TestAuthenticateAndStampAccountCaller:
    @staticmethod
    def _bare_request() -> Request:
        return Request({"type": "http", "headers": [], "state": {}})

    async def test_stamps_per_user_identity_and_clears_exempt(self):
        """Account ops have no workspace: the bucket is keyed per user_id."""
        mark_request_rate_limit_exempt()
        request = self._bare_request()
        auth = AuthResult(
            kind="user",
            project_id="",
            workspace_id="",
            billing_plan="free",
            ingestion_blocked=True,
            user_id="user-789",
        )
        result = await authenticate_and_stamp_account_caller(request, auth)
        assert result is auth
        assert is_request_rate_limit_exempt() is False
        # user_id occupies the workspace slot so the bucket is per-user.
        assert request.state.rl_workspace_id == "user-789"
        assert request.state.rl_billing_plan == normalize_plan("free")
