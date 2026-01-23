"""Project management endpoints (by project_id)."""

from fastapi import APIRouter, HTTPException, status

from db.postgres import (
    get_active_project_by_id,
    soft_delete_project,
    update_project,
)
from rest.routers.deps import DbSession, ProjectAccess
from rest.config.organizations import ProjectResponse, ProjectUpdate

router = APIRouter(prefix="/projects", tags=["Projects"])


@router.get("/{project_id}", response_model=ProjectResponse)
async def get_project_endpoint(
    project_id: str,
    access: ProjectAccess,
    session: DbSession,
):
    """Get project details by ID."""
    project = await get_active_project_by_id(session, project_id)
    if not project:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Project not found",
        )

    return ProjectResponse(
        id=project.id,
        org_id=project.org_id,
        name=project.name,
        retention_days=project.retention_days,
        created_at=project.created_at,
        updated_at=project.updated_at,
    )


@router.patch("/{project_id}", response_model=ProjectResponse)
async def update_project_endpoint(
    project_id: str,
    data: ProjectUpdate,
    access: ProjectAccess,
    session: DbSession,
):
    """Update project settings."""
    project = await update_project(
        session,
        project_id=project_id,
        name=data.name,
        retention_days=data.retention_days,
    )
    if not project:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Project not found",
        )

    await session.commit()

    return ProjectResponse(
        id=project.id,
        org_id=project.org_id,
        name=project.name,
        retention_days=project.retention_days,
        created_at=project.created_at,
        updated_at=project.updated_at,
    )


@router.delete("/{project_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_project_endpoint(
    project_id: str,
    access: ProjectAccess,
    session: DbSession,
):
    """Soft-delete a project."""
    deleted = await soft_delete_project(session, project_id)
    if not deleted:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Project not found",
        )

    await session.commit()
