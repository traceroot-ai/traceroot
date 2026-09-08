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

import asyncio
import logging
from datetime import datetime
from typing import Any

from fastapi import HTTPException, status
from pydantic import ValidationError

from rest.retention import clamp_retention_window
from rest.routers.internal_read_proxy import post_internal_read, service_error
from rest.schemas.dashboards import (
    QueryWindow,
    WidgetQueryRequest,
    WidgetQueryResponse,
    WidgetSpec,
)
from rest.schemas.public import (
    DashboardDataResponse,
    DashboardDetail,
    DashboardListItem,
    DashboardSummary,
    DashboardWidgetData,
    DashboardWidgetItem,
    PublicDashboardListResponse,
)
from rest.services.date_presets import WindowSpecError, as_utc, resolve_window
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


def _resolve_window_for_plan(
    range_id: str | None,
    start_time: datetime | None,
    end_time: datetime | None,
    billing_plan: str,
) -> tuple[datetime, datetime, QueryWindow]:
    """Resolve a caller's window description and clamp it to the plan's retention.

    Args:
        range_id (str | None): A preset id, or None for explicit bounds/default.
        start_time (datetime | None): Explicit lower bound, if any.
        end_time (datetime | None): Explicit upper bound, if any.
        billing_plan (str): The plan whose retention bounds the window.

    Returns:
        tuple[datetime, datetime, QueryWindow]: The bounds to query with (the
            start pulled to the retention cutoff when it fell before it) and
            the window to echo, with ``clamped`` set when that happened.

    Raises:
        HTTPException: 422 when the window description is invalid, or when the
            whole window lies before the plan's retention cutoff — clamping
            would invert it, and a query engine error blaming the caller's
            bounds would be the wrong message.
    """
    try:
        start, end, resolved_id = resolve_window(range_id, start_time, end_time)
    except WindowSpecError as e:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail=str(e)) from e
    # Retention gate: clamp the start to the plan's cutoff before any
    # ClickHouse scan, so aggregates can't reach past the retention window
    # (mirrors the list endpoints; unlimited plans pass through unchanged).
    # A start was given, so the clamp returns one; the Optional is for the
    # list endpoints' open-ended windows.
    clamped_start_opt, _ = clamp_retention_window(billing_plan, start, end)
    clamped_start = as_utc(clamped_start_opt if clamped_start_opt is not None else start)
    if clamped_start >= end:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail=(
                "the window ends before the plan's retention cutoff "
                f"({clamped_start.isoformat()}); nothing in it can be read"
            ),
        )
    window = QueryWindow(
        start_time=clamped_start,
        end_time=end,
        range=resolved_id,
        clamped=clamped_start != start,
    )
    return clamped_start, end, window


