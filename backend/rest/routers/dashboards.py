"""Widget query endpoints for project dashboards.

Dashboard/widget CRUD lives in Next.js API routes (Prisma/Postgres, same as
detectors). This router only executes queries against ClickHouse and exposes
the field registry that drives the builder UI.
"""

import logging
from datetime import datetime

from fastapi import APIRouter, HTTPException, Query, Request, status

from rest.rate_limit import (
    BUCKET_READ,
    is_request_rate_limit_exempt,
    key_read,
    limiter,
    resolve_limit,
)
from rest.routers.deps import ProjectAccess, RateLimitedProjectAccess
from rest.schemas.dashboards import WidgetQueryRequest, WidgetQueryResponse
from rest.schemas.traces import FilterValuesResponse
from rest.services.trace_reader import get_trace_reader_service
from rest.services.widget_query import WidgetSpecError, run_widget_query
from rest.services.widget_registry import REGISTRY, registry_schema

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/projects/{project_id}/widgets", tags=["Dashboards"])


@router.get("/field-values/{view}/{field}", response_model=FilterValuesResponse)
@limiter.shared_limit(
    resolve_limit, scope=BUCKET_READ, key_func=key_read, exempt_when=is_request_rate_limit_exempt
)
async def get_widget_field_values(
    request: Request,
    project_id: str,
    view: str,
    field: str,
    _access: RateLimitedProjectAccess,
    start_time: datetime | None = Query(
        None, description="Only consider rows whose event time is at or after this timestamp"
    ),
    end_time: datetime | None = Query(
        None, description="Only consider rows whose event time is before this timestamp"
    ),
):
    """Distinct stored values for a string field, for the builder's value dropdowns.

    Reuses the trace-filter distinct-values scan (deduped, time-bounded, cached).
    The view and field resolve through the widget registry before any SQL, so a
    raw client-supplied column name can never reach a query.

    Args:
        project_id (str): Project that owns the data; server-bound for isolation.
        view (str): The widget view (``spans`` or ``traces``) whose table is scanned.
        field (str): The string dimension to enumerate.
        request (Request): Injected so the shared read limiter can key the request.
        _access (RateLimitedProjectAccess): Validates access + sets the rate-limit identity.
        start_time (datetime | None): Lower bound of the active dashboard window.
        end_time (datetime | None): Upper bound (exclusive) of the active window.

    Returns:
        FilterValuesResponse: Distinct values ordered by descending frequency.

    Raises:
        HTTPException: 404 for an unknown view or field, 400 for a field that is
            not an enumerable string dimension (numeric measures, ``count``).
    """
    view_def = REGISTRY.get(view)
    if view_def is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Unknown widget view: {view}",
        )
    field_def = view_def.fields.get(field)
    if field_def is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Unknown field '{field}' for view '{view}'",
        )
    if field_def.type != "string":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Field '{field}' does not support distinct-value listing",
        )

    service = get_trace_reader_service()
    # String dims declare their expr as the bare physical column name on the
    # view's source table, so it feeds the distinct scan directly.
    if view == "spans":
        values = service.get_distinct_span_values(
            project_id=project_id,
            column=field_def.expr,
            start_after=start_time,
            end_before=end_time,
        )
    else:
        values = service.get_distinct_trace_values(
            project_id=project_id,
            column=field_def.expr,
            start_after=start_time,
            end_before=end_time,
        )
    return {"field": field, "values": values}


@router.get("/schema")
async def get_widget_schema(project_id: str, _access: ProjectAccess) -> dict:
    """Field registry for the widget builder (views, fields, ops, aggs)."""
    return registry_schema()


@router.post("/query", response_model=WidgetQueryResponse)
@limiter.shared_limit(
    resolve_limit, scope=BUCKET_READ, key_func=key_read, exempt_when=is_request_rate_limit_exempt
)
async def query_widget_data(
    request: Request,
    project_id: str,
    body: WidgetQueryRequest,
    _access: RateLimitedProjectAccess,
):
    """Execute a widget spec. Stateless: used by saved widgets and builder previews."""
    try:
        return run_widget_query(
            spec=body.spec,
            project_id=project_id,
            start_time=body.start_time,
            end_time=body.end_time,
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
