"""Public read API for signals.

Mirrors the other public catalog reads (DualStampedAuth, READ-bucket rate
limiting, project-scoped reads). Authenticated by either an API key (which fixes
its own project) or a user credential (which names the project via
``project_id``); a signal outside the resolved project simply isn't found
(404).

Signals live in Postgres/Prisma, so both reads are delegated to the Next.js
internal ``project-signals`` route (secret-authed, keyed by the resolved project
id) through the shared internal read proxy, which owns the passthrough
(400/403/404) and fail-closed (503) rules. The Next side reuses the same core
list query as the web app, so the two surfaces cannot drift. Ids are never
logged.
"""

import logging
from typing import Any, Literal

from fastapi import APIRouter, Query, Request, Response
from pydantic import ValidationError

from rest.rate_limit import (
    BUCKET_READ,
    is_request_rate_limit_exempt,
    key_read,
    limiter,
    resolve_limit,
)
from rest.routers.internal_read_proxy import post_internal_read, service_error
from rest.routers.public.deps import DualStampedAuth
from rest.schemas.common import PaginationMeta
from rest.schemas.public import PublicSignalListResponse, SignalDetail, SignalSummary

logger = logging.getLogger(__name__)

_SERVICE = "Signal"
_INTERNAL_PATH = "/api/internal/project-signals"


def _summary_fields(signal: Any) -> dict[str, Any]:
    """Map one camelCase signal from the internal route to summary kwargs.

    Args:
        signal (Any): One signal object from the internal route's body.

    Returns:
        dict[str, Any]: Keyword arguments for :class:`SignalSummary`.

    Raises:
        KeyError: If a required field is missing (the caller fails closed).
        TypeError: If the item is not a mapping (the caller fails closed).
    """
    return {
        "signal_id": signal["id"],
        "detector_id": signal["detectorId"],
        "detector_name": signal["detectorName"],
        "title": signal["title"],
        "status": signal["status"],
        "hit_count": signal["hitCount"],
        "reopen_count": signal["reopenCount"],
        "first_seen_at": signal["firstSeenAt"],
        "last_seen_at": signal["lastSeenAt"],
        "created_at": signal["createTime"],
        "rca_state": signal.get("rcaState"),
    }


async def _list_signals_page(
    project_id: str, limit: int, page: int, status: str | None, detector_id: str | None
) -> PublicSignalListResponse:
    """List a project's signals via the internal route (newest first, merged left out).

    Args:
        project_id (str): The project the caller's credential resolved to.
        limit (int): Items per page.
        page (int): 0-based page index.
        status (str | None): Only signals with this status.
        detector_id (str | None): Only signals of this detector.

    Returns:
        PublicSignalListResponse: The page of signals plus pagination.

    Raises:
        HTTPException: 400 passed through; 503 (fail closed) on any upstream
            ambiguity, including an item missing a required field.
    """
    payload: dict[str, Any] = {"projectId": project_id, "limit": limit, "page": page}
    if status:
        payload["status"] = status
    if detector_id:
        payload["detectorId"] = detector_id
    data = await post_internal_read(_INTERNAL_PATH, payload, service=_SERVICE)
    signals = data.get("signals")
    meta = data.get("meta")
    if not isinstance(signals, list) or not isinstance(meta, dict):
        logger.error("Signal service returned a malformed listing body")
        raise service_error(_SERVICE)
    try:
        return PublicSignalListResponse(
            data=[SignalSummary(**_summary_fields(s)) for s in signals],
            meta=PaginationMeta(page=meta["page"], limit=meta["limit"], total=meta["total"]),
        )
    except (KeyError, TypeError, ValidationError) as e:
        raise service_error(_SERVICE) from e


async def _get_signal_detail(project_id: str, signal_id: str) -> SignalDetail:
    """Fetch one signal of a project via the internal route.

    Args:
        project_id (str): The project the caller's credential resolved to.
        signal_id (str): The signal to fetch.

    Returns:
        SignalDetail: The signal, with ``merged_into_id`` set when it was merged.

    Raises:
        HTTPException: 404 when the signal is not in the project; 503 (fail
            closed) on any upstream ambiguity.
    """
    data = await post_internal_read(
        _INTERNAL_PATH, {"projectId": project_id, "signalId": signal_id}, service=_SERVICE
    )
    signal = data.get("signal")
    if not isinstance(signal, dict):
        logger.error("Signal service returned a malformed detail body")
        raise service_error(_SERVICE)
    try:
        return SignalDetail(
            **_summary_fields(signal),
            resolved_at=signal["resolvedAt"],
            merged_into_id=signal["mergedIntoId"],
        )
    except (KeyError, TypeError, ValidationError) as e:
        raise service_error(_SERVICE) from e


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
    return await _list_signals_page(auth.project_id, limit, page, status, detector_id)


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
    return await _get_signal_detail(auth.project_id, signal_id)
