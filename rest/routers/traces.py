"""Trace query endpoints (user-authenticated, not public API)."""

import logging

from fastapi import APIRouter, HTTPException, Query, status

from rest.config.traces import TraceDetailResponse, TraceListResponse
from rest.routers.deps import ProjectAccess
from rest.services.trace_reader import get_trace_reader_service

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/projects/{project_id}/traces", tags=["Traces"])


@router.get("", response_model=TraceListResponse)
async def list_traces(
    project_id: str,
    _access: ProjectAccess,  # Validates user has access to project
    page: int = Query(0, ge=0, description="Page number (0-indexed)"),
    limit: int = Query(50, ge=1, le=100, description="Items per page"),
    name: str | None = Query(None, description="Filter by trace name (partial match)"),
):
    """List traces for a project with pagination."""
    try:
        service = get_trace_reader_service()
        result = service.list_traces(
            project_id=project_id,
            page=page,
            limit=limit,
            name=name,
        )
        return result
    except Exception as e:
        logger.exception(f"Error listing traces: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to list traces",
        )


@router.get("/{trace_id}", response_model=TraceDetailResponse)
async def get_trace(
    project_id: str,
    trace_id: str,
    _access: ProjectAccess,  # Validates user has access to project
):
    """Get a single trace with all spans."""
    service = get_trace_reader_service()
    trace = service.get_trace(project_id=project_id, trace_id=trace_id)

    if not trace:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Trace not found",
        )

    return trace
