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

from fastapi import APIRouter, Request, Response

from rest.rate_limit import (
    BUCKET_READ,
    BUCKET_WRITE,
    is_request_rate_limit_exempt,
    key_read,
    key_write,
    limiter,
    resolve_limit,
)
from rest.routers.public.deps import KeyStampedAuth
from rest.routers.public.gateway import forward

router = APIRouter(prefix="/public/api-keys", tags=["API Keys (Public)"])

Auth = KeyStampedAuth

_UNAVAILABLE = "API key service unavailable"
_GENERIC = "API key request failed"

# The listing rides the read bucket and the mutations ride the write bucket, like
# every other public mutation in the tree. One decorated function carries one
# bucket, which is why the collection is two handlers rather than a shared
# ``api_route``.


@router.get("", include_in_schema=False)
@limiter.shared_limit(
    resolve_limit, scope=BUCKET_READ, key_func=key_read, exempt_when=is_request_rate_limit_exempt
)
async def list_api_keys(request: Request, response: Response, auth: Auth) -> Response:
    """List this project's API keys."""
    return await forward(
        request, "api-keys", unavailable_detail=_UNAVAILABLE, generic_error=_GENERIC
    )


@router.post("", include_in_schema=False)
@limiter.shared_limit(
    resolve_limit, scope=BUCKET_WRITE, key_func=key_write, exempt_when=is_request_rate_limit_exempt
)
async def create_api_key(request: Request, response: Response, auth: Auth) -> Response:
    """Mint a key for this project."""
    return await forward(
        request, "api-keys", unavailable_detail=_UNAVAILABLE, generic_error=_GENERIC
    )


@router.delete("/{key_id}", include_in_schema=False)
@limiter.shared_limit(
    resolve_limit, scope=BUCKET_WRITE, key_func=key_write, exempt_when=is_request_rate_limit_exempt
)
async def api_keys_item(key_id: str, request: Request, response: Response, auth: Auth) -> Response:
    """Revoke one of this project's API keys."""
    return await forward(
        request, f"api-keys/{key_id}", unavailable_detail=_UNAVAILABLE, generic_error=_GENERIC
    )
