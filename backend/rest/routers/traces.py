"""Trace query endpoints (user-authenticated, not public API)."""

import logging
from datetime import datetime

from fastapi import APIRouter, HTTPException, Query, Request, Response, status

from rest.projection import (
    FIELDS_PARAM_DESC,
    SKELETON,
    InvalidFieldsError,
    hydrate_span_io,
    resolve_span_fields,
)
from rest.rate_limit import (
    BUCKET_READ,
    is_request_rate_limit_exempt,
    key_read,
    limiter,
    resolve_limit,
)
from rest.routers.deps import ProjectAccess, ProjectAccessInfo, RateLimitedProjectAccess
from rest.schemas.traces import SpanIOResponse, TraceDetailResponse, TraceListResponse
from rest.services.trace_reader import get_trace_reader_service

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/projects/{project_id}/traces", tags=["Traces"])


def _uses_dashboard_trace_cache(
    access: ProjectAccessInfo, *, groups: frozenset[str] | None = None
) -> bool:
    """Only user-authenticated dashboard reads opt into short-lived trace caching.

    Internal-secret callers do not carry a workspace id and are used by agent
    and system flows that need fresh trace reads. Detail reads cache only the
    default skeleton projection; full or partial I/O projections load fresh
    before hydrating blobs.
    """
    if not access.workspace_id:
        return False
    return groups is None or groups == SKELETON


@router.get("", response_model=TraceListResponse)
@limiter.shared_limit(
    resolve_limit, scope=BUCKET_READ, key_func=key_read, exempt_when=is_request_rate_limit_exempt
)
async def list_traces(
    request: Request,
    response: Response,
    project_id: str,
    _access: RateLimitedProjectAccess,  # Validates access + sets rate-limit identity
    page: int = Query(0, ge=0, description="Page number (0-indexed)"),
    limit: int = Query(50, ge=1, le=200, description="Items per page"),
    name: str | None = Query(None, description="Filter by trace name (partial match)"),
    user_id: str | None = Query(None, description="Filter by user ID (exact match)"),
    start_after: datetime | None = Query(None, description="Filter traces after this timestamp"),
    end_before: datetime | None = Query(None, description="Filter traces before this timestamp"),
    search_query: str | None = Query(
        None, description="Search trace_id, name, session_id, user_id"
    ),
):
    """List traces for a project with pagination and filtering."""
    try:
        service = get_trace_reader_service()
        result = service.list_traces(
            project_id=project_id,
            page=page,
            limit=limit,
            name=name,
            user_id=user_id,
            start_after=start_after,
            end_before=end_before,
            search_query=search_query,
            use_cache=_uses_dashboard_trace_cache(_access),
        )
        return result
    except Exception as e:
        logger.exception(f"Error listing traces: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to list traces",
        ) from e


@router.get("/{trace_id}", response_model=TraceDetailResponse)
@limiter.shared_limit(
    resolve_limit, scope=BUCKET_READ, key_func=key_read, exempt_when=is_request_rate_limit_exempt
)
async def get_trace(
    request: Request,
    response: Response,
    project_id: str,
    trace_id: str,
    _access: RateLimitedProjectAccess,  # Validates access + sets rate-limit identity
    fields: str | None = Query(None, description=FIELDS_PARAM_DESC),
):
    """Get a single trace for a project.

    Defaults to the lightweight ``skeleton`` projection (no per-span I/O) — the
    dashboard relies on this for sub-MB payloads. Non-interactive callers (e.g.
    the agent trace download) pass ``fields=full`` to regain per-span
    input/output/metadata in a single read.

    Args:
        project_id (str): Project that owns the trace; scopes the read.
        trace_id (str): Trace to fetch.
        _access (RateLimitedProjectAccess): Dependency that validates the user's
            access to the project and sets rate-limit identity; not used directly.
        fields (str | None): Comma-separated projection groups (e.g. ``io``,
            ``metadata``) or an alias (``skeleton``/``full``). ``None`` selects
            the default `skeleton` projection.

    Returns:
        TraceDetailResponse: The trace with span skeletons, plus per-span I/O
            when the projection requests it.

    Raises:
        HTTPException: 400 if `fields` is invalid, 404 if the trace is missing.
    """
    try:
        groups = resolve_span_fields(fields, default=SKELETON)
    except InvalidFieldsError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e)) from e

    service = get_trace_reader_service()
    use_cache = _uses_dashboard_trace_cache(_access, groups=groups)
    trace = service.get_trace(project_id=project_id, trace_id=trace_id, use_cache=use_cache)

    if not trace:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Trace not found",
        )

    hydrate_span_io(service, trace, project_id=project_id, trace_id=trace_id, groups=groups)
    return trace


@router.get("/{trace_id}/spans/{span_id}/io", response_model=SpanIOResponse)
async def get_span_io(
    project_id: str,
    trace_id: str,
    span_id: str,
    _access: ProjectAccess,  # Validates user has access to project
):
    """Get full input/output/metadata for a single span on demand."""
    service = get_trace_reader_service()
    try:
        result = service.get_span_io(
            project_id=project_id,
            trace_id=trace_id,
            span_id=span_id,
        )

        if not result:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Span not found",
            )

        return result
    except HTTPException:
        raise
    except Exception as e:
        logger.exception(f"Error getting span I/O: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to get span I/O",
        ) from e
