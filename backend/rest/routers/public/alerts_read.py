"""Public read API for threshold alerts.

Mirrors the public dashboard reads (DualStampedAuth, READ-bucket rate
limiting, project-scoped reads). Authenticated by either an API key (which
fixes its own project) or a user credential (which names the project via
``project_id``); an alert outside the resolved project simply isn't found
(404). Handler bodies live in rest.routers.alert_read_common, shared with the
internal project-scoped mirror, so behavior cannot drift between the surfaces.

``creator`` (a member's display name or email) is served to user credentials
only: an API key is a project credential — often embedded client-side by
design — and no other public response it can read carries a human identity.
The redaction lives here, in the public layer, so the internal contract
stays stable for the cookie UI and the agent mirror.
"""

from fastapi import APIRouter, Query, Request, Response

from rest.rate_limit import (
    BUCKET_READ,
    is_request_rate_limit_exempt,
    key_read,
    limiter,
    resolve_limit,
)
from rest.routers.alert_read_common import get_alert_detail, list_alerts_page
from rest.routers.public.deps import DualStampedAuth
from rest.schemas.public import AlertDetail, PublicAlertListResponse

router = APIRouter(prefix="/public/alerts", tags=["Alerts (Public)"])


@router.get("", response_model=PublicAlertListResponse, operation_id="list_alerts")
@limiter.shared_limit(
    resolve_limit, scope=BUCKET_READ, key_func=key_read, exempt_when=is_request_rate_limit_exempt
)
async def list_alerts(
    request: Request,
    response: Response,
    auth: DualStampedAuth,
    limit: int = Query(50, ge=1, le=200, description="Items per page"),
    page: int = Query(0, ge=0, le=10_000, description="0-based page index"),
    search_query: str | None = Query(
        None, max_length=200, description="Case-insensitive substring match on the alert name"
    ),
) -> PublicAlertListResponse:
    """List the alerts in the caller's project (oldest first) with its capacity."""
    listing = await list_alerts_page(auth.project_id, limit, page, search_query)
    if auth.kind == "api_key":
        for item in listing.data:
            item.creator = None
    return listing


@router.get("/{alert_id}", response_model=AlertDetail, operation_id="get_alert")
@limiter.shared_limit(
    resolve_limit, scope=BUCKET_READ, key_func=key_read, exempt_when=is_request_rate_limit_exempt
)
async def get_alert(
    request: Request,
    response: Response,
    auth: DualStampedAuth,
    alert_id: str,
) -> AlertDetail:
    """Get one alert with its full rule for the caller's project."""
    detail = await get_alert_detail(auth.project_id, alert_id)
    if auth.kind == "api_key":
        detail.creator = None
    return detail
