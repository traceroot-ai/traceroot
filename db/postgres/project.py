"""Project database operations."""

from datetime import datetime, timezone

from cuid2 import cuid_wrapper
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from db.postgres.models import ProjectModel

cuid = cuid_wrapper()


class Project(BaseModel):
    """Project domain model."""

    id: str
    org_id: str
    name: str
    retention_days: int | None = None
    deleted_at: datetime | None = None
    created_at: datetime = Field(default_factory=datetime.utcnow)
    updated_at: datetime = Field(default_factory=datetime.utcnow)


def _to_project(model: ProjectModel) -> Project:
    """Convert SQLAlchemy model to domain model."""
    return Project(
        id=model.id,
        org_id=model.org_id,
        name=model.name,
        retention_days=model.retention_days,
        deleted_at=model.deleted_at,
        created_at=model.created_at,
        updated_at=model.updated_at,
    )


async def create_project(
    session: AsyncSession,
    org_id: str,
    name: str,
    retention_days: int | None = None,
) -> Project:
    """Create a new project."""
    project = ProjectModel(
        id=cuid(),
        org_id=org_id,
        name=name,
        retention_days=retention_days,
    )
    session.add(project)
    await session.flush()
    return _to_project(project)


async def get_active_project_by_id(
    session: AsyncSession, project_id: str
) -> Project | None:
    """Get project by ID (excluding soft-deleted)."""
    result = await session.execute(
        select(ProjectModel).where(
            ProjectModel.id == project_id,
            ProjectModel.deleted_at.is_(None),
        )
    )
    project = result.scalar_one_or_none()
    return _to_project(project) if project else None


async def list_projects_by_org(
    session: AsyncSession,
    org_id: str,
    include_deleted: bool = False,
) -> list[Project]:
    """List projects in an organization."""
    query = select(ProjectModel).where(ProjectModel.org_id == org_id)
    if not include_deleted:
        query = query.where(ProjectModel.deleted_at.is_(None))
    query = query.order_by(ProjectModel.created_at.desc())

    result = await session.execute(query)
    projects = result.scalars().all()
    return [_to_project(p) for p in projects]


async def update_project(
    session: AsyncSession,
    project_id: str,
    name: str | None = None,
    retention_days: int | None = None,
) -> Project | None:
    """Update project details."""
    result = await session.execute(
        select(ProjectModel).where(
            ProjectModel.id == project_id,
            ProjectModel.deleted_at.is_(None),
        )
    )
    project = result.scalar_one_or_none()
    if not project:
        return None

    if name is not None:
        project.name = name
    if retention_days is not None:
        project.retention_days = retention_days
    project.updated_at = datetime.now(timezone.utc)

    await session.flush()
    return _to_project(project)


async def soft_delete_project(session: AsyncSession, project_id: str) -> bool:
    """Soft delete a project."""
    result = await session.execute(
        select(ProjectModel).where(
            ProjectModel.id == project_id,
            ProjectModel.deleted_at.is_(None),
        )
    )
    project = result.scalar_one_or_none()
    if not project:
        return False

    project.deleted_at = datetime.now(timezone.utc)
    project.updated_at = datetime.now(timezone.utc)
    await session.flush()
    return True


async def has_active_projects(session: AsyncSession, org_id: str) -> bool:
    """Check if organization has any active (non-deleted) projects."""
    result = await session.execute(
        select(ProjectModel.id)
        .where(
            ProjectModel.org_id == org_id,
            ProjectModel.deleted_at.is_(None),
        )
        .limit(1)
    )
    return result.scalar_one_or_none() is not None


async def check_project_name_exists(
    session: AsyncSession,
    org_id: str,
    name: str,
    exclude_project_id: str | None = None,
) -> bool:
    """Check if project name already exists in organization."""
    query = select(ProjectModel.id).where(
        ProjectModel.org_id == org_id,
        ProjectModel.name == name,
        ProjectModel.deleted_at.is_(None),
    )
    if exclude_project_id:
        query = query.where(ProjectModel.id != exclude_project_id)

    result = await session.execute(query)
    return result.scalar_one_or_none() is not None
