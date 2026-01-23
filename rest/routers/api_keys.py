"""API key management endpoints."""

from fastapi import APIRouter, HTTPException, status

from db.postgres import get_active_project_by_id
from db.postgres.api_key import (
    create_api_key,
    delete_api_key,
    get_api_key_by_id,
    list_api_keys_by_project,
)
from rest.routers.deps import DbSession, ProjectAccess
from rest.config.api_keys import (
    ApiKeyCreate,
    ApiKeyCreatedResponse,
    ApiKeyListResponse,
    ApiKeyResponse,
)

router = APIRouter(prefix="/projects/{project_id}/api-keys", tags=["API Keys"])


@router.post("", status_code=status.HTTP_201_CREATED, response_model=ApiKeyCreatedResponse)
async def create_api_key_endpoint(
    project_id: str,
    data: ApiKeyCreate,
    access: ProjectAccess,
    session: DbSession,
):
    """
    Create a new API key for the project.

    The full key is only returned once at creation. Store it securely.
    """
    # Verify project exists
    project = await get_active_project_by_id(session, project_id)
    if not project:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Project not found",
        )

    api_key = await create_api_key(
        session,
        project_id=project_id,
        name=data.name,
        expires_at=data.expires_at,
    )
    await session.commit()

    return ApiKeyCreatedResponse(
        id=api_key.id,
        project_id=api_key.project_id,
        key_prefix=api_key.key_prefix,
        name=api_key.name,
        expires_at=api_key.expires_at,
        last_used_at=api_key.last_used_at,
        created_at=api_key.created_at,
        key=api_key.key,
    )


@router.get("", response_model=ApiKeyListResponse)
async def list_api_keys_endpoint(
    project_id: str,
    access: ProjectAccess,
    session: DbSession,
):
    """List all API keys for a project."""
    # Verify project exists
    project = await get_active_project_by_id(session, project_id)
    if not project:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Project not found",
        )

    keys = await list_api_keys_by_project(session, project_id)

    return ApiKeyListResponse(
        data=[
            ApiKeyResponse(
                id=k.id,
                project_id=k.project_id,
                key_prefix=k.key_prefix,
                name=k.name,
                expires_at=k.expires_at,
                last_used_at=k.last_used_at,
                created_at=k.created_at,
            )
            for k in keys
        ]
    )


@router.delete("/{key_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_api_key_endpoint(
    project_id: str,
    key_id: str,
    access: ProjectAccess,
    session: DbSession,
):
    """Revoke an API key."""
    # Verify the key exists and belongs to this project
    api_key = await get_api_key_by_id(session, key_id)
    if not api_key or api_key.project_id != project_id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="API key not found",
        )

    await delete_api_key(session, key_id)
    await session.commit()
