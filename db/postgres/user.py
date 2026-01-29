"""User database operations."""

from datetime import datetime, timezone

from cuid2 import cuid_wrapper
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from common.models import User
from db.postgres.models import UserModel

cuid = cuid_wrapper()


def _to_user(model: UserModel) -> User:
    """Convert SQLAlchemy model to domain model."""
    return User(
        id=model.id,
        email=model.email,
        name=model.name,
        image=model.image,
        admin=model.admin,
        created_at=model.created_at,
        updated_at=model.updated_at,
    )


async def create_user(
    session: AsyncSession,
    email: str,
    name: str | None = None,
    password_hash: str | None = None,
    user_id: str | None = None,
) -> User:
    """Create a new user."""
    user = UserModel(
        id=user_id or cuid(),
        email=email,
        name=name,
        password=password_hash,
        admin=False,
    )
    session.add(user)
    await session.flush()
    return _to_user(user)


async def get_user_by_id(session: AsyncSession, user_id: str) -> User | None:
    """Get user by ID."""
    result = await session.execute(select(UserModel).where(UserModel.id == user_id))
    user = result.scalar_one_or_none()
    return _to_user(user) if user else None


async def get_user_by_email(session: AsyncSession, email: str) -> User | None:
    """Get user by email."""
    result = await session.execute(select(UserModel).where(UserModel.email == email))
    user = result.scalar_one_or_none()
    return _to_user(user) if user else None


async def upsert_user(
    session: AsyncSession,
    user_id: str,
    email: str,
    name: str | None = None,
) -> User:
    """Create or update user (for OAuth sync).

    Looks up by user_id first, then by email if not found.
    This handles cases where the same email might be used with different auth providers.
    """
    # First try to find by ID
    result = await session.execute(select(UserModel).where(UserModel.id == user_id))
    user = result.scalar_one_or_none()

    if not user:
        # Try to find by email (in case user exists from different auth provider)
        result = await session.execute(select(UserModel).where(UserModel.email == email))
        user = result.scalar_one_or_none()

    if user:
        # Update existing user
        if name:
            user.name = name
        user.updated_at = datetime.now(timezone.utc).replace(tzinfo=None)
    else:
        # Create new user
        user = UserModel(
            id=user_id,
            email=email,
            name=name,
            admin=False,
        )
        session.add(user)

    await session.flush()
    return _to_user(user)


async def update_user(
    session: AsyncSession,
    user_id: str,
    name: str | None = None,
    image: str | None = None,
) -> User | None:
    """Update user details."""
    result = await session.execute(select(UserModel).where(UserModel.id == user_id))
    user = result.scalar_one_or_none()
    if not user:
        return None

    if name is not None:
        user.name = name
    if image is not None:
        user.image = image
    user.updated_at = datetime.now(timezone.utc).replace(tzinfo=None)

    await session.flush()
    return _to_user(user)
