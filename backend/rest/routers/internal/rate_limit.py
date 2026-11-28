"""Consume the REST write budget before a control-plane operation."""

from fastapi import APIRouter, Depends, Request, Response, status
from pydantic import BaseModel, Field

from rest.rate_limit import (
    BUCKET_WRITE,
    clear_request_rate_limit_exempt,
    key_write,
    limiter,
    resolve_limit,
    set_rate_limit_identity,
)
from rest.routers.internal.auth import verify_internal_secret

router = APIRouter(dependencies=[Depends(verify_internal_secret)])


class WorkspaceRateLimitRequest(BaseModel):
    workspace_id: str = Field(alias="workspaceId", min_length=1)
    billing_plan: str = Field(default="free", alias="billingPlan")


async def stamp_workspace_identity(request: Request, body: WorkspaceRateLimitRequest) -> None:
    """Stamp the workspace and plan already resolved by the trusted caller.

    Args:
        request (Request): Internal request whose rate-limit identity is stamped.
        body (WorkspaceRateLimitRequest): Server-resolved workspace and plan.

    Returns:
        None. Establishes a non-exempt, workspace-wide rate-limit identity.
    """
    clear_request_rate_limit_exempt()
    set_rate_limit_identity(request, body.workspace_id, body.billing_plan)


@router.post(
    "/rate-limit",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[Depends(stamp_workspace_identity)],
)
@limiter.shared_limit(resolve_limit, scope=BUCKET_WRITE, key_func=key_write)
async def check_workspace_rate_limit(request: Request) -> Response:
    """Consume one write from the same workspace budget as the public API.

    Args:
        request (Request): Authenticated internal call carrying the stamped identity.

    Returns:
        Response: A 204 with the existing limiter's quota headers when allowed.
    """
    return Response(status_code=status.HTTP_204_NO_CONTENT)
