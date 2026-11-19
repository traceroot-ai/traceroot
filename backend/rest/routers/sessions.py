"""Session query endpoints (user-authenticated, not public API)."""

import logging
from datetime import datetime

from fastapi import APIRouter, HTTPException, Query, Request, Response, status

from rest.rate_limit import (
    BUCKET_READ,
    is_request_rate_limit_exempt,
    key_read,
    limiter,
    resolve_limit,
)
from rest.retention import clamp_retention_window
from rest.routers.deps import RateLimitedProjectAccess
from rest.schemas.sessions import SessionDetailResponse, SessionListResponse
from rest.services.trace_reader import get_trace_reader_service

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/projects/{project_id}/sessions", tags=["Sessions"])


@router.get("", response_model=SessionListResponse)
@limiter.shared_limit(
    resolve_limit, scope=BUCKET_READ, key_func=key_read, exempt_when=is_request_rate_limit_exempt
)
async def list_sessions(
    request: Request,
    response: Response,
    project_id: str,
    _access: RateLimitedProjectAccess,
    page: int = Query(0, ge=0, description="Page number (0-indexed)"),
    limit: int = Query(50, ge=1, le=200, description="Items per page"),
    search_query: str | None = Query(None, description="Search by session_id"),
    start_after: datetime | None = Query(None, description="Filter traces after this time"),
    end_before: datetime | None = Query(None, description="Filter traces before this time"),
    include_evaluations: bool = Query(
        False,
        description="Include offline-evaluation traces in the session aggregates. "
        "Excluded by default, matching the Traces list.",
    ),
):
    """List unique sessions for a project with trace counts and token totals."""
    start_after, end_before = clamp_retention_window(_access.billing_plan, start_after, end_before)
    try:
        service = get_trace_reader_service()
        result = service.list_sessions(
            project_id=project_id,
            page=page,
            limit=limit,
            search_query=search_query,
            start_after=start_after,
            end_before=end_before,
            include_evaluations=include_evaluations,
        )
        return result
    except Exception as e:
        logger.exception(f"Error listing sessions: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to list sessions",
        ) from e


@router.get("/{session_id}", response_model=SessionDetailResponse)
@limiter.shared_limit(
    resolve_limit, scope=BUCKET_READ, key_func=key_read, exempt_when=is_request_rate_limit_exempt
)
async def get_session(
    request: Request,
    response: Response,
    project_id: str,
    session_id: str,
    _access: RateLimitedProjectAccess,
    start_after: datetime | None = Query(None, description="Filter traces after this time"),
    end_before: datetime | None = Query(None, description="Filter traces before this time"),
    include_evaluations: bool = Query(
        False,
        description="Include offline-evaluation traces in this session's traces and "
        "totals. Excluded by default, matching the session list.",
    ),
):
    """Get session detail with all traces for conversation view."""
    start_after, end_before = clamp_retention_window(_access.billing_plan, start_after, end_before)
    try:
        service = get_trace_reader_service()
        result = service.get_session(
            project_id=project_id,
            session_id=session_id,
            start_after=start_after,
            end_before=end_before,
            include_evaluations=include_evaluations,
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
