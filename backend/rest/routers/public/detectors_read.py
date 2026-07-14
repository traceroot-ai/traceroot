"""Public, API-key-authenticated read API for detector findings.

Mirrors the public traces read stack (StampedAuth, READ-bucket rate limiting,
project-scoped reads). All access is scoped to the project resolved from the API
key; a finding outside that project simply isn't found (404).
"""

import logging
from collections.abc import Callable
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status

from rest.rate_limit import (
    BUCKET_READ,
    is_request_rate_limit_exempt,
    key_read,
    limiter,
    resolve_limit,
)
from rest.retention import enforce_retention_by_time, enforce_retention_window
from rest.routers.public.deps import StampedAuth
from rest.schemas.common import PaginationMeta
from rest.schemas.public import (
    FindingDetail,
    PublicDetectorListResponse,
    PublicFindingListResponse,
)
from rest.services.detector_reader import DetectorReaderService, get_detector_reader_service

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/public/detectors", tags=["Detectors (Public)"])


@router.get("", response_model=PublicDetectorListResponse)
@limiter.shared_limit(
    resolve_limit, scope=BUCKET_READ, key_func=key_read, exempt_when=is_request_rate_limit_exempt
)
async def list_detectors(
    request: Request,
    response: Response,
    auth: StampedAuth,
    service: DetectorReaderService = Depends(get_detector_reader_service),
    limit: int = Query(50, ge=1, le=200, description="Items per page"),
    start_after: datetime | None = Query(
        None, description="Only detectors created at or after this time (inclusive, ISO 8601)"
    ),
    end_before: datetime | None = Query(
        None, description="Only detectors created before this time (exclusive, ISO 8601)"
    ),
):
    """List the detectors in the API key's project (newest first)."""
    start_after, end_before = enforce_retention_window(auth.billing_plan, start_after, end_before)
    try:
        items, total = service.list_detectors(
            project_id=auth.project_id,
            limit=limit,
            start_after=start_after,
            end_before=end_before,
        )
    except Exception as e:
        logger.exception(f"Error listing detectors: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to list detectors",
        ) from e

    return PublicDetectorListResponse(
        data=items, meta=PaginationMeta(page=0, limit=limit, total=total)
    )


@router.get("/findings", response_model=PublicFindingListResponse)
@limiter.shared_limit(
    resolve_limit, scope=BUCKET_READ, key_func=key_read, exempt_when=is_request_rate_limit_exempt
)
async def list_findings(
    request: Request,
    response: Response,
    auth: StampedAuth,
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
    """List recent detector findings for the API key's project (newest first)."""
    start_after, end_before = enforce_retention_window(auth.billing_plan, start_after, end_before)
    try:
        items, total = service.list_findings(
            project_id=auth.project_id,
            limit=limit,
            start_after=start_after,
            end_before=end_before,
            detector=detector,
            trace_id=trace_id,
        )
    except Exception as e:
        logger.exception(f"Error listing detector findings: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to list findings",
        ) from e

    return PublicFindingListResponse(
        data=items, meta=PaginationMeta(page=0, limit=limit, total=total)
    )


@router.get("/findings/{finding_id}", response_model=FindingDetail)
@limiter.shared_limit(
    resolve_limit, scope=BUCKET_READ, key_func=key_read, exempt_when=is_request_rate_limit_exempt
)
async def get_finding(
    request: Request,
    response: Response,
    auth: StampedAuth,
    finding_id: str,
    service: DetectorReaderService = Depends(get_detector_reader_service),
):
    """Get a single finding by id for the key's project."""
    return _require_finding(
        lambda: service.get_finding(auth.project_id, finding_id), auth.billing_plan
    )


@router.get("/traces/{trace_id}/finding", response_model=FindingDetail)
@limiter.shared_limit(
    resolve_limit, scope=BUCKET_READ, key_func=key_read, exempt_when=is_request_rate_limit_exempt
)
async def get_finding_by_trace(
    request: Request,
    response: Response,
    auth: StampedAuth,
    trace_id: str,
    service: DetectorReaderService = Depends(get_detector_reader_service),
):
    """Get the finding for a single trace (findings are 1-per-trace)."""
    return _require_finding(
        lambda: service.get_finding_by_trace(auth.project_id, trace_id), auth.billing_plan
    )


def _require_finding(fetch: Callable[[], FindingDetail | None], billing_plan: str) -> FindingDetail:
    """Run a reader fetch, mapping None -> 404 and reader errors -> a clean 500."""
    try:
        finding = fetch()
    except Exception as e:
        logger.exception(f"Error reading detector finding: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to read finding",
        ) from e
    if finding is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Finding not found")
    enforce_retention_by_time(billing_plan, finding.timestamp)
    return finding
