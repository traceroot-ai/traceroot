"""Detector read endpoints (user-authenticated, not public API).

Most routes are thin internal mirrors of the public detector reads so the
in-app agent's registry-bound tools can dispatch here with service auth.
Their payload shapes are shared with the public surface (rest.schemas.public)
and their params stay a superset of the public twins (enforced by
tests/rest/test_public_internal_parity.py). The preview route is a separate
user-facing, read-only tool for checking draft filters on one trace.
"""

import asyncio
import math
from datetime import datetime
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status
from pydantic import BaseModel, ConfigDict, Field, model_validator

from rest.rate_limit import (
    BUCKET_READ,
    is_request_rate_limit_exempt,
    key_read,
    limiter,
    resolve_limit,
)
from rest.retention import enforce_retention_by_time
from rest.routers.deps import RateLimitedProjectAccess
from rest.routers.detector_read_common import (
    list_detectors_page,
    list_findings_page,
    require_detector,
    require_finding,
)
from rest.schemas.public import (
    DetectorDetail,
    FindingDetail,
    PublicDetectorListResponse,
    PublicFindingListResponse,
)
from rest.services.detector_reader import DetectorReaderService, get_detector_reader_service
from rest.services.filters.translate import MAX_FILTERS, MAX_KEY_LENGTH, MAX_VALUE_LENGTH
from rest.services.trace_reader import get_trace_reader_service
from worker.detector_tasks import _eval_condition, _get_trace_summaries

router = APIRouter(prefix="/projects/{project_id}/detectors", tags=["Detectors"])


class PreviewCondition(BaseModel):
    model_config = ConfigDict(extra="forbid")

    field: str = Field(max_length=32)
    op: str = Field(max_length=16)
    value: Any
    key: str | None = None

    @model_validator(mode="after")
    def valid_trigger(self):
        # Mirror the detector editor's trigger registry. This endpoint accepts
        # draft conditions but never persists them.
        numeric = {"cost", "total_tokens", "duration_ms", "errors"}
        text = {"model_name", "environment", "metadata"}
        if self.field in numeric:
            if self.op not in {">", ">=", "<", "<=", "="}:
                raise ValueError("invalid numeric trigger operator")
            if type(self.value) not in (int, float) or (
                type(self.value) is float and not math.isfinite(self.value)
            ):
                raise ValueError("numeric trigger value required")
            if self.value < 0 or (
                self.field != "cost" and type(self.value) is float and not self.value.is_integer()
            ):
                raise ValueError("invalid numeric trigger value")
        elif self.field in text:
            allowed = {"=", "!=", "contains"} if self.field == "metadata" else {"=", "!="}
            if self.op not in allowed:
                raise ValueError("invalid text trigger operator")
            if not isinstance(self.value, str) or not 0 < len(self.value) <= MAX_VALUE_LENGTH:
                raise ValueError("text trigger value required")
        else:
            raise ValueError("unknown trigger field")

        if self.field == "metadata":
            if not isinstance(self.key, str) or not 0 < len(self.key.strip()) <= MAX_KEY_LENGTH:
                raise ValueError("metadata key required")
        elif self.key is not None:
            raise ValueError("key is only valid for metadata")
        return self


class FilterPreviewRequest(BaseModel):
    trace_id: str = Field(min_length=1, max_length=128)
    conditions: list[PreviewCondition] = Field(max_length=MAX_FILTERS)


class FilterPreviewResponse(BaseModel):
    trace_id: str
    matches: bool
    condition_matches: list[bool]


@router.get("", response_model=PublicDetectorListResponse)
@limiter.shared_limit(
    resolve_limit, scope=BUCKET_READ, key_func=key_read, exempt_when=is_request_rate_limit_exempt
)
async def list_detectors(
    request: Request,
    response: Response,
    project_id: str,
    _access: RateLimitedProjectAccess,
    service: DetectorReaderService = Depends(get_detector_reader_service),
    limit: int = Query(50, ge=1, le=200, description="Items per page"),
    start_after: datetime | None = Query(
        None, description="Only detectors created at or after this time (inclusive, ISO 8601)"
    ),
    end_before: datetime | None = Query(
        None, description="Only detectors created before this time (exclusive, ISO 8601)"
    ),
):
    """List the project's detectors (newest first)."""
    return await list_detectors_page(service, project_id, limit, start_after, end_before)


