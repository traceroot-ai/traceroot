"""Detector read endpoints (user-authenticated, not public API).

Thin internal mirrors of the public detector reads so the in-app agent's
registry-bound tools can dispatch here with service auth. Payload shapes are
shared with the public surface (rest.schemas.public) by design — one registry
definition serves both. Params must stay a superset of the public twins
(enforced by tests/rest/test_public_internal_parity.py), and the handler
bodies live in rest.routers.detector_read_common so behavior cannot drift
between the surfaces.
"""

from datetime import datetime

from fastapi import APIRouter, Depends, Query, Request, Response

from rest.rate_limit import (
    BUCKET_READ,
    is_request_rate_limit_exempt,
    key_read,
    limiter,
    resolve_limit,
)
from rest.routers.deps import RateLimitedProjectAccess
from rest.routers.detector_read_common import (
    list_detectors_page,
    list_findings_page,
    require_finding,
)
from rest.schemas.public import (
    FindingDetail,
    PublicDetectorListResponse,
    PublicFindingListResponse,
)
from rest.services.detector_reader import DetectorReaderService, get_detector_reader_service

router = APIRouter(prefix="/projects/{project_id}/detectors", tags=["Detectors"])


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
        lambda: service.get_finding(project_id, finding_id), _access.billing_plan
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
        lambda: service.get_finding_by_trace(project_id, trace_id), _access.billing_plan
    )
