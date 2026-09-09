"""Public read API for detector findings.

Mirrors the public traces read stack (DualStampedAuth, READ-bucket rate limiting,
project-scoped reads). Authenticated by either an API key (which fixes its own
project) or a user session token (which names the project via ``project_id``); a
finding outside the resolved project simply isn't found (404). Handler bodies
live in rest.routers.detector_read_common, shared with the internal
project-scoped mirror, so behavior cannot drift between the surfaces.
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
from rest.routers.detector_read_common import (
    list_detectors_page,
    list_findings_page,
    require_detector,
    require_finding,
)
from rest.routers.public.deps import DualStampedAuth
from rest.schemas.public import (
    DetectorDetail,
    FindingDetail,
    PublicDetectorListResponse,
    PublicFindingListResponse,
)
from rest.services.detector_reader import DetectorReaderService, get_detector_reader_service

router = APIRouter(prefix="/public/detectors", tags=["Detectors (Public)"])


@router.get("", response_model=PublicDetectorListResponse, operation_id="list_detectors")
@limiter.shared_limit(
    resolve_limit, scope=BUCKET_READ, key_func=key_read, exempt_when=is_request_rate_limit_exempt
)
async def list_detectors(
    request: Request,
    response: Response,
    auth: DualStampedAuth,
    service: DetectorReaderService = Depends(get_detector_reader_service),
    limit: int = Query(50, ge=1, le=200, description="Items per page"),
    start_after: datetime | None = Query(
        None, description="Only detectors created at or after this time (inclusive, ISO 8601)"
    ),
    end_before: datetime | None = Query(
        None, description="Only detectors created before this time (exclusive, ISO 8601)"
    ),
):
    """List the detectors in the caller's project (newest first)."""
    return await list_detectors_page(service, auth.project_id, limit, start_after, end_before)


@router.get("/findings", response_model=PublicFindingListResponse, operation_id="list_findings")
@limiter.shared_limit(
    resolve_limit, scope=BUCKET_READ, key_func=key_read, exempt_when=is_request_rate_limit_exempt
)
async def list_findings(
    request: Request,
    response: Response,
    auth: DualStampedAuth,
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
    """List recent detector findings for the caller's project (newest first)."""
    return await list_findings_page(
        service,
        auth.billing_plan,
        auth.project_id,
        limit,
        start_after,
        end_before,
        detector,
        trace_id,
    )


@router.get("/findings/{finding_id}", response_model=FindingDetail, operation_id="get_finding")
@limiter.shared_limit(
    resolve_limit, scope=BUCKET_READ, key_func=key_read, exempt_when=is_request_rate_limit_exempt
)
async def get_finding(
    request: Request,
    response: Response,
    auth: DualStampedAuth,
    finding_id: str,
    service: DetectorReaderService = Depends(get_detector_reader_service),
):
    """Get a single finding by id for the key's project."""
    return await require_finding(
        lambda: service.get_finding(auth.project_id, finding_id), auth.billing_plan
    )


@router.get(
    "/traces/{trace_id}/finding", response_model=FindingDetail, operation_id="get_finding_by_trace"
)
@limiter.shared_limit(
    resolve_limit, scope=BUCKET_READ, key_func=key_read, exempt_when=is_request_rate_limit_exempt
)
async def get_finding_by_trace(
    request: Request,
    response: Response,
    auth: DualStampedAuth,
    trace_id: str,
    service: DetectorReaderService = Depends(get_detector_reader_service),
):
    """Get the finding for a single trace (findings are 1-per-trace)."""
    return await require_finding(
        lambda: service.get_finding_by_trace(auth.project_id, trace_id), auth.billing_plan
    )


# Registered last so the static /findings and /traces segments above always
# match before this single-segment path parameter.
@router.get("/{detector_id}", response_model=DetectorDetail, operation_id="get_detector")
@limiter.shared_limit(
    resolve_limit, scope=BUCKET_READ, key_func=key_read, exempt_when=is_request_rate_limit_exempt
)
async def get_detector(
    request: Request,
    response: Response,
    auth: DualStampedAuth,
    detector_id: str,
    service: DetectorReaderService = Depends(get_detector_reader_service),
):
    """Get one detector's full configuration for the key's project."""
    return await require_detector(lambda: service.get_detector(auth.project_id, detector_id))
