"""Shared handler bodies for the alert read surfaces.

The public (dual-credential) and internal (project-scoped mirror) alert read
routers expose the same reads over the same response schemas; only the auth
source differs. Each router resolves auth, then delegates here, so the proxy
and error-mapping semantics cannot drift between the two surfaces.

Alert rules live in Postgres/Prisma, so both reads are delegated to the
Next.js internal ``project-alerts`` route (secret-authed, keyed by the
resolved project id) through the shared internal read proxy, which owns the
passthrough (400/403/404) and fail-closed (503) rules. Ids are never logged.
"""

import logging
from typing import Any

from fastapi import HTTPException
from pydantic import ValidationError

from rest.routers.internal_read_proxy import post_internal_read, service_error
from rest.schemas.public import (
    AlertCapacity,
    AlertDetail,
    AlertListMeta,
    AlertRenotify,
    AlertSummary,
    PublicAlertListResponse,
)

logger = logging.getLogger(__name__)

_SERVICE = "Alert"
_INTERNAL_PATH = "/api/internal/project-alerts"


def _alert_service_error() -> HTTPException:
    """Build the controlled 503 for an ambiguous alert service response.

    Returns:
        HTTPException: A 503 with a generic ``Alert service error`` detail.
    """
    return service_error(_SERVICE)


def _summary_fields(alert: Any) -> dict[str, Any]:
    """Map one camelCase alert item from the internal route to summary kwargs.

    Args:
        alert (Any): One alert object from the internal route's body.

    Returns:
        dict[str, Any]: Keyword arguments for :class:`AlertSummary`.

    Raises:
        KeyError: If a required field is missing (the caller fails closed).
        TypeError: If the item is not a mapping (the caller fails closed).
    """
    return {
        "id": alert["id"],
        "name": alert["name"],
        "view": alert["view"],
        "measure": alert["measure"],
        "aggregation": alert["aggregation"],
        "window": alert["window"],
        "threshold_operator": alert["thresholdOperator"],
        "threshold": alert["threshold"],
        "status": alert["status"],
        "severity": alert["severity"],
        "severity_changed_at": alert["severityChangedAt"],
        "alerted_at": alert["alertedAt"],
        "last_evaluated_at": alert["lastEvaluatedAt"],
        "last_error": alert["lastError"],
        "last_error_at": alert["lastErrorAt"],
        "last_notify_status": alert["lastNotifyStatus"],
        "last_notify_error": alert["lastNotifyError"],
        "last_notify_at": alert["lastNotifyAt"],
        "create_time": alert["createTime"],
        "update_time": alert["updateTime"],
        "creator": alert["creator"],
    }


async def list_alerts_page(
    project_id: str, limit: int, page: int, search_query: str | None
) -> PublicAlertListResponse:
    """List a project's alerts via the internal route (creation order).

    Args:
        project_id (str): The project the caller's credential resolved to.
        limit (int): Items per page.
        page (int): 0-based page index.
        search_query (str | None): Case-insensitive substring match on the
            alert name.

    Returns:
        PublicAlertListResponse: The page of alerts plus pagination and the
            project's capacity against its per-project cap.

    Raises:
        HTTPException: 503 (fail closed) on any upstream ambiguity, including
            a listing item or the meta block missing a required field.
    """
    payload: dict[str, Any] = {"projectId": project_id, "limit": limit, "page": page}
    if search_query:
        payload["searchQuery"] = search_query
    data = await post_internal_read(_INTERNAL_PATH, payload, service=_SERVICE)
    alerts = data.get("alerts")
    meta = data.get("meta")
    if not isinstance(alerts, list) or not isinstance(meta, dict):
        logger.error("Alert service returned a malformed listing body")
        raise _alert_service_error()
    try:
        capacity = meta["capacity"]
        return PublicAlertListResponse(
            data=[AlertSummary(**_summary_fields(a)) for a in alerts],
            meta=AlertListMeta(
                page=meta["page"],
                limit=meta["limit"],
                total=meta["total"],
                capacity=AlertCapacity(used=capacity["used"], max=capacity["max"]),
            ),
        )
    except (KeyError, TypeError, ValidationError) as e:
        # An item missing a required field is a malformed upstream response →
        # fail closed with a controlled 503, never an uncaught 500.
        raise _alert_service_error() from e


async def get_alert_detail(project_id: str, alert_id: str) -> AlertDetail:
    """Fetch one alert with its full rule via the internal route.

    The internal route scopes the lookup through the project id, so an alert
    outside the resolved project simply isn't found — its 404 passes through.

    Args:
        project_id (str): The project the caller's credential resolved to.
        alert_id (str): The alert to fetch.

    Returns:
        AlertDetail: The alert's summary plus filters, renotify and gap mode.

    Raises:
        HTTPException: 404 passed through when the alert is not in the
            project; 503 (fail closed) on any upstream ambiguity.
    """
    data = await post_internal_read(
        _INTERNAL_PATH, {"projectId": project_id, "alertId": alert_id}, service=_SERVICE
    )
    try:
        alert: Any = data["alert"]
        renotify: Any = alert["renotify"]
        return AlertDetail(
            **_summary_fields(alert),
            filters=alert["filters"],
            # The stored rule is camelCase; the public surface renames so a
            # create request and a read answer spell the interval the same way.
            renotify=AlertRenotify(
                mode=renotify["mode"], interval_minutes=renotify.get("intervalMinutes")
            ),
            no_data_mode=alert["noDataMode"],
        )
    except (KeyError, TypeError, ValidationError, AttributeError) as e:
        raise _alert_service_error() from e
