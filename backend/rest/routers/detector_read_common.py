"""Shared handler bodies for the detector read surfaces.

The public (API-key) and internal (user/service) detector read routers expose
the same reads over the same service and response schemas; only the auth
source differs. Each router resolves auth and declares its params, then
delegates here, so retention and error-mapping semantics cannot drift between
the two surfaces. The reader's ClickHouse/Postgres clients are synchronous, so
every service call runs via ``asyncio.to_thread`` to keep it off the event loop.
"""

import asyncio
import logging
from collections.abc import Callable
from datetime import datetime

from fastapi import HTTPException, status

from rest.pagination import decode_cursor, encode_cursor
from rest.retention import clamp_retention_window, enforce_retention_by_time
from rest.schemas.public import (
    CursorPaginationMeta,
    DetectorDetail,
    FindingDetail,
    PublicDetectorListResponse,
    PublicFindingListResponse,
)
from rest.services.detector_reader import DetectorReaderService

logger = logging.getLogger(__name__)


def _decode_cursor_param(cursor: str | None) -> tuple[datetime, str] | None:
    """Decode an opaque cursor query param, mapping a bad token to a 422.

    Runs before the reader call so a malformed cursor is rejected as a client
    error instead of being swallowed by the reader-error -> 500 mapping.

    Args:
        cursor (str | None): Opaque token from ``meta.next_cursor``, if any.

    Returns:
        tuple[datetime, str] | None: The decoded keyset position, or None.
    """
    if cursor is None:
        return None
    try:
        return decode_cursor(cursor)
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail="Invalid cursor"
        ) from e


async def list_detectors_page(
    service: DetectorReaderService,
    project_id: str,
    limit: int,
    start_after: datetime | None,
    end_before: datetime | None,
    cursor: str | None,
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
        cursor (str | None): Opaque keyset cursor from a prior page's
            ``meta.next_cursor``; malformed tokens 422 before the reader runs.

    Returns:
        PublicDetectorListResponse: The page plus pagination meta.
    """
    cursor_key = _decode_cursor_param(cursor)
    try:
        items, total = await asyncio.to_thread(
            service.list_detectors,
            project_id=project_id,
            limit=limit,
            start_after=start_after,
            end_before=end_before,
            cursor=cursor_key,
        )
    except Exception as e:
        logger.exception(f"Error listing detectors: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to list detectors",
        ) from e

    next_cursor = (
        encode_cursor(items[-1].created_at, items[-1].detector_id) if len(items) == limit else None
    )
    return PublicDetectorListResponse(
        data=items,
        meta=CursorPaginationMeta(page=0, limit=limit, total=total, next_cursor=next_cursor),
    )


async def list_findings_page(
    service: DetectorReaderService,
    billing_plan: str,
    project_id: str,
    limit: int,
    start_after: datetime | None,
    end_before: datetime | None,
    detector: str | None,
    trace_id: str | None,
    cursor: str | None,
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
        cursor (str | None): Opaque keyset cursor from a prior page's
            ``meta.next_cursor``; malformed tokens 422 before the reader runs.

    Returns:
        PublicFindingListResponse: The page plus pagination meta.
    """
    cursor_key = _decode_cursor_param(cursor)
    start_after, end_before = clamp_retention_window(billing_plan, start_after, end_before)
    try:
        items, total = await asyncio.to_thread(
            service.list_findings,
            project_id=project_id,
            limit=limit,
            start_after=start_after,
            end_before=end_before,
            detector=detector,
            trace_id=trace_id,
            cursor=cursor_key,
        )
    except Exception as e:
        logger.exception(f"Error listing detector findings: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to list findings",
        ) from e

    next_cursor = (
        encode_cursor(items[-1].timestamp, items[-1].finding_id) if len(items) == limit else None
    )
    return PublicFindingListResponse(
        data=items,
        meta=CursorPaginationMeta(page=0, limit=limit, total=total, next_cursor=next_cursor),
    )


async def require_finding(
    fetch: Callable[[], FindingDetail | None], billing_plan: str
) -> FindingDetail:
    """Run a reader fetch, mapping None -> 404 and reader errors -> a clean 500.

    Args:
        fetch (Callable[[], FindingDetail | None]): Zero-arg reader call.
        billing_plan (str): Plan used for the retention-by-time check.

    Returns:
        FindingDetail: The finding, when present and inside the retention window.
    """
    try:
        finding = await asyncio.to_thread(fetch)
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


async def require_detector(fetch: Callable[[], DetectorDetail | None]) -> DetectorDetail:
    """Run a detector fetch, mapping None -> 404 and reader errors -> a clean 500.

    No retention check: the detector catalog is configuration, not telemetry.

    Args:
        fetch (Callable[[], DetectorDetail | None]): Zero-arg reader call.

    Returns:
        DetectorDetail: The detector, when it exists in the caller's project.
    """
    try:
        detector = await asyncio.to_thread(fetch)
    except Exception as e:
        logger.exception(f"Error reading detector: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to read detector",
        ) from e
    if detector is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Detector not found")
    return detector