@router.get("/findings", response_model=PublicFindingListResponse)
@limiter.shared_limit(
    resolve_limit, scope=BUCKET_READ, key_func=key_read, exempt_when=is_request_rate_limit_exempt
)
async def list_findings(
    request: Request,
    response: Response,
    project_id: str,
    _access: RateLimitedProjectAccess,
    service: DetectorReaderService = Depends(get_detector_reader_service),
    limit: int = Query(50, ge=1, le=200, description="Items per page"),
    start_after: datetime | None = Query(
        None, description="Only findings at or after this time (inclusive, ISO 8601)"
    ),
    end_before: datetime | None = Query(
        None, description="Only findings before this time (exclusive, ISO 8601)"
    ),
    detector: str | None = Query(None, description="Filter by detector id, name, or template"),
    trace_id: str | None = Query(None, description="Filter to a single trace"),
):
    """List recent detector findings for the project (newest first)."""
    return await list_findings_page(
        service,
        _access.billing_plan,
        project_id,
        limit,
        start_after,
        end_before,
        detector,
        trace_id,
    )


@router.get("/findings/{finding_id}", response_model=FindingDetail)
@limiter.shared_limit(
    resolve_limit, scope=BUCKET_READ, key_func=key_read, exempt_when=is_request_rate_limit_exempt
)
async def get_finding(
    request: Request,
    response: Response,
    project_id: str,
    finding_id: str,
    _access: RateLimitedProjectAccess,
    service: DetectorReaderService = Depends(get_detector_reader_service),
):
    """Get a single finding by id, with per-detector results and RCA."""
    return await require_finding(
        lambda: service.get_finding(project_id, finding_id, _access.billing_plan),
        _access.billing_plan,
    )


@router.get("/traces/{trace_id}/finding", response_model=FindingDetail)
@limiter.shared_limit(
    resolve_limit, scope=BUCKET_READ, key_func=key_read, exempt_when=is_request_rate_limit_exempt
)
async def get_finding_by_trace(
    request: Request,
    response: Response,
    project_id: str,
    trace_id: str,
    _access: RateLimitedProjectAccess,
    service: DetectorReaderService = Depends(get_detector_reader_service),
):
    """Get the finding for a single trace (findings are 1-per-trace)."""
    return await require_finding(
        lambda: service.get_finding_by_trace(project_id, trace_id, _access.billing_plan),
        _access.billing_plan,
    )


# This read-only preview evaluates the draft conditions on one existing customer
# trace. It does not save a detector, sample traffic, enqueue work, or call a model.
@router.post("/preview", response_model=FilterPreviewResponse)
@limiter.shared_limit(
    resolve_limit, scope=BUCKET_READ, key_func=key_read, exempt_when=is_request_rate_limit_exempt
)
async def preview_filter(
    request: Request,
    response: Response,
    project_id: str,
    payload: FilterPreviewRequest,
    _access: RateLimitedProjectAccess,
):
    """Show which draft filter conditions match one retained customer trace."""
    trace = await asyncio.to_thread(
        get_trace_reader_service().get_trace,
        project_id=project_id,
        trace_id=payload.trace_id,
        source="user",
    )
    if trace is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Trace not found")
    enforce_retention_by_time(_access.billing_plan, trace.get("trace_start_time"))

    summary = await asyncio.to_thread(_get_trace_summaries, project_id, [payload.trace_id])
    selected = summary.get(payload.trace_id)
    if selected is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Trace not found")
    condition_matches = [
        _eval_condition(selected, condition.model_dump(exclude_none=True))
        for condition in payload.conditions
    ]
    return FilterPreviewResponse(
        trace_id=payload.trace_id,
        matches=all(condition_matches),
        condition_matches=condition_matches,
    )


# Registered last so the static /findings, /traces, and /preview segments above always
# match before this single-segment path parameter.
@router.get("/{detector_id}", response_model=DetectorDetail)
@limiter.shared_limit(
    resolve_limit, scope=BUCKET_READ, key_func=key_read, exempt_when=is_request_rate_limit_exempt
)
async def get_detector(
    request: Request,
    response: Response,
    project_id: str,
    detector_id: str,
    _access: RateLimitedProjectAccess,
    service: DetectorReaderService = Depends(get_detector_reader_service),
):
    """Get one detector's full configuration for the project."""
    return await require_detector(lambda: service.get_detector(project_id, detector_id))
