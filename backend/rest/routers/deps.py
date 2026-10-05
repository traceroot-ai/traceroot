"""FastAPI dependencies for authentication (via Next.js internal API)."""

import logging
from typing import Annotated

import httpx
from fastapi import Cookie, Depends, Header, HTTPException, Request, status

from rest.rate_limit import (
    clear_request_rate_limit_exempt,
    mark_request_rate_limit_exempt,
    set_rate_limit_identity,
)
from rest.routers.internal.auth import has_internal_secret
from shared.config import settings
from shared.enums import MemberRole

logger = logging.getLogger(__name__)


class ProjectAccessInfo:
    """Information about user's access to a project."""

    def __init__(
        self,
        project_id: str,
        user_id: str,
        role: str,
        workspace_id: str = "",
        billing_plan: str = "free",
    ):
        self.project_id = project_id
        self.user_id = user_id
        self.role = role
        # Resolved for rate limiting (keyed per workspace, tiered by plan).
        self.workspace_id = workspace_id
        self.billing_plan = billing_plan


async def get_project_access(
    project_id: str,
    x_user_id: Annotated[str | None, Header()] = None,
    x_internal_secret: Annotated[str | None, Header()] = None,
    session_cookie: Annotated[str | None, Cookie(alias="better-auth.session_token")] = None,
    secure_session_cookie: Annotated[
        str | None, Cookie(alias="__Secure-better-auth.session_token")
    ] = None,
) -> ProjectAccessInfo:
    """
    Validate user has access to a project via Next.js internal API.

    Auth modes:
    - Signed browser session cookie, resolved by the UI. A caller-supplied
      x-user-id is never proof of identity. This also enforces support expiry.
    - X-Internal-Secret: Shared secret — for trusted server-to-server calls
      (e.g. the agent service running a system-initiated RCA session that has no
      associated user). Bypasses the Next.js per-user access check; the agent
      service is itself trusted to scope access correctly.

    Raises 401 if neither auth mode succeeds, 403 if no access, 404 if project
    not found.
    """
    # Establish a clean per-request exemption baseline before deciding below
    # (defense-in-depth against any stale ContextVar value).
    clear_request_rate_limit_exempt()

    # System bypass: agent service / worker calling on behalf of the system.
    # has_internal_secret() owns the comparison (constant time, a blank secret
    # never matching) so this route and the internal router cannot drift apart
    # on what counts as internal traffic.
    if has_internal_secret(x_internal_secret):
        # Trusted internal traffic is not rate limited (system-controlled volume)
        # and exempt from retention gating (enterprise-equivalent access).
        mark_request_rate_limit_exempt()
        return ProjectAccessInfo(
            project_id=project_id,
            user_id=x_user_id or "system",
            role=MemberRole.ADMIN,
            billing_plan="enterprise",
        )

    if not (session_cookie or secure_session_cookie):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Browser session required",
        )

    # Validate access via Next.js internal API
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.post(
                f"{settings.traceroot_ui_url}/api/internal/validate-project-access",
                json={"browserSession": True, "projectId": project_id},
                headers={
                    "X-Internal-Secret": settings.internal_api_secret,
                    "Cookie": (
                        f"__Secure-better-auth.session_token={secure_session_cookie}"
                        if secure_session_cookie
                        else f"better-auth.session_token={session_cookie}"
                    ),
                },
            )
    except httpx.RequestError as e:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=f"Authentication service unavailable: {e}",
        ) from e

    if response.status_code == 401:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Unauthorized",
        )

    if response.status_code != 200:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Authentication service error",
        )

    data = response.json()

    if not data.get("hasAccess"):
        error = data.get("error", "No access to this project")
        status_code = (
            status.HTTP_404_NOT_FOUND if "not found" in error.lower() else status.HTTP_403_FORBIDDEN
        )
        raise HTTPException(status_code=status_code, detail=error)

    # workspaceId is required: it keys the per-workspace rate limiter, so a
    # missing or empty one would silently collapse tenants into a shared bucket.
    # A hasAccess:true response without a usable workspaceId is malformed -> 503
    # (mirrors the ingest auth path). billingPlan stays optional because its
    # absent default ("free") is the most restrictive tier -- a safe downgrade,
    # not an isolation risk.
    workspace_id = data.get("workspaceId")
    if not workspace_id or not data.get("userId"):
        logger.error("validate-project-access returned hasAccess without a usable workspaceId")
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Authentication service error",
        )

    return ProjectAccessInfo(
        project_id=project_id,
        user_id=data["userId"],
        role=data.get("role", MemberRole.VIEWER),
        workspace_id=workspace_id,
        billing_plan=data.get("billingPlan", "free"),
    )


ProjectAccess = Annotated[ProjectAccessInfo, Depends(get_project_access)]


async def get_rate_limited_project_access(
    request: Request, access: ProjectAccess
) -> ProjectAccessInfo:
    """``ProjectAccess`` that also stamps the rate-limit identity on the request.

    Used by dashboard read endpoints so the limiter can key the shared read
    bucket by workspace and resolve the plan tier. The internal-secret bypass is
    applied inside ``get_project_access`` (it marks the request exempt), so this
    wrapper only needs to forward the resolved workspace/plan.
    """
    set_rate_limit_identity(request, access.workspace_id, access.billing_plan)
    return access


RateLimitedProjectAccess = Annotated[ProjectAccessInfo, Depends(get_rate_limited_project_access)]
