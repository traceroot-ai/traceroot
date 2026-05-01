"""FastAPI dependencies for authentication (via Next.js internal API)."""

import hmac
from typing import Annotated

import httpx
from fastapi import Depends, Header, HTTPException, status

from shared.config import settings
from shared.enums import MemberRole


class ProjectAccessInfo:
    """Information about user's access to a project."""

    def __init__(self, project_id: str, user_id: str, role: str):
        self.project_id = project_id
        self.user_id = user_id
        self.role = role


async def get_project_access(
    project_id: str,
    x_user_id: Annotated[str | None, Header()] = None,
    x_internal_secret: Annotated[str | None, Header()] = None,
) -> ProjectAccessInfo:
    """
    Validate user has access to a project via Next.js internal API.

    Auth modes:
    - x-user-id: User's unique ID (from session) — normal user-initiated requests.
    - X-Internal-Secret: Shared secret — for trusted server-to-server calls
      (e.g. the agent service running a system-initiated RCA session that has no
      associated user). Bypasses the Next.js per-user access check; the agent
      service is itself trusted to scope access correctly.

    Raises 401 if neither auth mode succeeds, 403 if no access, 404 if project
    not found.
    """
    # System bypass: agent service / worker calling on behalf of the system.
    # Constant-time compare to avoid leaking the secret via response timing.
    if (
        x_internal_secret
        and settings.internal_api_secret
        and hmac.compare_digest(x_internal_secret, settings.internal_api_secret)
    ):
        return ProjectAccessInfo(
            project_id=project_id,
            user_id=x_user_id or "system",
            role=MemberRole.ADMIN,
        )

    if not x_user_id:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing x-user-id header",
        )

    # Validate access via Next.js internal API
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.post(
                f"{settings.traceroot_ui_url}/api/internal/validate-project-access",
                json={"userId": x_user_id, "projectId": project_id},
                headers={"X-Internal-Secret": settings.internal_api_secret},
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

    return ProjectAccessInfo(
        project_id=project_id,
        user_id=x_user_id,
        role=data.get("role", MemberRole.VIEWER),
    )


ProjectAccess = Annotated[ProjectAccessInfo, Depends(get_project_access)]
