"""Public whoami endpoint: resolve an API key to its project/workspace identity.

Powers the CLI's `login` (validate + confirm) and `status` commands. Returns
identity plus both hosts so the CLI stays single-host: ``host`` is the API host
the client reached, ``ui_base_url`` is where trace links point.

It also reports the key's scope. Scope is otherwise only discoverable by being
refused, which is the right answer for a route and the wrong one for a decision
taken before any route is called — a client deciding whether to write a key into
a file that outlives the run should not have to exercise a privileged endpoint to
find out whether it is privileged. Reporting it to the key's own holder discloses
nothing they could not already establish that way.
"""

from fastapi import APIRouter, Request, Response

from rest.rate_limit import (
    BUCKET_READ,
    is_request_rate_limit_exempt,
    key_read,
    limiter,
    resolve_limit,
)
from rest.routers.public.deps import KeyStampedAuth, parse_scope
from rest.schemas.public import WhoamiResponse
from shared.config import settings

router = APIRouter(prefix="/public/whoami", tags=["Whoami (Public)"])


@router.get("", response_model=WhoamiResponse, operation_id="whoami")
@limiter.shared_limit(
    resolve_limit, scope=BUCKET_READ, key_func=key_read, exempt_when=is_request_rate_limit_exempt
)
async def whoami(request: Request, response: Response, auth: KeyStampedAuth) -> WhoamiResponse:
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
        # Narrowed through the same function the enforcement path uses, rather
        # than reported raw. The two must agree: a holder told `admin` and then
        # refused as `ingest` is worse than either answer alone. This route is
        # key-only, so `auth.scope` is always populated — routing it through
        # `parse_scope` costs nothing and means a credential that somehow
        # carries none is reported as what it would in fact be allowed, not as
        # a 500. (A user credential carries no scope; were this route ever to
        # accept one, it would need an answer of its own rather than this.)
        key_scope=parse_scope(auth.scope),
        host=str(request.base_url).rstrip("/"),
        ui_base_url=settings.traceroot_public_ui_url.rstrip("/"),
    )
