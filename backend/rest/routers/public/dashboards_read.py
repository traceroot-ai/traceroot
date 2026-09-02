"""Public read API for the dashboard catalog.

Mirrors the public detector reads (DualStampedAuth, READ-bucket rate limiting,
project-scoped reads). Authenticated by either an API key (which fixes its own
project) or a user credential (which names the project via ``project_id``); a
dashboard outside the resolved project simply isn't found (404). Handler
bodies live in rest.routers.dashboard_read_common, shared with the internal
project-scoped mirror, so behavior cannot drift between the surfaces.

``creator`` (a member's display name or email) is served to user credentials
only: an API key is a project credential — often embedded client-side by
design — and no other public response it can read carries a human identity.
The redaction lives here, in the public layer, so the internal contract
stays stable for the cookie UI and the agent mirror.
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
from rest.routers.public.deps import DualStampedAuth
from rest.schemas.public import DashboardDetail, PublicDashboardListResponse

router = APIRouter(prefix="/public/dashboards", tags=["Dashboards (Public)"])


@router.get("", response_model=PublicDashboardListResponse, operation_id="list_dashboards")
@limiter.shared_limit(
    resolve_limit, scope=BUCKET_READ, key_func=key_read, exempt_when=is_request_rate_limit_exempt
)
async def list_dashboards(
    request: Request,
    response: Response,
    auth: DualStampedAuth,
) -> PublicDashboardListResponse:
    """List the dashboards in the caller's project (default first)."""
    listing = await list_dashboards_page(auth.project_id)
    if auth.kind == "api_key":
        for item in listing.data:
            item.creator = None
    return listing


@router.get("/{dashboard_id}", response_model=DashboardDetail, operation_id="get_dashboard")
@limiter.shared_limit(
    resolve_limit, scope=BUCKET_READ, key_func=key_read, exempt_when=is_request_rate_limit_exempt
)
async def get_dashboard(
    request: Request,
    response: Response,
    auth: DualStampedAuth,
    dashboard_id: str,
) -> DashboardDetail:
    """Get one dashboard with its widgets for the caller's project."""
    detail = await get_dashboard_detail(auth.project_id, dashboard_id)
    if auth.kind == "api_key":
        detail.creator = None
    return detail
