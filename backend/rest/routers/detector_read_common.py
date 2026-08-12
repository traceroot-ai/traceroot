"""Shared handler bodies for the detector read surfaces.

The public (API-key) and internal (user/service) detector read routers expose
the same reads over the same service and response schemas; only the auth
source differs. Each router resolves auth and declares its params, then
delegates here, so retention and error-mapping semantics cannot drift between
the two surfaces.
"""

import logging
from collections.abc import Callable
from datetime import datetime

from fastapi import HTTPException, status

from rest.retention import clamp_retention_window, enforce_retention_by_time
from rest.schemas.common import PaginationMeta
from rest.schemas.public import (
    FindingDetail,
    PublicDetectorListResponse,
    PublicFindingListResponse,
)
from rest.services.detector_reader import DetectorReaderService

logger = logging.getLogger(__name__)


def list_detectors_page(
    service: DetectorReaderService,
    project_id: str,
    limit: int,
    start_after: datetime | None,
    end_before: datetime | None,
) -> PublicDetectorListResponse:
    """List a project's detectors, mapping reader errors to a clean 500.

    The detector catalog is configuration, not telemetry, so no retention
    clamp applies.

    Args:
        service (DetectorReaderService): Reader resolved by the calling router.
        project_id (str): Project the calling router's auth resolved.
        limit (int): Max items in the returned page.
        start_after (datetime | None): Inclusive lower bound on creation time.
        end_before (datetime | None): Exclusive upper bound on creation time.

    Returns:
        PublicDetectorListResponse: The page plus pagination meta.
    """
    try:
        items, total = service.list_detectors(
            project_id=project_id,
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


def list_findings_page(
    service: DetectorReaderService,
    billing_plan: str,
    project_id: str,
    limit: int,
    start_after: datetime | None,
    end_before: datetime | None,
    detector: str | None,
    trace_id: str | None,
) -> PublicFindingListResponse:
    """List a project's findings with the plan's retention clamp applied.

    Args:
        service (DetectorReaderService): Reader resolved by the calling router.
        billing_plan (str): Plan whose retention window clamps ``start_after``.
        project_id (str): Project the calling router's auth resolved.
        limit (int): Max items in the returned page.
        start_after (datetime | None): Inclusive lower bound on ``timestamp``.
        end_before (datetime | None): Exclusive upper bound on ``timestamp``.
        detector (str | None): Optional detector id/name/template filter.
        trace_id (str | None): Optional single-trace filter.

    Returns:
        PublicFindingListResponse: The page plus pagination meta.
    """
    start_after, end_before = clamp_retention_window(billing_plan, start_after, end_before)
    try:
        items, total = service.list_findings(
            project_id=project_id,
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


def require_finding(fetch: Callable[[], FindingDetail | None], billing_plan: str) -> FindingDetail:
    """Run a reader fetch, mapping None -> 404 and reader errors -> a clean 500.

    Args:
        fetch (Callable[[], FindingDetail | None]): Zero-arg reader call.
        billing_plan (str): Plan used for the retention-by-time check.

    Returns:
        FindingDetail: The finding, when present and inside the retention window.
    """
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
