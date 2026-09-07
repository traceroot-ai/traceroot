"""Shared handler bodies for the dashboard read surfaces.

The public (dual-credential) and internal (project-scoped mirror) dashboard
read routers expose the same reads over the same response schemas; only the
auth source differs. Each router resolves auth, then delegates here, so the
proxy and error-mapping semantics cannot drift between the two surfaces.

The dashboard catalog lives in Postgres/Prisma, so both reads are delegated to
the Next.js internal routes (secret-authed, keyed by the resolved project id).
Client errors the internal route owns (400/403/404) pass through with the
upstream ``error`` string as the public ``detail``; everything ambiguous — a
network error, an upstream 401 (our own secret being rejected), an unexpected
status, or a malformed body — fails closed as a controlled 503 (parity with
the account-read and write-proxy siblings). Ids are never logged.
"""

import logging
from datetime import UTC, datetime
from typing import Any

import httpx
from fastapi import HTTPException, status
from pydantic import ValidationError

from rest.retention import clamp_retention_window
from rest.schemas.dashboards import QueryWindow, WidgetQueryRequest, WidgetQueryResponse
from rest.schemas.public import (
    DashboardDetail,
    DashboardListItem,
    DashboardWidgetItem,
    PublicDashboardListResponse,
)
from rest.services.date_presets import WindowSpecError, resolve_window
from rest.services.widget_query import WidgetSpecError, run_widget_query
from shared.config import settings

logger = logging.getLogger(__name__)

# Generic per-status fallbacks for a passthrough status whose upstream body
# carries no usable ``error`` string — the raw body is never surfaced.
_PASSTHROUGH_FALLBACKS = {
    status.HTTP_400_BAD_REQUEST: "Invalid request",
    status.HTTP_403_FORBIDDEN: "Forbidden",
    status.HTTP_404_NOT_FOUND: "Not found",
}


def _dashboard_service_error() -> HTTPException:
    """Build the controlled 503 used whenever the dashboard service is ambiguous.

    A shared fail-closed error so any upstream ambiguity — an unexpected
    status, malformed JSON, or a body missing a required field — surfaces as a
    503, never an uncaught 500 (parity with the account-read sibling).

    Returns:
        HTTPException: A 503 with a generic ``Dashboard service error`` detail.
    """
    return HTTPException(
        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        detail="Dashboard service error",
    )


async def _post_internal_read(path: str, payload: dict) -> dict:
    """POST a read to an internal dashboard route and return its success body.

    Args:
        path (str): Internal route path (appended to the UI base URL), e.g.
            ``"/api/internal/project-dashboards"``.
        payload (dict): The camelCase JSON body to POST (resolved project /
            dashboard ids; never logged).

    Returns:
        dict: The parsed 200 response body.

    Raises:
        HTTPException: 400/403/404 passed through from the internal route with
            its own ``error`` string as ``detail``; 503 (fail closed) on a
            network error, an upstream 401, any other unexpected status, or a
            malformed body.
    """
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.post(
                f"{settings.traceroot_ui_url}{path}",
                json=payload,
                headers={"X-Internal-Secret": settings.internal_api_secret},
            )
    except httpx.RequestError as e:
        logger.error(f"Failed to reach the dashboard service: {e}")
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Dashboard service unavailable",
        ) from e

    if response.status_code in _PASSTHROUGH_FALLBACKS:
        fallback = _PASSTHROUGH_FALLBACKS[response.status_code]
        try:
            body = response.json()
        except ValueError:
            body = None
        error = body.get("error") if isinstance(body, dict) else None
        raise HTTPException(
            status_code=response.status_code,
            detail=error if isinstance(error, str) and error else fallback,
        )

    if response.status_code != 200:
        # Includes 401: the internal secret is this service's own credential,
        # so an upstream rejection of it is our misconfiguration — an outage
        # from the caller's point of view, never their auth failing.
        logger.error(f"Unexpected response from the dashboard service: {response.status_code}")
        raise _dashboard_service_error()

    try:
        data = response.json()
    except ValueError as e:
        logger.error(f"Malformed JSON from the dashboard service: {e}")
        raise _dashboard_service_error() from e

    if not isinstance(data, dict):
        logger.error("Dashboard service returned a non-object JSON body")
        raise _dashboard_service_error()

    return data


