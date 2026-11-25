"""Shared label eligibility and app trace-filter lookup."""

import asyncio
import logging
from collections.abc import Callable

import httpx
from fastapi import HTTPException, status
from pydantic import BaseModel, Field, StrictBool, ValidationError

from rest.retention import enforce_retention_by_time
from rest.routers.internal_read_proxy import service_error
from rest.services.trace_reader import get_trace_reader_service
from shared.config import settings

logger = logging.getLogger(__name__)

MAX_LABEL_LENGTH = 100
LABEL_LOOKUP_TIMEOUT_S = 10


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


async def find_labeled_trace_ids(
    project_id: str,
    value: str,
    *,
    trace_ids: list[str] | None = None,
    after_trace_id: str | None = None,
) -> LabeledTraceIds:
    """Look up a page of distinct label assignments in the Postgres control plane."""
    params: dict[str, str | list[str]] = {"projectId": project_id, "value": value}
    if after_trace_id is not None:
        params["afterTraceId"] = after_trace_id
    if trace_ids:
        params["traceId"] = trace_ids
    try:
        async with httpx.AsyncClient(timeout=LABEL_LOOKUP_TIMEOUT_S) as client:
            response = await client.get(
                f"{settings.traceroot_ui_url.rstrip('/')}/api/internal/labels",
                params=params,
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


async def resolve_labeled_trace_ids(
    project_id: str,
    value: str,
    trace_ids: list[str] | None,
    limit: int,
    match_batch: Callable[[list[str]], list[str]],
) -> list[str]:
    """Resolve a bounded label filter against the live trace scope when it could exceed the cap."""
    requested_ids = set(trace_ids) if trace_ids is not None else None
    after_trace_id = None
    seen_cursors: set[str] = set()
    matched: set[str] = set()
    try:
        async with asyncio.timeout(LABEL_LOOKUP_TIMEOUT_S):
            while True:
                batch = await find_labeled_trace_ids(
                    project_id, value, trace_ids=trace_ids, after_trace_id=after_trace_id
                )
                next_trace_id = batch.trace_ids[-1] if batch.trace_ids else None
                if batch.overflow:
                    if next_trace_id is None or next_trace_id in seen_cursors:
                        logger.error(
                            "Label lookup repeated an invalid cursor for project %s", project_id
                        )
                        raise service_error("Label")
                    seen_cursors.add(next_trace_id)
                # A control plane on the prior version can ignore requested IDs.
                candidates = batch.trace_ids
                if requested_ids is not None:
                    candidates = [trace_id for trace_id in candidates if trace_id in requested_ids]
                if after_trace_id is None and not batch.overflow and len(candidates) <= limit:
                    # The trace list applies the remaining scope to the IDs itself.
                    return candidates
                if candidates:
                    matched.update(await asyncio.to_thread(match_batch, candidates))
                if len(matched) > limit or not batch.overflow:
                    return sorted(matched)
                after_trace_id = next_trace_id
    except TimeoutError as e:
        logger.error("Label lookup exceeded its time budget in project %s", project_id)
        raise service_error("Label") from e
