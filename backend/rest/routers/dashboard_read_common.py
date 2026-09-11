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
from typing import Any

from fastapi import HTTPException
from pydantic import ValidationError

from rest.routers.internal_read_proxy import post_internal_read, service_error
from rest.schemas.public import (
    DashboardDetail,
    DashboardListItem,
    DashboardWidgetItem,
    PublicDashboardListResponse,
)

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