async def run_widget_query_page(
    body: WidgetQueryRequest, project_id: str, billing_plan: str
) -> WidgetQueryResponse:
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
        WidgetQueryResponse: The engine's ``columns``, ``rows`` and ``meta``
            plus the answered ``window``.

    Raises:
        HTTPException: 422 when the window description or the spec is invalid
            (the spec error carries its ``step``); 500 when the query fails.
    """
    start, end, window = _resolve_window_for_plan(
        body.range, body.start_time, body.end_time, billing_plan
    )
    try:
        # The engine is synchronous; keep it off the event loop like every
        # other ClickHouse read on the public surface.
        result = await asyncio.to_thread(
            run_widget_query,
            spec=body.spec,
            project_id=project_id,
            start_time=start,
            end_time=end,
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
    return WidgetQueryResponse(**result, window=window)


# A dashboard data read answers every query widget at once, so it is bounded
# three ways: rows per widget (a table widget can return hundreds; a caller
# summarizing a dashboard needs the shape, not the tail), queries in flight
# per request (twelve tiles must not open twelve ClickHouse connections at
# once — concurrent requests are bounded by the READ rate bucket, not here),
# and per-widget failure isolation (one stale spec must not fail the dashboard).
DASHBOARD_DATA_ROW_CAP = 25
DASHBOARD_DATA_CONCURRENCY = 4


def _widget_error(widget: DashboardWidgetItem, reason: str) -> DashboardWidgetData:
    return DashboardWidgetData(
        id=widget.id, title=widget.title, type=widget.type, status="error", error=reason
    )


async def _answer_widget(
    widget: DashboardWidgetItem,
    project_id: str,
    start: datetime,
    end: datetime,
    gate: asyncio.Semaphore,
) -> DashboardWidgetData:
    """Answer one widget for the window, never raising: every outcome is a status."""
    if widget.type != "query":
        return DashboardWidgetData(
            id=widget.id, title=widget.title, type=widget.type, status="skipped"
        )
    try:
        spec = WidgetSpec.model_validate(widget.spec)
    except ValidationError as e:
        problems = "; ".join(
            f"{'.'.join(str(part) for part in err['loc'])}: {err['msg']}" for err in e.errors()[:3]
        )
        return _widget_error(widget, f"spec: {problems}")
    try:
        async with gate:
            result = await asyncio.to_thread(
                run_widget_query,
                spec=spec,
                project_id=project_id,
                start_time=start,
                end_time=end,
            )
    except WidgetSpecError as e:
        return _widget_error(widget, f"{e.step}: {e.message}")
    except Exception as e:
        logger.exception(f"Dashboard widget query failed: {e}")
        return _widget_error(widget, "Widget query failed")
    rows = result["rows"]
    return DashboardWidgetData(
        id=widget.id,
        title=widget.title,
        type=widget.type,
        status="ok",
        columns=result["columns"],
        rows=rows[:DASHBOARD_DATA_ROW_CAP],
        meta=result.get("meta", {}),
        truncated=len(rows) > DASHBOARD_DATA_ROW_CAP,
    )


async def get_dashboard_data_page(
    project_id: str,
    dashboard_id: str,
    billing_plan: str,
    range_id: str | None,
    start_time: datetime | None,
    end_time: datetime | None,
    *,
    caller_kind: str,
) -> DashboardDataResponse:
    """Answer every query widget on a dashboard for one window.

    The shared body of the public ``get_dashboard_data`` and the internal
    ``/dashboards/{dashboard_id}/data`` mirror. The window is resolved and
    clamped first (a malformed window is a 422 before anything is fetched),
    then the dashboard is read through the internal detail route and each
    query widget runs under a concurrency gate; feeds are listed as skipped
    and a failing widget becomes an inline error, so the dashboard's order and
    count are always intact.

    Args:
        project_id (str): The project the caller's credential resolved to.
        dashboard_id (str): The dashboard to answer.
        billing_plan (str): The plan whose retention bounds the window.
        range_id (str | None): A preset id, or None for explicit bounds/default.
        start_time (datetime | None): Explicit lower bound, if any.
        end_time (datetime | None): Explicit upper bound, if any.
        caller_kind (str): Who is asking — the public route's ``auth.kind``
            (``"user"`` or ``"api_key"``) or ``"internal"`` for the
            secret-authed mirror. An API key is a project credential, not a
            person, so it is not told who created the dashboard: ``creator``
            comes back null for it, as ``get_dashboard`` already does.

    Returns:
        DashboardDataResponse: The dashboard, the window answered, and one
            entry per widget in the dashboard's order.

    Raises:
        HTTPException: 422 for an invalid window; 404 passed through when the
            dashboard is not in the project; 503 on dashboard-service ambiguity.
    """
    start, end, window = _resolve_window_for_plan(range_id, start_time, end_time, billing_plan)
    detail = await get_dashboard_detail(project_id, dashboard_id)
    gate = asyncio.Semaphore(DASHBOARD_DATA_CONCURRENCY)
    widgets = await asyncio.gather(
        *(_answer_widget(w, project_id, start, end, gate) for w in detail.widgets)
    )
    statuses = [w.status for w in widgets]
    summary = DashboardSummary(**detail.model_dump(exclude={"widgets"}))
    if caller_kind == "api_key":
        summary.creator = None
    return DashboardDataResponse(
        dashboard=summary,
        window=window,
        widgets=list(widgets),
        queried=statuses.count("ok"),
        skipped=statuses.count("skipped"),
        failed=statuses.count("error"),
    )
