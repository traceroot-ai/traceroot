"""Dashboard catalog read endpoints (internal service-to-service, not public).

Thin internal mirrors of the public dashboard reads so the in-app agent's
registry-bound tools can dispatch here with service auth. Payload shapes are
shared with the public surface (rest.schemas.public) by design — one registry
definition serves both. Params must stay a superset of the public twins
(enforced by tests/rest/test_public_internal_parity.py), and the handler
bodies live in rest.routers.dashboard_read_common so behavior cannot drift
between the surfaces.

Mounted under ``/internal`` (the prefix the ingress fixed-404s off the load
balancer) and gated on the internal secret alone, like the rest of the
service-to-service API: the only intended caller is the in-cluster agent,
and the ``/api/v1/projects`` surface would let anyone reach the catalog
with just a caller-supplied ``x-user-id`` header. No rate limiting —
secret-authed internal traffic is exempt by definition.
"""

from fastapi import APIRouter, Depends

from rest.routers.dashboard_read_common import get_dashboard_detail, list_dashboards_page
from rest.routers.internal import verify_internal_secret
from rest.schemas.public import DashboardDetail, PublicDashboardListResponse

router = APIRouter(
    prefix="/internal/projects/{project_id}/dashboards",
    tags=["internal"],
    dependencies=[Depends(verify_internal_secret)],
)


@router.get("", response_model=PublicDashboardListResponse)
async def list_dashboards(project_id: str) -> PublicDashboardListResponse:
    """List the project's dashboards (default first)."""
    return await list_dashboards_page(project_id)


@router.get("/{dashboard_id}", response_model=DashboardDetail)
async def get_dashboard(project_id: str, dashboard_id: str) -> DashboardDetail:
    """Get one dashboard with its widgets."""
    return await get_dashboard_detail(project_id, dashboard_id)
