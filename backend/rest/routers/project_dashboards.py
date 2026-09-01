"""Dashboard catalog read endpoints (user-authenticated, not public API).

Thin internal mirrors of the public dashboard reads so the in-app agent's
registry-bound tools can dispatch here with service auth. Payload shapes are
shared with the public surface (rest.schemas.public) by design — one registry
definition serves both. Params must stay a superset of the public twins
(enforced by tests/rest/test_public_internal_parity.py), and the handler
bodies live in rest.routers.dashboard_read_common so behavior cannot drift
between the surfaces.
"""

from fastapi import APIRouter, Request, Response

from rest.rate_limit import (
    BUCKET_READ,
    is_request_rate_limit_exempt,
    key_read,
    limiter,
    resolve_limit,
)
from rest.routers.dashboard_read_common import get_dashboard_detail, list_dashboards_page
from rest.routers.deps import RateLimitedProjectAccess
from rest.schemas.public import DashboardDetail, PublicDashboardListResponse

router = APIRouter(prefix="/projects/{project_id}/dashboards", tags=["Dashboards"])


@router.get("", response_model=PublicDashboardListResponse)
@limiter.shared_limit(
    resolve_limit, scope=BUCKET_READ, key_func=key_read, exempt_when=is_request_rate_limit_exempt
)
async def list_dashboards(
    request: Request,
    response: Response,
    project_id: str,
    _access: RateLimitedProjectAccess,
) -> PublicDashboardListResponse:
    """List the project's dashboards (default first)."""
    return await list_dashboards_page(project_id)


@router.get("/{dashboard_id}", response_model=DashboardDetail)
@limiter.shared_limit(
    resolve_limit, scope=BUCKET_READ, key_func=key_read, exempt_when=is_request_rate_limit_exempt
)
async def get_dashboard(
    request: Request,
    response: Response,
    project_id: str,
    dashboard_id: str,
    _access: RateLimitedProjectAccess,
) -> DashboardDetail:
    """Get one dashboard with its widgets."""
    return await get_dashboard_detail(project_id, dashboard_id)
