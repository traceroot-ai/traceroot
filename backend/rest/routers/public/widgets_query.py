"""Public widget query.

The stateless query behind every dashboard tile, exposed to API keys and user
credentials so the agent and the CLI can answer a metric question without a
dashboard existing at all. Mirrors the public dashboard reads (DualStampedAuth,
READ-bucket rate limiting, project scope from the credential); the handler body
lives in rest.routers.dashboard_read_common, shared with the internal
``/projects/{project_id}/widgets/query`` mirror, so behaviour cannot drift
between the surfaces.

A POST that is a read: the spec is a structured body, but nothing is written.
Its tool curation carries the ``"none"`` approval class for that reason.
"""

from fastapi import APIRouter, Request, Response

from rest.rate_limit import (
    BUCKET_READ,
    is_request_rate_limit_exempt,
    key_read,
    limiter,
    resolve_limit,
)
from rest.routers.dashboard_read_common import run_widget_query_page
from rest.routers.public.deps import DualStampedAuth
from rest.schemas.dashboards import WidgetQueryRequest, WidgetQueryResponse

router = APIRouter(prefix="/public/widgets", tags=["Dashboards (Public)"])


@router.post("/query", response_model=WidgetQueryResponse, operation_id="run_widget_query")
@limiter.shared_limit(
    resolve_limit, scope=BUCKET_READ, key_func=key_read, exempt_when=is_request_rate_limit_exempt
)
async def run_widget_query(
    request: Request,
    response: Response,
    auth: DualStampedAuth,
    body: WidgetQueryRequest,
) -> WidgetQueryResponse:
    """Run a widget spec for a window and return its rows with the window answered."""
    return await run_widget_query_page(
        body, project_id=auth.project_id, billing_plan=auth.billing_plan
    )