async def list_dashboards_page(project_id: str) -> PublicDashboardListResponse:
    """List a project's dashboards via the internal listing route.

    A pure read: unlike the cookie route, it never lazily seeds the default
    dashboard — a project with none simply lists as empty.

    Args:
        project_id (str): The project the caller's credential resolved to.

    Returns:
        PublicDashboardListResponse: The project's dashboards (default first).

    Raises:
        HTTPException: 503 (fail closed) on any upstream ambiguity, including
            a listing item missing a required field.
    """
    data = await _post_internal_read("/api/internal/project-dashboards", {"projectId": project_id})
    dashboards = data.get("dashboards")
    if not isinstance(dashboards, list):
        logger.error("Dashboard service returned a malformed listing body")
        raise _dashboard_service_error()
    try:
        items = [
            DashboardListItem(
                id=d["id"],
                name=d["name"],
                description=d["description"],
                is_default=d["isDefault"],
                creator=d["creator"],
                create_time=d["createTime"],
                update_time=d["updateTime"],
                widget_count=d["widgetCount"],
            )
            for d in dashboards
        ]
    except (KeyError, TypeError, ValidationError) as e:
        # An item missing a required field is a malformed upstream response →
        # fail closed with a controlled 503, never an uncaught 500.
        raise _dashboard_service_error() from e
    return PublicDashboardListResponse(data=items)


async def get_dashboard_detail(project_id: str, dashboard_id: str) -> DashboardDetail:
    """Fetch one dashboard (with widgets) via the internal detail route.

    The internal route scopes the lookup through the project id, so a
    dashboard outside the resolved project simply isn't found — its 404 passes
    through.

    Args:
        project_id (str): The project the caller's credential resolved to.
        dashboard_id (str): The dashboard to fetch.

    Returns:
        DashboardDetail: The dashboard plus its widgets (creation order).

    Raises:
        HTTPException: 404 passed through when the dashboard is not in the
            project; 503 (fail closed) on any upstream ambiguity.
    """
    data = await _post_internal_read(
        "/api/internal/project-dashboard",
        {"projectId": project_id, "dashboardId": dashboard_id},
    )
    try:
        dashboard: Any = data["dashboard"]
        return DashboardDetail(
            id=dashboard["id"],
            name=dashboard["name"],
            description=dashboard["description"],
            is_default=dashboard["isDefault"],
            creator=dashboard["creator"],
            create_time=dashboard["createTime"],
            update_time=dashboard["updateTime"],
            widgets=[
                DashboardWidgetItem(
                    id=w["id"],
                    title=w["title"],
                    type=w["type"],
                    spec=w["spec"],
                    create_time=w["createTime"],
                )
                for w in dashboard["widgets"]
            ],
        )
    except (KeyError, TypeError, ValidationError) as e:
        raise _dashboard_service_error() from e


def _as_utc(value: datetime) -> datetime:
    """Return ``value`` as an aware UTC datetime (a naive one is read as UTC)."""
    return value.replace(tzinfo=UTC) if value.tzinfo is None else value.astimezone(UTC)


def run_widget_query_page(body: WidgetQueryRequest, project_id: str, billing_plan: str) -> dict:
    """Answer one widget query for the window the caller described.

    The shared body of the public ``run_widget_query`` and the internal
    ``/widgets/query`` mirror: resolve the window (preset or explicit bounds),
    clamp it to the plan's retention before any scan, run the spec, and echo
    the window it was answered for so a clamped or defaulted answer says so.

    Args:
        body (WidgetQueryRequest): The spec plus a window description.
        project_id (str): The project the caller's credential resolved to.
        billing_plan (str): The plan whose retention bounds the window.

    Returns:
        dict: A ``WidgetQueryResponse``-shaped dict — the engine's ``columns``,
            ``rows`` and ``meta`` plus the answered ``window``.

    Raises:
        HTTPException: 422 when the window description or the spec is invalid
            (the spec error carries its ``step``); 500 when the query fails.
    """
    try:
        start, end, range_id = resolve_window(body.range, body.start_time, body.end_time)
    except WindowSpecError as e:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail=str(e)) from e
    # Retention gate: clamp the start to the plan's cutoff before any
    # ClickHouse scan, so aggregates can't reach past the retention window
    # (mirrors the list endpoints; unlimited plans pass through unchanged).
    clamped_start, clamped_end = clamp_retention_window(billing_plan, start, end)
    assert clamped_start is not None and clamped_end is not None  # a start was given
    window = QueryWindow(
        start_time=_as_utc(clamped_start),
        end_time=_as_utc(clamped_end),
        range=range_id,
        clamped=_as_utc(clamped_start) != start,
    )
    try:
        result = run_widget_query(
            spec=body.spec,
            project_id=project_id,
            start_time=clamped_start,
            end_time=clamped_end,
        )
    except WidgetSpecError as e:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail={"step": e.step, "message": e.message},
        ) from e
    except Exception as e:
        logger.exception(f"Widget query failed: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Widget query failed",
        ) from e
    return WidgetQueryResponse(**result, window=window).model_dump()
