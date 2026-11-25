"""Shared label eligibility and app trace-filter lookup."""

import asyncio
import logging

import httpx
from fastapi import HTTPException, status
from pydantic import BaseModel, Field, StrictBool, ValidationError

from rest.retention import enforce_retention_by_time
from rest.routers.internal_read_proxy import service_error
from rest.services.trace_reader import get_trace_reader_service
from shared.config import settings

logger = logging.getLogger(__name__)

MAX_LABEL_LENGTH = 100


async def require_label_target(
    project_id: str, trace_id: str, span_id: str | None, billing_plan: str
) -> None:
    """Require an existing production trace or a span in that trace within retention."""
    try:
        service = get_trace_reader_service()
        start_time = await asyncio.to_thread(
            service.get_label_target_start_time, project_id, trace_id, span_id
        )
    except Exception as e:
        logger.exception("Failed to verify label target in project %s", project_id)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to verify label target",
        ) from e
    if start_time is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Label target not found")
    enforce_retention_by_time(billing_plan, start_time)


class LabeledTraceIds(BaseModel):
    """Project-scoped parent trace IDs returned by the label service."""

    trace_ids: list[str] = Field(alias="traceIds")
    overflow: StrictBool


async def find_labeled_trace_ids(project_id: str, value: str) -> LabeledTraceIds:
    """Look up label assignments in the Postgres control plane."""
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.get(
                f"{settings.traceroot_ui_url.rstrip('/')}/api/internal/labels",
                params={"projectId": project_id, "value": value},
                headers={"X-Internal-Secret": settings.internal_api_secret},
            )
        response.raise_for_status()
        return LabeledTraceIds.model_validate_json(response.content)
    except (httpx.HTTPError, ValidationError) as e:
        upstream_status = e.response.status_code if isinstance(e, httpx.HTTPStatusError) else None
        logger.error(
            "Label lookup failed in project %s: %s (upstream status: %s)",
            project_id,
            type(e).__name__,
            upstream_status,
        )
        raise service_error("Label") from e
