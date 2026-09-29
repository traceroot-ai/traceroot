"""Public project API-key endpoints (gateway to the Next.js control plane).

Lets an authenticated client obtain a credential for the project it is already
authenticated against, instead of asking a human to copy one out of the
dashboard. ``traceroot setup`` uses this to give a repository its own key rather
than reusing the developer's, and to rotate it later.

Keys live in the control plane's database, so these routes only authenticate and
forward; the control plane re-validates the same Bearer key and decides. The
authenticating key's project is the only project reachable — there is no
``project_id`` input on any of these routes.
"""

from typing import Annotated

from fastapi import APIRouter, Depends, Request, Response

from rest.rate_limit import (
    BUCKET_READ,
    is_request_rate_limit_exempt,
    key_read,
    limiter,
    resolve_limit,
)
from rest.routers.public.deps import AuthResult, authenticate_api_key
from rest.routers.public.gateway import forward

router = APIRouter(prefix="/public/api-keys", tags=["API Keys (Public)"])

Auth = Annotated[AuthResult, Depends(authenticate_api_key)]

_UNAVAILABLE = "API key service unavailable"
_GENERIC = "API key request failed"

# Both routes share the READ bucket. There is no write/credential bucket today,
# and the eval gateway rate-limits nothing at all — but minting credentials
# deserves a ceiling, and this resource is called about once per setup run, so
# borrowing the authenticated read budget costs legitimate traffic nothing. A
# dedicated bucket would be the better long-term home.


@router.api_route("", methods=["GET", "POST"], include_in_schema=False)
@limiter.shared_limit(
    resolve_limit, scope=BUCKET_READ, key_func=key_read, exempt_when=is_request_rate_limit_exempt
)
async def api_keys_root(request: Request, response: Response, auth: Auth) -> Response:
    """List this project's API keys, or mint a new one."""
    return await forward(
        request, "api-keys", unavailable_detail=_UNAVAILABLE, generic_error=_GENERIC
    )


@router.api_route("/{key_id}", methods=["DELETE"], include_in_schema=False)
@limiter.shared_limit(
    resolve_limit, scope=BUCKET_READ, key_func=key_read, exempt_when=is_request_rate_limit_exempt
)
async def api_keys_item(key_id: str, request: Request, response: Response, auth: Auth) -> Response:
    """Revoke one of this project's API keys."""
    return await forward(
        request, f"api-keys/{key_id}", unavailable_detail=_UNAVAILABLE, generic_error=_GENERIC
    )
