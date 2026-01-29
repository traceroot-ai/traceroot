"""Organization database operations."""

from datetime import datetime, timezone

from cuid2 import cuid_wrapper
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from common.models import Organization, OrganizationWithRole, Role
from db.postgres.models import OrganizationMembershipModel, OrganizationModel

cuid = cuid_wrapper()


def _to_organization(model: OrganizationModel) -> Organization:
    """Convert SQLAlchemy model to domain model."""
    return Organization(
        id=model.id,
        name=model.name,
        created_at=model.created_at,
        updated_at=model.updated_at,
    )


async def create_organization(session: AsyncSession, name: str) -> Organization:
    """Create a new organization."""
    org = OrganizationModel(
        id=cuid(),
        name=name,
    )
    session.add(org)
    await session.flush()
    return _to_organization(org)


async def get_organization_by_id(session: AsyncSession, org_id: str) -> Organization | None:
    """Get organization by ID."""
    result = await session.execute(
        select(OrganizationModel).where(OrganizationModel.id == org_id)
    )
    org = result.scalar_one_or_none()
    return _to_organization(org) if org else None


async def list_organizations_by_user(
    session: AsyncSession, user_id: str
) -> list[OrganizationWithRole]:
    """List organizations a user belongs to (with their role)."""
    result = await session.execute(
        select(OrganizationModel, OrganizationMembershipModel.role)
        .join(
            OrganizationMembershipModel,
            OrganizationModel.id == OrganizationMembershipModel.org_id,
        )
        .where(OrganizationMembershipModel.user_id == user_id)
        .order_by(OrganizationModel.created_at.desc())
    )
    rows = result.all()
    return [
        OrganizationWithRole(
            id=org.id,
            name=org.name,
            created_at=org.created_at,
            updated_at=org.updated_at,
            role=Role(role),
        )
        for org, role in rows
    ]


async def update_organization(
    session: AsyncSession, org_id: str, name: str
) -> Organization | None:
    """Update organization name."""
    result = await session.execute(
        select(OrganizationModel).where(OrganizationModel.id == org_id)
    )
    org = result.scalar_one_or_none()
    if not org:
        return None

    org.name = name
    org.updated_at = datetime.now(timezone.utc).replace(tzinfo=None)
    await session.flush()
    return _to_organization(org)


async def delete_organization(session: AsyncSession, org_id: str) -> bool:
    """Delete organization (hard delete)."""
    result = await session.execute(
        select(OrganizationModel).where(OrganizationModel.id == org_id)
    )
    org = result.scalar_one_or_none()
    if not org:
        return False

    await session.delete(org)
    await session.flush()
    return True


async def get_organization_with_projects(
    session: AsyncSession, org_id: str
) -> OrganizationModel | None:
    """Get organization with its projects loaded."""
    result = await session.execute(
        select(OrganizationModel)
        .where(OrganizationModel.id == org_id)
        .options(selectinload(OrganizationModel.projects))
    )
    return result.scalar_one_or_none()
