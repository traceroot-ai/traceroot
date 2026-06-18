"""Public, API-key-authenticated trace read endpoints (for the CLI).

`GET /api/v1/public/traces` (list) and `GET /api/v1/public/traces/{trace_id}`
(get). Reads are scoped to the project the API key belongs to — the client
never supplies a project id. Kept separate from the ingestion route so read and
write concerns stay decoupled; both reuse the shared API-key auth dependency.
"""

import logging

from fastapi import APIRouter, HTTPException, Query, status

from rest.projection import (
    FIELDS_PARAM_DESC,
    FULL,
    SKELETON,
    InvalidFieldsError,
    hydrate_span_io,
    resolve_span_fields,
)
from rest.routers.public.deps import Auth
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
async def get_trace(
    auth: Auth,
    trace_id: str,
    fields: str | None = Query(None, description=FIELDS_PARAM_DESC),
):
    """Get a single trace for the key's project.

    Defaults to the lightweight `skeleton` projection (no per-span I/O); pass
    `fields=full` (or `fields=io,metadata`) for per-span input/output/metadata.
    """
    groups = _resolve_fields(fields, default=SKELETON)
    trace = _require_trace(auth.project_id, trace_id, groups)
    return public_trace_detail(trace, auth.project_id)


@router.get("/{trace_id}/export", response_model=PublicTraceExportResponse)
async def export_trace(
    auth: Auth,
    trace_id: str,
    fields: str | None = Query(None, description=FIELDS_PARAM_DESC),
):
    """Export the V1 bundle (trace + spans + git_context + manifest) for the key's project.

    Defaults to the `full` projection — an export is explicit intent to take the
    complete trace, so per-span input/output/metadata are included unless the
    caller narrows `fields`. `bundle.trace` equals the `traces get` payload at the
    same projection.
    """
    groups = _resolve_fields(fields, default=FULL)
    trace = _require_trace(auth.project_id, trace_id, groups)
    return export_bundle(trace, auth.project_id)


def _resolve_fields(fields: str | None, *, default: frozenset[str]) -> frozenset[str]:
    """Resolve the `fields` projection, mapping a bad value to 400 Bad Request."""
    try:
        return resolve_span_fields(fields, default=default)
    except InvalidFieldsError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e)) from e


def _require_trace(project_id: str, trace_id: str, groups: frozenset[str]) -> dict:
    """Fetch a trace scoped to the project at the requested projection.

    Centralizing the read here keeps `get` and `export` consistent: a reader
    failure is a controlled 500 (matching `list_traces`), a missing/cross-project
    trace is a 404, and internal exception text is never leaked to clients. The
    bulk span-I/O query runs only when the projection requests `io`/`metadata`,
    so the default skeleton read keeps the #1040 lightweight behavior.
    """
    try:
        service = get_trace_reader_service()
        trace = service.get_trace(project_id=project_id, trace_id=trace_id)
        if trace:
            hydrate_span_io(service, trace, project_id=project_id, trace_id=trace_id, groups=groups)
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
