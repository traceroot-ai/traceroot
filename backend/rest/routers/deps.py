"""FastAPI dependencies for authentication (via Next.js internal API)."""

import os
from typing import Annotated

import httpx
from fastapi import Depends, Header, HTTPException, status

# Configuration for internal API (Python → Next.js)
TRACEROOT_UI_URL = os.getenv("TRACEROOT_UI_URL", "http://localhost:3000")
INTERNAL_API_SECRET = os.getenv("INTERNAL_API_SECRET", "")


class ProjectAccessInfo:
    """Information about user's access to a project."""

    def __init__(self, project_id: str, user_id: str, role: str):
        self.project_id = project_id
        self.user_id = user_id
        self.role = role


async def get_project_access(
    project_id: str,
    x_user_id: Annotated[str | None, Header()] = None,
) -> ProjectAccessInfo:
    """
    Validate user has access to a project via Next.js internal API.

    The frontend should pass:
    - x-user-id: User's unique ID (from session)

    Raises 401 if missing user ID, 403 if no access, 404 if project not found.
    """
    if not x_user_id:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing x-user-id header",
        )

    # Validate access via Next.js internal API
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.post(
                f"{TRACEROOT_UI_URL}/api/internal/validate-project-access",
                json={"userId": x_user_id, "projectId": project_id},
                headers={"X-Internal-Secret": INTERNAL_API_SECRET},
            )
    except httpx.RequestError as e:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=f"Authentication service unavailable: {e}",
        )

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
        status_code = status.HTTP_404_NOT_FOUND if "not found" in error.lower() else status.HTTP_403_FORBIDDEN
        raise HTTPException(status_code=status_code, detail=error)

    return ProjectAccessInfo(
        project_id=project_id,
        user_id=x_user_id,
        role=data.get("role", "VIEWER"),
    )


ProjectAccess = Annotated[ProjectAccessInfo, Depends(get_project_access)]
