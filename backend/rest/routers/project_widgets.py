"""Saved-widget read endpoints (internal service-to-service, not public).

Thin internal mirrors of the public widget reads so the in-app agent's
registry-bound tools can dispatch here with service auth. Payload shapes are
shared with the public surface (rest.schemas.public) by design — one registry
definition serves both. Params must stay a superset of the public twins
(enforced by tests/rest/test_public_internal_parity.py), and the handler
bodies live in rest.routers.dashboard_read_common so behavior cannot drift
between the surfaces.

Mounted under ``/internal`` (the prefix the ingress fixed-404s off the load
balancer) and gated on the internal secret alone, like the dashboard mirror:
the only intended caller is the in-cluster agent. No rate limiting —
secret-authed internal traffic is exempt by definition.
"""

from datetime import datetime

from fastapi import APIRouter, Depends, Query

from rest.routers.dashboard_read_common import get_widget_data_page, get_widget_detail
from rest.routers.deps import ProjectAccess
from rest.routers.internal import verify_internal_secret
from rest.schemas.dashboards import RangeId
from rest.schemas.public import WidgetDataResponse, WidgetDetail

router = APIRouter(
    prefix="/internal/projects/{project_id}/widgets",
    tags=["internal"],
    dependencies=[Depends(verify_internal_secret)],
)


@router.get("/{widget_id}", response_model=WidgetDetail)
async def get_widget(project_id: str, widget_id: str) -> WidgetDetail:
    """Get one saved widget's definition with its dashboard."""
    return await get_widget_detail(project_id, widget_id)


@router.get("/{widget_id}/data", response_model=WidgetDataResponse)
async def get_widget_data(
    project_id: str,
    widget_id: str,
    _access: ProjectAccess,
    range: RangeId | None = Query(default=None),
    start_time: datetime | None = Query(default=None),
    end_time: datetime | None = Query(default=None),
) -> WidgetDataResponse:
    """Answer one saved widget for a window.

    The window is bounded by the plan of whoever the agent acts for, so this
    read resolves project access like the dashboard data mirror does — the
    router's secret gate still decides who may call it at all.
    """
    return await get_widget_data_page(
        project_id, widget_id, _access.billing_plan, range, start_time, end_time
    )
