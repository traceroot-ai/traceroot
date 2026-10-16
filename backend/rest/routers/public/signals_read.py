"""Public read API for signals.

Mirrors the other public catalog reads (DualStampedAuth, READ-bucket rate
limiting, project-scoped reads). Authenticated by either an API key (which fixes
its own project) or a user credential (which names the project via
``project_id``); a signal outside the resolved project simply isn't found
(404). Handler bodies live in rest.routers.signal_read_common.
"""

from typing import Literal

from fastapi import APIRouter, Query, Request, Response

from rest.rate_limit import (
    BUCKET_READ,
    is_request_rate_limit_exempt,
    key_read,
    limiter,
    resolve_limit,
)
from rest.routers.public.deps import DualStampedAuth
from rest.routers.signal_read_common import get_signal_detail, list_signals_page
from rest.schemas.public import PublicSignalListResponse, SignalDetail

router = APIRouter(prefix="/public/signals", tags=["Signals"])


@router.get("", response_model=PublicSignalListResponse, operation_id="list_signals")
@limiter.shared_limit(
    resolve_limit, scope=BUCKET_READ, key_func=key_read, exempt_when=is_request_rate_limit_exempt
)
async def list_signals(
    request: Request,
    response: Response,
    auth: DualStampedAuth,
    limit: int = Query(50, ge=1, le=200, description="Items per page"),
    page: int = Query(0, ge=0, le=10_000, description="0-based page index"),
    status: Literal["open", "resolved", "dismissed"] | None = Query(
        None, description="Only signals with this status"
    ),
    detector_id: str | None = Query(None, description="Only signals of this detector"),
) -> PublicSignalListResponse:
    """List the signals in the caller's project (newest first). Merged signals are left out."""
    return await list_signals_page(auth.project_id, limit, page, status, detector_id)


@router.get("/{signal_id}", response_model=SignalDetail, operation_id="get_signal")
@limiter.shared_limit(
    resolve_limit, scope=BUCKET_READ, key_func=key_read, exempt_when=is_request_rate_limit_exempt
)
async def get_signal(
    request: Request,
    response: Response,
    auth: DualStampedAuth,
    signal_id: str,
) -> SignalDetail:
    """Get one signal of the caller's project. A merged signal names the signal it moved to."""
    return await get_signal_detail(auth.project_id, signal_id)
