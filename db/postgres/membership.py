"""Organization membership database operations."""

from datetime import datetime, timezone

from cuid2 import cuid_wrapper
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from common.models import Member, OrganizationMembership, Role
from db.postgres.models import OrganizationMembershipModel, UserModel

cuid = cuid_wrapper()


def _to_membership(model: OrganizationMembershipModel) -> OrganizationMembership:
    """Convert SQLAlchemy model to domain model."""
    return OrganizationMembership(
        id=model.id,
        org_id=model.org_id,
        user_id=model.user_id,
        role=Role(model.role),
        created_at=model.created_at,
        updated_at=model.updated_at,
    )


async def add_member(
    session: AsyncSession,
    org_id: str,
    user_id: str,
    role: Role,
) -> OrganizationMembership:
    """Add a user as a member of an organization."""
    membership = OrganizationMembershipModel(
        id=cuid(),
        org_id=org_id,
        user_id=user_id,
        role=role.value,
    )
    session.add(membership)
    await session.flush()
    return _to_membership(membership)


async def get_membership(
    session: AsyncSession,
    org_id: str,
    user_id: str,
) -> OrganizationMembership | None:
    """Get a specific membership."""
    result = await session.execute(
        select(OrganizationMembershipModel).where(
            OrganizationMembershipModel.org_id == org_id,
            OrganizationMembershipModel.user_id == user_id,
        )
    )
    membership = result.scalar_one_or_none()
    return _to_membership(membership) if membership else None


async def get_user_role(
    session: AsyncSession, org_id: str, user_id: str
) -> Role | None:
    """Get user's role in an organization."""
    result = await session.execute(
        select(OrganizationMembershipModel.role).where(
            OrganizationMembershipModel.org_id == org_id,
            OrganizationMembershipModel.user_id == user_id,
        )
    )
    role_value = result.scalar_one_or_none()
    return Role(role_value) if role_value else None


async def list_memberships_by_user(
    session: AsyncSession, user_id: str
) -> list[OrganizationMembership]:
    """List all memberships for a user."""
    result = await session.execute(
        select(OrganizationMembershipModel).where(
            OrganizationMembershipModel.user_id == user_id
        )
    )
    memberships = result.scalars().all()
    return [_to_membership(m) for m in memberships]


async def list_members_by_org(session: AsyncSession, org_id: str) -> list[Member]:
    """List all members of an organization with user details."""
    result = await session.execute(
        select(OrganizationMembershipModel, UserModel)
        .join(UserModel, OrganizationMembershipModel.user_id == UserModel.id)
        .where(OrganizationMembershipModel.org_id == org_id)
        .order_by(OrganizationMembershipModel.created_at.asc())
    )
    rows = result.all()
    return [
        Member(
            id=membership.id,
            user_id=user.id,
            email=user.email,
            name=user.name,
            role=Role(membership.role),
            created_at=membership.created_at,
        )
        for membership, user in rows
    ]


async def update_member_role(
    session: AsyncSession,
    org_id: str,
    user_id: str,
    role: Role,
) -> OrganizationMembership | None:
    """Update a member's role."""
    result = await session.execute(
        select(OrganizationMembershipModel).where(
            OrganizationMembershipModel.org_id == org_id,
            OrganizationMembershipModel.user_id == user_id,
        )
    )
    membership = result.scalar_one_or_none()
    if not membership:
        return None

    membership.role = role.value
    membership.updated_at = datetime.now(timezone.utc)
    await session.flush()
    return _to_membership(membership)


async def remove_member(session: AsyncSession, org_id: str, user_id: str) -> bool:
    """Remove a member from an organization."""
    result = await session.execute(
        select(OrganizationMembershipModel).where(
            OrganizationMembershipModel.org_id == org_id,
            OrganizationMembershipModel.user_id == user_id,
        )
    )
    membership = result.scalar_one_or_none()
    if not membership:
        return False

    await session.delete(membership)
    await session.flush()
    return True


async def count_owners(session: AsyncSession, org_id: str) -> int:
    """Count number of owners in an organization."""
    result = await session.execute(
        select(OrganizationMembershipModel).where(
            OrganizationMembershipModel.org_id == org_id,
            OrganizationMembershipModel.role == Role.OWNER.value,
        )
    )
    return len(result.scalars().all())
