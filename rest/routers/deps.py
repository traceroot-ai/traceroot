"""FastAPI dependencies for authentication and database access."""

import os
from typing import Annotated

import httpx
from fastapi import Depends, Header, HTTPException, status
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from db.postgres.engine import get_session as get_postgres_session


# Next.js API base URL for internal calls
NEXTJS_API_BASE = os.getenv("NEXTJS_API_URL", "http://localhost:3000/api")


async def get_db_session():
    """Get a database session."""
    async with get_postgres_session() as session:
        yield session


DbSession = Annotated[AsyncSession, Depends(get_db_session)]


class ProjectAccessInfo(BaseModel):
    """Information about user's access to a project."""
    project_id: str
    project_name: str
    org_id: str
    user_id: str
    role: str


async def get_project_access(
    project_id: str,
    x_user_id: Annotated[str | None, Header()] = None,
    x_user_email: Annotated[str | None, Header()] = None,
) -> ProjectAccessInfo:
    """
    Validate user's access to a project by calling the Next.js API.

    This allows the Python backend to verify access without needing
    to query PostgreSQL directly (since org/project data is managed via Prisma).
    """
    if not x_user_id:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing x-user-id header",
        )

    try:
        async with httpx.AsyncClient(follow_redirects=True) as client:
            response = await client.get(
                f"{NEXTJS_API_BASE}/internal/validate-project-access",
                params={"project_id": project_id},
                headers={
                    "x-user-id": x_user_id,
                    "x-user-email": x_user_email or "",
                },
                timeout=10.0,
            )

            if response.status_code == 401:
                raise HTTPException(
                    status_code=status.HTTP_401_UNAUTHORIZED,
                    detail="Unauthorized",
                )
            elif response.status_code == 403:
                raise HTTPException(
                    status_code=status.HTTP_403_FORBIDDEN,
                    detail="No access to this project",
                )
            elif response.status_code == 404:
                raise HTTPException(
                    status_code=status.HTTP_404_NOT_FOUND,
                    detail="Project not found",
                )
            elif response.status_code != 200:
                raise HTTPException(
                    status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                    detail="Failed to validate project access",
                )

            data = response.json()
            return ProjectAccessInfo(**data)

    except httpx.RequestError as e:
        # Connection error to Next.js API
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=f"Unable to validate project access: {str(e)}",
        )


ProjectAccess = Annotated[ProjectAccessInfo, Depends(get_project_access)]
