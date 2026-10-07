"""Public read API for saved widgets.

Gives a widget its own address: ``get_widget`` returns what a widget is, and
``get_widget_data`` returns what it shows for one window — the same engine
``run_widget_query`` runs, pointed at the saved spec. Mirrors the public
dashboard reads (DualStampedAuth, READ-bucket rate limiting, project scope
from the credential); a widget whose dashboard is outside the resolved
project simply isn't found (404), so ids never leak existence across
projects. Handler bodies live in rest.routers.dashboard_read_common, shared
with the internal project-scoped mirror, so behavior cannot drift between
the surfaces.
"""

from datetime import datetime

from fastapi import APIRouter, Query, Request, Response

from rest.rate_limit import (
    BUCKET_READ,
    is_request_rate_limit_exempt,
    key_read,
    limiter,
    resolve_limit,
)
from rest.routers.dashboard_read_common import get_widget_data_page, get_widget_detail
from rest.routers.public.deps import DualStampedAuth
from rest.schemas.dashboards import RangeId
from rest.schemas.public import WidgetDataResponse, WidgetDetail

router = APIRouter(prefix="/public/widgets", tags=["Dashboards (Public)"])


@router.get("/{widget_id}", response_model=WidgetDetail, operation_id="get_widget")
@limiter.shared_limit(
    resolve_limit, scope=BUCKET_READ, key_func=key_read, exempt_when=is_request_rate_limit_exempt
)
async def get_widget(
    request: Request,
    response: Response,
    auth: DualStampedAuth,
    widget_id: str,
) -> WidgetDetail:
    """Get one saved widget's definition, with its dashboard, for the caller's project."""
    return await get_widget_detail(auth.project_id, widget_id)


@router.get("/{widget_id}/data", response_model=WidgetDataResponse, operation_id="get_widget_data")
@limiter.shared_limit(
    resolve_limit, scope=BUCKET_READ, key_func=key_read, exempt_when=is_request_rate_limit_exempt
)
async def get_widget_data(
    request: Request,
    response: Response,
    auth: DualStampedAuth,
    widget_id: str,
    range: RangeId | None = Query(
        default=None,
        description=(
            "A preset window ending now, by the site picker's id. Give this or "
            "explicit start_time/end_time; neither means the site's 24-hour default."
        ),
    ),
    start_time: datetime | None = Query(default=None),
    end_time: datetime | None = Query(default=None),
) -> WidgetDataResponse:
    """Answer one saved widget for a window, with a status instead of an exception."""
    return await get_widget_data_page(
        auth.project_id, widget_id, auth.billing_plan, range, start_time, end_time
    )
