"""Shared handler bodies for the dashboard read surfaces.

The public (dual-credential) and internal (project-scoped mirror) dashboard
read routers expose the same reads over the same response schemas; only the
auth source differs. Each router resolves auth, then delegates here, so the
proxy and error-mapping semantics cannot drift between the two surfaces.

The dashboard catalog lives in Postgres/Prisma, so both reads are delegated to
the Next.js internal routes (secret-authed, keyed by the resolved project id)
through the shared internal read proxy, which owns the passthrough (400/403/
404) and fail-closed (503) rules. Ids are never logged.
"""

import logging
from datetime import UTC, datetime
from typing import Any

from fastapi import HTTPException, status
from pydantic import ValidationError

from rest.retention import clamp_retention_window
from rest.routers.internal_read_proxy import post_internal_read, service_error
from rest.schemas.dashboards import QueryWindow, WidgetQueryRequest, WidgetQueryResponse
from rest.schemas.public import (
    DashboardDetail,
    DashboardListItem,
    DashboardWidgetItem,
    PublicDashboardListResponse,
)
from rest.services.date_presets import WindowSpecError, resolve_window
from rest.services.widget_query import WidgetSpecError, run_widget_query

logger = logging.getLogger(__name__)

_SERVICE = "Dashboard"


def _dashboard_service_error() -> HTTPException:
    """Build the controlled 503 for an ambiguous dashboard service response.

    Returns:
        HTTPException: A 503 with a generic ``Dashboard service error`` detail.
    """
    return service_error(_SERVICE)


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
    data = await post_internal_read(
        "/api/internal/project-dashboards", {"projectId": project_id}, service=_SERVICE
    )
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
    data = await post_internal_read(
        "/api/internal/project-dashboard",
        {"projectId": project_id, "dashboardId": dashboard_id},
        service=_SERVICE,
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
            bucket_seconds=body.bucket_seconds,
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
