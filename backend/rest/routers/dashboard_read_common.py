"""Shared handler bodies for the dashboard and widget read surfaces.

The public (dual-credential) and internal (project-scoped mirror) dashboard
and widget read routers expose the same reads over the same response schemas;
only the auth source differs. Each router resolves auth, then delegates here, so the
proxy and error-mapping semantics cannot drift between the two surfaces.

The dashboard catalog lives in Postgres/Prisma, so both reads are delegated to
the Next.js internal routes (secret-authed, keyed by the resolved project id)
through the shared internal read proxy, which owns the passthrough (400/403/
404) and fail-closed (503) rules. Ids are never logged.
"""

import asyncio
import contextlib
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
    WidgetDataResponse,
    WidgetDetail,
    WidgetRef,
)
from rest.services.date_presets import WindowSpecError, as_utc, resolve_window
from rest.services.widget_query import (
    WidgetSpecError,
    is_series,
    run_widget_query,
    series_row_bound,
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


async def get_widget_detail(project_id: str, widget_id: str) -> WidgetDetail:
    """Fetch one saved widget, with its dashboard, via the internal widget route.

    The internal route resolves the widget through its dashboard's project, so
    a widget outside the resolved project simply isn't found — its 404 passes
    through, indistinguishable from an unknown id.

    Args:
        project_id (str): The project the caller's credential resolved to.
        widget_id (str): The widget to fetch.

    Returns:
        WidgetDetail: The widget as stored plus its dashboard's id and name.

    Raises:
        HTTPException: 404 passed through when the widget is not in the
            project; 503 (fail closed) on any upstream ambiguity.
    """
    data = await post_internal_read(
        "/api/internal/project-widget",
        {"projectId": project_id, "widgetId": widget_id},
        service=_SERVICE,
    )
    try:
        widget: Any = data["widget"]
        return WidgetDetail(
            id=widget["id"],
            dashboard_id=widget["dashboard"]["id"],
            dashboard_name=widget["dashboard"]["name"],
            title=widget["title"],
            type=widget["type"],
            spec=widget["spec"],
            display_config=widget["displayConfig"],
            create_time=widget["createTime"],
            update_time=widget["updateTime"],
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


# A dashboard data read answers a dashboard's query widgets at once, so it is
# bounded four ways: rows per widget (a table widget can return hundreds; a
# caller summarizing a dashboard needs the shape, not the tail; a series is
# bounded by its bucket count instead — see _answer_widget), queries in
# flight per request (twelve tiles must not open twelve ClickHouse connections
# at once — concurrent requests are bounded by the READ rate bucket, not here),
# queries per request (nothing caps widgets per dashboard, and one call must
# not fan out into arbitrarily many queries; the rest come back as errors
# naming the cap, so the caller can query them one at a time), and per-widget
# failure isolation (one stale spec must not fail the dashboard).
DASHBOARD_DATA_ROW_CAP = 25
# Every preset window fits (90 days of a broken-down daily series is ~4.7k
# rows); explicit bounds have no span ceiling, so a multi-year series is
# refused rather than shipped.
DASHBOARD_DATA_SERIES_ROW_CAP = 5_000
DASHBOARD_DATA_CONCURRENCY = 4
DASHBOARD_DATA_QUERY_WIDGET_CAP = 24


def _widget_error(widget: DashboardWidgetItem, reason: str) -> DashboardWidgetData:
    return DashboardWidgetData(
        id=widget.id, title=widget.title, type=widget.type, status="error", error=reason
    )


async def _answer_widget(
    widget: DashboardWidgetItem,
    project_id: str,
    start: datetime,
    end: datetime,
    *,
    row_cap: int | None,
    series_row_cap: int | None,
    gate: asyncio.Semaphore | None = None,
) -> DashboardWidgetData:
    """Answer one widget for the window, never raising: every outcome is a status.

    Args:
        widget (DashboardWidgetItem): The widget whose stored spec to run.
        project_id (str): The project the caller's credential resolved to.
        start (datetime): The window's lower bound, already clamped.
        end (datetime): The window's upper bound.
        row_cap (int | None): Rows a non-series display keeps, or None for
            every row the engine returns. A series is never row-capped: a cap
            would keep the oldest buckets of a long window.
        series_row_cap (int | None): The bucket-count ceiling past which a
            series is refused instead of answered, or None for no ceiling.
        gate (asyncio.Semaphore | None): The concurrency gate a fan-out runs
            under, or None when this is the only query in the request.

    Returns:
        DashboardWidgetData: The widget's answer with its ``status``.
    """
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
    # A series is answered whole; its size is the window's bucket count (times
    # the groups), refused past the ceiling instead. Every other display's cap
    # goes into the SQL LIMIT, not only onto the response: the extra row is
    # the truncation signal, and the engine never materializes the rows this
    # read would drop anyway.
    if is_series(spec):
        row_cap = None
        if series_row_cap is not None and series_row_bound(spec, start, end) > series_row_cap:
            return _widget_error(
                widget,
                "not answered: the window has too many buckets for a dashboard read; "
                "read it alone with get_widget_data",
            )
    try:
        async with gate if gate is not None else contextlib.nullcontext():
            result = await asyncio.to_thread(
                run_widget_query,
                spec=spec,
                project_id=project_id,
                start_time=start,
                end_time=end,
                max_rows=None if row_cap is None else row_cap + 1,
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
        rows=rows[:row_cap],
        meta=result.get("meta", {}),
        truncated=row_cap is not None and len(rows) > row_cap,
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
    """Answer a dashboard's query widgets, up to the per-request cap, for one window.

    The shared body of the public ``get_dashboard_data`` and the internal
    ``/dashboards/{dashboard_id}/data`` mirror. The window is resolved and
    clamped first (a malformed window is a 422 before anything is fetched),
    then the dashboard is read through the internal detail route and each
    query widget up to the per-request cap runs under a concurrency gate;
    feeds are listed as skipped, a failing widget becomes an inline error and
    so does a query widget past the cap, so the dashboard's order and count
    are always intact.

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
    over_cap = (
        f"not answered: the dashboard has more than {DASHBOARD_DATA_QUERY_WIDGET_CAP} query "
        "widgets; read it alone with get_widget_data"
    )

    async def answer(w: DashboardWidgetItem, past_cap: bool) -> DashboardWidgetData:
        if past_cap:
            return _widget_error(w, over_cap)
        return await _answer_widget(
            w,
            project_id,
            start,
            end,
            row_cap=DASHBOARD_DATA_ROW_CAP,
            series_row_cap=DASHBOARD_DATA_SERIES_ROW_CAP,
            gate=gate,
        )

    # Only query widgets count toward the cap; a feed anywhere is still a skip.
    queries_seen = 0
    calls = []
    for w in detail.widgets:
        past_cap = False
        if w.type == "query":
            queries_seen += 1
            past_cap = queries_seen > DASHBOARD_DATA_QUERY_WIDGET_CAP
        calls.append(answer(w, past_cap))
    widgets = await asyncio.gather(*calls)
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


async def get_widget_data_page(
    project_id: str,
    widget_id: str,
    billing_plan: str,
    range_id: str | None,
    start_time: datetime | None,
    end_time: datetime | None,
) -> WidgetDataResponse:
    """Answer one saved widget for one window.

    The shared body of the public ``get_widget_data`` and the internal
    ``/widgets/{widget_id}/data`` mirror. The window is resolved and clamped
    first (a malformed window is a 422 before anything is fetched), then the
    widget is read through the internal detail route and its stored spec runs
    through the same per-widget path a dashboard read uses — with the
    dashboard's caps switched off, since one widget has no fan-out to protect.
    A feed is skipped and a broken spec is an inline error, never a 500.

    Args:
        project_id (str): The project the caller's credential resolved to.
        widget_id (str): The widget to answer.
        billing_plan (str): The plan whose retention bounds the window.
        range_id (str | None): A preset id, or None for explicit bounds/default.
        start_time (datetime | None): Explicit lower bound, if any.
        end_time (datetime | None): Explicit upper bound, if any.

    Returns:
        WidgetDataResponse: The widget's identity, the window answered, and
            its answer with a ``status``.

    Raises:
        HTTPException: 422 for an invalid window; 404 passed through when the
            widget is not in the project; 503 on dashboard-service ambiguity.
    """
    start, end, window = _resolve_window_for_plan(range_id, start_time, end_time, billing_plan)
    detail = await get_widget_detail(project_id, widget_id)
    answer = await _answer_widget(detail, project_id, start, end, row_cap=None, series_row_cap=None)
    return WidgetDataResponse(
        widget=WidgetRef(
            id=detail.id, dashboard_id=detail.dashboard_id, title=detail.title, type=detail.type
        ),
        window=window,
        **answer.model_dump(exclude={"id", "title", "type"}),
    )
