"""Alert read endpoints (internal service-to-service, not public).

Thin internal mirrors of the public alert reads so the in-app agent's
registry-bound tools can dispatch here with service auth. Payload shapes are
shared with the public surface (rest.schemas.public) by design — one registry
definition serves both. Params must stay a superset of the public twins
(enforced by tests/rest/test_public_internal_parity.py), and the handler
bodies live in rest.routers.alert_read_common so behavior cannot drift
between the surfaces.

Mounted under ``/internal`` (the prefix the ingress fixed-404s off the load
balancer) and gated on the internal secret alone, like the dashboard mirror:
the only intended caller is the in-cluster agent, and the ``/api/v1/projects``
surface would let anyone reach the rules with just a caller-supplied
``x-user-id`` header. No rate limiting — secret-authed internal traffic is
exempt by definition.
"""

from fastapi import APIRouter, Depends, Query

from rest.routers.alert_read_common import get_alert_detail, list_alerts_page
from rest.routers.internal import verify_internal_secret
from rest.schemas.public import AlertDetail, PublicAlertListResponse

router = APIRouter(
    prefix="/internal/projects/{project_id}/alerts",
    tags=["internal"],
    dependencies=[Depends(verify_internal_secret)],
)


@router.get("", response_model=PublicAlertListResponse)
async def list_alerts(
    project_id: str,
    limit: int = Query(50, ge=1, le=200, description="Items per page"),
    page: int = Query(0, ge=0, le=10_000, description="0-based page index"),
    search_query: str | None = Query(
        None, max_length=200, description="Case-insensitive substring match on the alert name"
    ),
) -> PublicAlertListResponse:
    """List the project's alerts (oldest first) with its capacity."""
    return await list_alerts_page(project_id, limit, page, search_query)


@router.get("/{alert_id}", response_model=AlertDetail)
async def get_alert(project_id: str, alert_id: str) -> AlertDetail:
    """Get one alert with its full rule."""
    return await get_alert_detail(project_id, alert_id)
