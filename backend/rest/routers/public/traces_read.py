"""Public, API-key-authenticated trace read endpoints (for the CLI).

`GET /api/v1/public/traces` (list) and `GET /api/v1/public/traces/{trace_id}`
(get). Reads are scoped to the project the API key belongs to — the client
never supplies a project id. Kept separate from the ingestion route so read and
write concerns stay decoupled; both reuse the shared API-key auth dependency.
"""

import logging

from fastapi import APIRouter, HTTPException, Query, Request, Response, status

from rest.rate_limit import (
    BUCKET_READ,
    is_request_rate_limit_exempt,
    key_export,
    key_read,
    limiter,
    resolve_limit,
)
from rest.routers.public.deps import StampedAuth
from rest.routers.public.serialize import export_bundle, public_trace_detail
from rest.schemas.public import (
    PublicTraceDetailResponse,
    PublicTraceExportResponse,
    PublicTraceListResponse,
)
from rest.services.trace_reader import get_trace_reader_service
from rest.url_utils import build_trace_url
from shared.config import settings

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/public/traces", tags=["Traces (Public)"])


@router.get("", response_model=PublicTraceListResponse)
@limiter.shared_limit(
    resolve_limit, scope=BUCKET_READ, key_func=key_read, exempt_when=is_request_rate_limit_exempt
)
async def list_traces(
    request: Request,
    response: Response,
    auth: StampedAuth,
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
@limiter.shared_limit(
    resolve_limit, scope=BUCKET_READ, key_func=key_read, exempt_when=is_request_rate_limit_exempt
)
async def get_trace(request: Request, response: Response, auth: StampedAuth, trace_id: str):
    """Get a single trace (full payload, including spans) for the key's project."""
    trace = _require_trace(auth.project_id, trace_id)
    return public_trace_detail(trace, auth.project_id)


@router.get("/{trace_id}/export", response_model=PublicTraceExportResponse)
@limiter.limit(resolve_limit, key_func=key_export, exempt_when=is_request_rate_limit_exempt)
async def export_trace(request: Request, response: Response, auth: StampedAuth, trace_id: str):
    """Export the V1 bundle (trace + spans + git_context + manifest) for the key's project.

    `bundle.trace` is identical to the `traces get` payload for the same trace.

    Rate limited on its own `export` bucket because it builds and serializes the
    full bundle.
    """
    trace = _require_trace(auth.project_id, trace_id)
    return export_bundle(trace, auth.project_id)


def _require_trace(project_id: str, trace_id: str) -> dict:
    """Fetch a trace scoped to the project, or raise 404 (500 on reader failure).

    Centralizing the read here keeps `get` and `export` consistent: a reader
    failure is a controlled 500 (matching `list_traces`), a missing/cross-project
    trace is a 404, and internal exception text is never leaked to clients.
    """
    try:
        service = get_trace_reader_service()
        trace = service.get_trace(project_id=project_id, trace_id=trace_id)
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
    return trace
