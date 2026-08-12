"""Public, API-key-authenticated session read endpoints.

`GET /api/v1/public/sessions` (list) and `GET /api/v1/public/sessions/{session_id}`
(get). Reads are scoped to the project the API key belongs to — the client never
supplies a project id. Reuses the shared trace-reader service that also serves
the user-authenticated session routes, so both surfaces share one implementation.
"""

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
from rest.routers.public.deps import StampedAuth
from rest.schemas.sessions import SessionDetailResponse, SessionListResponse
from rest.services.trace_reader import get_trace_reader_service

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/public/sessions", tags=["Sessions (Public)"])


@router.get("", response_model=SessionListResponse, operation_id="list_sessions")
@limiter.shared_limit(
    resolve_limit, scope=BUCKET_READ, key_func=key_read, exempt_when=is_request_rate_limit_exempt
)
async def list_sessions(
    request: Request,
    response: Response,
    auth: StampedAuth,
    limit: int = Query(50, ge=1, le=200, description="Items per page"),
    search_query: str | None = Query(None, description="Search by session_id"),
    start_after: datetime | None = Query(
        None,
        description="Only sessions with traces at or after this time (inclusive, ISO 8601)",
    ),
    end_before: datetime | None = Query(
        None,
        description="Only sessions with traces before this time (exclusive, ISO 8601)",
    ),
):
    """List unique sessions for the API key's project with trace counts.

    Args:
        auth (StampedAuth): Resolved API-key context; scopes the read to its
            project and stamps the rate-limit identity.
        limit (int): Items per page (1-200).
        search_query (str | None): Substring match on session id.
        start_after (datetime | None): Inclusive lower bound on trace time.
        end_before (datetime | None): Exclusive upper bound on trace time.

    Returns:
        SessionListResponse: Session summaries, newest first.

    Raises:
        HTTPException: 500 on a reader failure.
    """
    start_after, end_before = clamp_retention_window(auth.billing_plan, start_after, end_before)
    try:
        service = get_trace_reader_service()
        return service.list_sessions(
            project_id=auth.project_id,
            limit=limit,
            search_query=search_query,
            start_after=start_after,
            end_before=end_before,
        )
    except Exception as e:
        logger.exception(f"Error listing sessions: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to list sessions",
        ) from e


@router.get("/{session_id}", response_model=SessionDetailResponse, operation_id="get_session")
@limiter.shared_limit(
    resolve_limit, scope=BUCKET_READ, key_func=key_read, exempt_when=is_request_rate_limit_exempt
)
async def get_session(
    request: Request,
    response: Response,
    auth: StampedAuth,
    session_id: str,
    start_after: datetime | None = Query(
        None, description="Only traces at or after this time (inclusive, ISO 8601)"
    ),
    end_before: datetime | None = Query(
        None, description="Only traces before this time (exclusive, ISO 8601)"
    ),
):
    """Get one session with all its traces for the key's project.

    Retention uses the silent list-style clamp rather than a 403: a session
    that contains traces older than the plan window degrades to showing only
    the in-window traces instead of failing outright.

    Args:
        auth (StampedAuth): Resolved API-key context; scopes the read to its
            project and stamps the rate-limit identity.
        session_id (str): Session to fetch.
        start_after (datetime | None): Inclusive lower bound on trace time.
        end_before (datetime | None): Exclusive upper bound on trace time.

    Returns:
        SessionDetailResponse: The session overview and its traces.

    Raises:
        HTTPException: 404 if the session is missing or outside the key's
            project, 500 on a reader failure.
    """
    start_after, end_before = clamp_retention_window(auth.billing_plan, start_after, end_before)
    try:
        service = get_trace_reader_service()
        result = service.get_session(
            project_id=auth.project_id,
            session_id=session_id,
            start_after=start_after,
            end_before=end_before,
        )
    except Exception as e:
        logger.exception(f"Error getting session: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to get session",
        ) from e
    if result is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Session not found",
        )
    return result
