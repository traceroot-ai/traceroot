"""API key database operations."""

import hashlib
import uuid
from datetime import datetime, timezone

from cuid2 import cuid_wrapper
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from db.postgres.models import ApiKeyModel

cuid = cuid_wrapper()


class ApiKey(BaseModel):
    """API key domain model."""

    id: str
    project_id: str
    key_prefix: str
    name: str | None = None
    expires_at: datetime | None = None
    last_used_at: datetime | None = None
    created_at: datetime


class ApiKeyWithSecret(ApiKey):
    """API key with the full secret (only returned at creation)."""

    key: str


def _to_api_key(model: ApiKeyModel) -> ApiKey:
    """Convert SQLAlchemy model to domain model."""
    return ApiKey(
        id=model.id,
        project_id=model.project_id,
        key_prefix=model.key_prefix,
        name=model.name,
        expires_at=model.expires_at,
        last_used_at=model.last_used_at,
        created_at=model.created_at,
    )


def generate_api_key() -> tuple[str, str, str]:
    """Generate a new API key.

    Returns:
        tuple: (full_key, key_hash, key_prefix)
    """
    # Generate UUID-based key (e.g., tr-3ecd9b33-2469-fee9-97be-a54957f37552)
    random_part = str(uuid.uuid4())
    full_key = f"tr-{random_part}"
    key_hash = hashlib.sha256(full_key.encode()).hexdigest()
    key_prefix = full_key[:10]  # "tr-xxxxxx" (prefix + first 6 chars of UUID)
    return full_key, key_hash, key_prefix


async def create_api_key(
    session: AsyncSession,
    project_id: str,
    name: str | None = None,
    expires_at: datetime | None = None,
) -> ApiKeyWithSecret:
    """Create a new API key."""
    full_key, key_hash, key_prefix = generate_api_key()

    api_key = ApiKeyModel(
        id=cuid(),
        project_id=project_id,
        key_hash=key_hash,
        key_prefix=key_prefix,
        name=name,
        expires_at=expires_at,
    )
    session.add(api_key)
    await session.flush()

    return ApiKeyWithSecret(
        id=api_key.id,
        project_id=api_key.project_id,
        key_prefix=api_key.key_prefix,
        name=api_key.name,
        expires_at=api_key.expires_at,
        last_used_at=api_key.last_used_at,
        created_at=api_key.created_at,
        key=full_key,
    )


async def list_api_keys_by_project(
    session: AsyncSession, project_id: str
) -> list[ApiKey]:
    """List all API keys for a project."""
    result = await session.execute(
        select(ApiKeyModel)
        .where(ApiKeyModel.project_id == project_id)
        .order_by(ApiKeyModel.created_at.desc())
    )
    keys = result.scalars().all()
    return [_to_api_key(k) for k in keys]


async def get_api_key_by_id(
    session: AsyncSession, key_id: str
) -> ApiKey | None:
    """Get API key by ID."""
    result = await session.execute(
        select(ApiKeyModel).where(ApiKeyModel.id == key_id)
    )
    key = result.scalar_one_or_none()
    return _to_api_key(key) if key else None


async def delete_api_key(session: AsyncSession, key_id: str) -> bool:
    """Delete an API key."""
    result = await session.execute(
        select(ApiKeyModel).where(ApiKeyModel.id == key_id)
    )
    key = result.scalar_one_or_none()
    if not key:
        return False

    await session.delete(key)
    await session.flush()
    return True


async def get_api_key_by_hash(
    session: AsyncSession, key_hash: str
) -> ApiKey | None:
    """Get API key by hash (for authentication)."""
    result = await session.execute(
        select(ApiKeyModel).where(ApiKeyModel.key_hash == key_hash)
    )
    key = result.scalar_one_or_none()
    return _to_api_key(key) if key else None


async def update_api_key_last_used(
    session: AsyncSession, key_id: str
) -> None:
    """Update the last_used_at timestamp."""
    result = await session.execute(
        select(ApiKeyModel).where(ApiKeyModel.id == key_id)
    )
    key = result.scalar_one_or_none()
    if key:
        key.last_used_at = datetime.now(timezone.utc).replace(tzinfo=None)
        await session.flush()
