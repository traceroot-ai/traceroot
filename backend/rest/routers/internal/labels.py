"""Internal eligibility check for user-facing label operations."""

from fastapi import APIRouter, Depends, Query, Response, status

from rest.routers.internal.auth import verify_internal_secret
from rest.routers.labels_common import require_label_target

router = APIRouter(dependencies=[Depends(verify_internal_secret)])


@router.get("/label-target", status_code=status.HTTP_204_NO_CONTENT)
async def check_label_target(
    project_id: str = Query(alias="projectId", min_length=1),
    trace_id: str = Query(alias="traceId", min_length=1),
    span_id: str | None = Query(None, alias="spanId", min_length=1),
    billing_plan: str = Query("free", alias="billingPlan"),
) -> Response:
    """Check label eligibility using the caller's server-resolved project access."""
    await require_label_target(project_id, trace_id, span_id, billing_plan)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
