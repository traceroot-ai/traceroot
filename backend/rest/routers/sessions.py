"""Session query endpoints (user-authenticated, not public API)."""

import logging
from datetime import datetime

from fastapi import APIRouter, HTTPException, Query, status

from rest.routers.deps import ProjectAccess
from rest.schemas.sessions import SessionDetailResponse, SessionListResponse
from rest.services.trace_reader import get_trace_reader_service

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/projects/{project_id}/sessions", tags=["Sessions"])


@router.get("", response_model=SessionListResponse)
async def list_sessions(
    project_id: str,
    _access: ProjectAccess,
    page: int = Query(0, ge=0, description="Page number (0-indexed)"),
    limit: int = Query(50, ge=1, le=200, description="Items per page"),
    search_query: str | None = Query(None, description="Search by session_id"),
    start_after: datetime | None = Query(None, description="Filter traces after this time"),
    end_before: datetime | None = Query(None, description="Filter traces before this time"),
):
    """List unique sessions for a project with trace counts and token totals."""
    try:
        service = get_trace_reader_service()
        result = service.list_sessions(
            project_id=project_id,
            page=page,
            limit=limit,
            search_query=search_query,
            start_after=start_after,
            end_before=end_before,
        )
        return result
    except Exception as e:
        logger.exception(f"Error listing sessions: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to list sessions",
        ) from e


@router.get("/{session_id}", response_model=SessionDetailResponse)
async def get_session(
    project_id: str,
    session_id: str,
    _access: ProjectAccess,
    start_after: datetime | None = Query(None, description="Filter traces after this time"),
    end_before: datetime | None = Query(None, description="Filter traces before this time"),
):
    """Get session detail with all traces for conversation view."""
    try:
        service = get_trace_reader_service()
        result = service.get_session(
            project_id=project_id,
            session_id=session_id,
            start_after=start_after,
            end_before=end_before,
        )
        if result is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Session not found",
            )
        return result
    except HTTPException:
        raise
    except Exception as e:
        logger.exception(f"Error getting session: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to get session",
        ) from e
