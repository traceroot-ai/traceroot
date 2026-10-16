"""Shared handler bodies for the signal read surfaces.

Signals live in Postgres/Prisma, so both reads are delegated to the Next.js
internal ``project-signals`` route (secret-authed, keyed by the resolved project
id) through the shared internal read proxy, which owns the passthrough
(400/403/404) and fail-closed (503) rules. The Next side reuses the same core
list query as the web app, so the two surfaces cannot drift. Ids are never
logged.
"""

import logging
from typing import Any

from pydantic import ValidationError

from rest.routers.internal_read_proxy import post_internal_read, service_error
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


async def list_signals_page(
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


async def get_signal_detail(project_id: str, signal_id: str) -> SignalDetail:
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
