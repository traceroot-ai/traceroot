"""FastAPI dependencies for authentication and database access."""

from typing import Annotated

from fastapi import Depends, Header, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from common.models import OrganizationMembership, Role, User, has_min_role
from db.postgres import get_active_project_by_id, get_membership, upsert_user
from db.postgres.engine import get_session as get_postgres_session


async def get_db_session():
    """Get a database session."""
    async with get_postgres_session() as session:
        yield session


DbSession = Annotated[AsyncSession, Depends(get_db_session)]


async def get_current_user(
    x_user_id: Annotated[str | None, Header()] = None,
    x_user_email: Annotated[str | None, Header()] = None,
    x_user_name: Annotated[str | None, Header()] = None,
    session: AsyncSession = Depends(get_db_session),
) -> User:
    """
    Get current user from request headers.

    For MVP, we use simple header-based auth. The frontend should pass:
    - x-user-id: User's unique ID
    - x-user-email: User's email
    - x-user-name: User's display name (optional)

    In production, this should be replaced with proper JWT/session validation.
    """
    if not x_user_id:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing x-user-id header",
        )

    if not x_user_email:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing x-user-email header",
        )

    # Upsert user to database (sync from auth provider)
    user = await upsert_user(
        session,
        user_id=x_user_id,
        email=x_user_email,
        name=x_user_name,
    )
    return user


CurrentUser = Annotated[User, Depends(get_current_user)]


async def get_org_membership(
    org_id: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db_session),
) -> OrganizationMembership:
    """
    Get user's membership in an organization.

    Raises 403 if user is not a member.
    """
    membership = await get_membership(session, org_id, user.id)

    if not membership:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Not a member of this organization",
        )

    return membership


OrgMembership = Annotated[OrganizationMembership, Depends(get_org_membership)]


def require_org_role(min_role: Role):
    """
    Factory for creating role-based access control dependency.

    Usage:
        @router.put("/{org_id}")
        async def update_org(
            org_id: str,
            membership: OrgMembership = Depends(require_org_role(Role.ADMIN)),
        ):
            ...
    """

    async def checker(
        membership: OrganizationMembership = Depends(get_org_membership),
    ) -> OrganizationMembership:
        if not has_min_role(membership.role, min_role):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"Requires at least {min_role.value} role",
            )
        return membership

    return checker


async def get_project_access(
    project_id: str,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db_session),
) -> OrganizationMembership:
    """
    Get user's access to a project via organization membership.

    Raises 404 if project not found, 403 if user has no access.
    """
    project = await get_active_project_by_id(session, project_id)

    if not project:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Project not found",
        )

    membership = await get_membership(session, project.org_id, user.id)

    if not membership:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="No access to this project",
        )

    return membership


ProjectAccess = Annotated[OrganizationMembership, Depends(get_project_access)]
