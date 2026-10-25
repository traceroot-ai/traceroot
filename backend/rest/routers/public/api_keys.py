"""Public project API-key endpoints (gateway to the Next.js control plane).

Lets an authenticated client obtain a credential for the project it is already
authenticated against, instead of asking a human to copy one out of the
dashboard. ``traceroot setup`` uses this to give a repository its own key rather
than reusing the developer's, and to rotate it later.

Keys live in the control plane's database, so these routes only authenticate and
forward; the control plane re-validates the same Bearer key and decides. The
authenticating key's project is the only project reachable — there is no
``project_id`` input on any of these routes.

Managing keys requires an ``admin``-scoped key, and that is checked here before
anything is forwarded. The control plane requires the same scope and still
re-validates, so this is a second check rather than the only one: the gateway
does not become the trust boundary, and the property it is built on — that it
cannot turn into one by forgetting a check — is about a *missing* check, which a
redundant one cannot cause. What the local check removes is a network round-trip
spent to learn that a credential was never going to be allowed, and a refusal
that depended on the control plane being reachable at all.

The check is fail-closed, so it can only ever refuse earlier than the control
plane would; it cannot admit anything the control plane would refuse. The one
case where the two can disagree is a deployment whose web app predates the scope
field: this service then resolves every key to ``ingest`` and refuses an
``admin`` key the control plane would have allowed. That is a transient false
refusal during a rollout, in the direction an authorization decision should fail,
and these routes ship in the same change as the control-plane ones they forward
to.
"""

from typing import Annotated

from fastapi import APIRouter, Depends, Request, Response

from rest.rate_limit import (
    BUCKET_READ,
    BUCKET_WRITE,
    is_request_rate_limit_exempt,
    key_read,
    key_write,
    limiter,
    resolve_limit,
)
from rest.routers.public.deps import KeyStampedAuth, require_admin_key_scope
from rest.routers.public.gateway import forward, path_segment

router = APIRouter(prefix="/public/api-keys", tags=["API Keys (Public)"])

Auth = KeyStampedAuth

# The scope gate every route on this router carries. It shares the inner API-key
# dependency with ``Auth``, so the credential still resolves once per request.
# Declared alongside the auth annotation rather than on the router so it reads at
# the handler that needs it, the way the write routes declare their liveness
# gate; a route added here that omitted it would be caught by
# tests/rest/test_public_route_scopes.py rather than by a reviewer noticing.
AdminScope = Annotated[None, Depends(require_admin_key_scope)]

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
async def list_api_keys(
    request: Request, response: Response, auth: Auth, _scope: AdminScope
) -> Response:
    """List this project's API keys."""
    return await forward(
        request, "api-keys", unavailable_detail=_UNAVAILABLE, generic_error=_GENERIC
    )


@router.post("", include_in_schema=False)
@limiter.shared_limit(
    resolve_limit, scope=BUCKET_WRITE, key_func=key_write, exempt_when=is_request_rate_limit_exempt
)
async def create_api_key(
    request: Request, response: Response, auth: Auth, _scope: AdminScope
) -> Response:
    """Mint a key for this project."""
    return await forward(
        request, "api-keys", unavailable_detail=_UNAVAILABLE, generic_error=_GENERIC
    )


@router.delete("/{key_id}", include_in_schema=False)
@limiter.shared_limit(
    resolve_limit, scope=BUCKET_WRITE, key_func=key_write, exempt_when=is_request_rate_limit_exempt
)
async def api_keys_item(
    key_id: str, request: Request, response: Response, auth: Auth, _scope: AdminScope
) -> Response:
    """Revoke one of this project's API keys.

    ``key_id`` is the only caller-supplied text that reaches the forwarded path,
    so it is validated rather than interpolated: see ``path_segment``, which
    refuses a dot-segment or anything carrying a query, a fragment or a
    separator before the upstream URL is built.
    """
    return await forward(
        request,
        f"api-keys/{path_segment(key_id)}",
        unavailable_detail=_UNAVAILABLE,
        generic_error=_GENERIC,
    )
