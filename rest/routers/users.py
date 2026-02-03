"""User query endpoints (user-authenticated, not public API)."""

import logging

from fastapi import APIRouter, Query, status
from fastapi.responses import JSONResponse

from rest.routers.deps import ProjectAccess
from rest.services.trace_reader import get_trace_reader_service

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/projects/{project_id}/users", tags=["Users"])


@router.get("")
async def list_users(
    project_id: str,
    _access: ProjectAccess,  # Validates user has access to project
    page: int = Query(0, ge=0, description="Page number (0-indexed)"),
    limit: int = Query(50, ge=1, le=100, description="Items per page"),
):
    """List unique users for a project with trace counts."""
    try:
        service = get_trace_reader_service()
        result = service.list_users(
            project_id=project_id,
            page=page,
            limit=limit,
        )
        return result
    except Exception as e:
        logger.exception(f"Error listing users: {e}")
        return JSONResponse(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            content={"detail": "Failed to list users"},
        )
