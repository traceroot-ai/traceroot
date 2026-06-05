"""Public, API-key-authenticated trace read endpoints (for the CLI).

`GET /api/v1/public/traces` (list) and `GET /api/v1/public/traces/{trace_id}`
(get). Reads are scoped to the project the API key belongs to — the client
never supplies a project id. Kept separate from the ingestion route so read and
write concerns stay decoupled; both reuse the shared API-key auth dependency.
"""

import logging

from fastapi import APIRouter, HTTPException, Query, status

from rest.routers.public.deps import Auth
from rest.schemas.public import PublicTraceDetailResponse, PublicTraceListResponse
from rest.services.trace_reader import get_trace_reader_service
from rest.url_utils import build_trace_url
from shared.config import settings

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/public/traces", tags=["Traces (Public)"])


@router.get("", response_model=PublicTraceListResponse)
async def list_traces(
    auth: Auth,
    limit: int = Query(50, ge=1, le=200, description="Items per page"),
):
    """List recent traces for the API key's project (newest first)."""
    try:
        service = get_trace_reader_service()
        result = service.list_traces(project_id=auth.project_id, limit=limit)
    except Exception as e:
        logger.exception(f"Error listing traces: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to list traces",
        ) from e

    for item in result["data"]:
        item["trace_url"] = build_trace_url(
            settings.traceroot_public_ui_url, auth.project_id, item["trace_id"]
        )
    return result


@router.get("/{trace_id}", response_model=PublicTraceDetailResponse)
async def get_trace(auth: Auth, trace_id: str):
    """Get a single trace (full payload, including spans) for the key's project."""
    try:
        service = get_trace_reader_service()
        trace = service.get_trace(project_id=auth.project_id, trace_id=trace_id)
    except Exception as e:
        logger.exception(f"Error getting trace: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to get trace",
        ) from e

    if not trace:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Trace not found",
        )

    trace["trace_url"] = build_trace_url(
        settings.traceroot_public_ui_url, auth.project_id, trace_id
    )
    return trace
