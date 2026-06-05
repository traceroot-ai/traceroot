"""Public whoami endpoint: resolve an API key to its project/workspace identity.

Powers the CLI's `login` (validate + confirm) and `status` commands. Returns
identity plus both hosts so the CLI stays single-host: ``host`` is the API host
the client reached, ``ui_base_url`` is where trace links point.
"""

from fastapi import APIRouter, Request

from rest.routers.public.deps import Auth
from rest.schemas.public import WhoamiResponse
from shared.config import settings

router = APIRouter(prefix="/public/whoami", tags=["Whoami (Public)"])


@router.get("", response_model=WhoamiResponse)
async def whoami(auth: Auth, request: Request) -> WhoamiResponse:
    """Return the identity the authenticated API key maps to."""
    # `host` reflects the request's Host header (the API host the client
    # reached). It is only echoed back, never used server-side — but it is
    # client-controllable unless a trusted proxy validates Host, so consumers
    # should treat it as informational.
    return WhoamiResponse(
        project_id=auth.project_id,
        project_name=auth.project_name,
        workspace_id=auth.workspace_id,
        workspace_name=auth.workspace_name,
        key_name=auth.key_name,
        key_hint=auth.key_hint,
        host=str(request.base_url).rstrip("/"),
        ui_base_url=settings.traceroot_public_ui_url.rstrip("/"),
    )
