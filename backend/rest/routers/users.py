"""User query endpoints (user-authenticated, not public API)."""

import logging
from datetime import datetime

from fastapi import APIRouter, HTTPException, Query, Request, status

from rest.rate_limit import key_by_user_id, limiter
from rest.routers.deps import ProjectAccess
from rest.schemas.users import UserListResponse
from rest.services.trace_reader import get_trace_reader_service
from shared.config import settings

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/projects/{project_id}/users", tags=["Users"])


@router.get("", response_model=UserListResponse)
@limiter.limit(settings.rate_limit.api, key_func=key_by_user_id)
async def list_users(
    request: Request,
    project_id: str,
    _access: ProjectAccess,  # Validates user has access to project
    page: int = Query(0, ge=0, description="Page number (0-indexed)"),
    limit: int = Query(50, ge=1, le=200, description="Items per page"),
    search_query: str | None = Query(None, description="Search by user_id"),
    start_after: datetime | None = Query(None, description="Filter traces after this time"),
    end_before: datetime | None = Query(None, description="Filter traces before this time"),
):
    """List unique users for a project with trace counts."""
    try:
        service = get_trace_reader_service()
        result = service.list_users(
            project_id=project_id,
            page=page,
            limit=limit,
            search_query=search_query,
            start_after=start_after,
            end_before=end_before,
        )
        return result
    except Exception as e:
        logger.exception(f"Error listing users: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to list users",
        ) from e
