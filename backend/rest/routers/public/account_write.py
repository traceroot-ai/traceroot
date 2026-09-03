"""Account-scope public writes for user credentials (workspace/project creation).

Thin authenticated proxies to the Next.js internal write routes, which own the
Postgres/Prisma control-plane data and the actual authorization/validation
decisions (role gates, field rules, idempotency). Like the account reads, these
run on :data:`AccountStampedAuth` — user-credential-only, no ``project_id``
query — and additionally on :func:`require_live_session`, so a JWT whose
minting session was revoked is blocked before any write. The handler forwards
only the resolved ``user_id`` (as ``actorUserId``) plus the payload — never the
raw credential — and stamps ``transport: "public-api"`` for the audit trail.

Upstream error strings pass through verbatim as the public ``detail``: the
write service's messages are the single source of truth for both the cookie
and the public surface, so the two never drift.
"""

import logging
from typing import Annotated, Any

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from pydantic import ValidationError

from rest.rate_limit import (
    BUCKET_WRITE,
    is_request_rate_limit_exempt,
    key_write,
    limiter,
    resolve_limit,
)
from rest.routers.public.deps import AccountStampedAuth, require_live_session
from rest.schemas.eval import ErrorResponse
from rest.schemas.public_write import (
    CreateProjectRequest,
    CreateProjectResponse,
    CreateWorkspaceRequest,
    CreateWorkspaceResponse,
)
from shared.config import settings

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/public", tags=["Account (Public)"])

# The liveness gate every public write depends on: a no-op for session-token
# credentials (introspection already proved the session live), an instant
# revocation check for JWT credentials. It shares the inner account-auth
# dependency with AccountStampedAuth, so the credential resolves once.
LiveSession = Annotated[None, Depends(require_live_session)]

# Generic per-status fallbacks for a passthrough status whose upstream body
# carries no usable ``error`` string — the raw body is never surfaced.
_PASSTHROUGH_FALLBACKS = {
    status.HTTP_400_BAD_REQUEST: "Invalid request",
    status.HTTP_403_FORBIDDEN: "Forbidden",
    status.HTTP_404_NOT_FOUND: "Not found",
}

_WRITE_ERROR_RESPONSES: dict[int | str, dict[str, Any]] = {
    400: {"model": ErrorResponse, "description": "Invalid request"},
    401: {"model": ErrorResponse, "description": "Authentication failed or session revoked"},
    403: {"model": ErrorResponse, "description": "Insufficient role or wrong credential kind"},
    404: {"model": ErrorResponse, "description": "Not found"},
    503: {"model": ErrorResponse, "description": "Write service unavailable"},
}


def _write_service_error() -> HTTPException:
    """Build the controlled 503 used whenever the write service is ambiguous.

    A shared fail-closed error so any upstream ambiguity — an unexpected
    status, malformed JSON, or a response whose resource envelope is missing
    or wrongly typed — surfaces as a 503, never an uncaught 500 (parity with
    the account-read sibling).

    Returns:
        HTTPException: A 503 with a generic ``Write service error`` detail.
    """
    return HTTPException(
        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        detail="Write service error",
    )


async def _post_internal_write(path: str, payload: dict) -> dict:
    """POST a create to an internal write route and return its success body.

    The single proxy call every public write goes through. Client errors the
    write service owns (400/403/404) pass through with the SAME status and the
    upstream body's ``error`` string as the public ``detail`` — the service's
    messages are canonical, and the raw body is never surfaced. Everything
    ambiguous fails closed as a 503: a network error, a malformed body, or a
    401 — the internal secret is ours, so an upstream 401 is our
    misconfiguration, not the caller's credential failing.

    Args:
        path (str): Internal write route path (appended to the UI base URL),
            e.g. ``"/api/internal/write/workspaces"``.
        payload (dict): The camelCase JSON body to POST (actor id + fields;
            never logged).

    Returns:
        dict: The parsed 200 response body
            (``{"created": bool, "<resource>": {...}}``).

    Raises:
        HTTPException: 400/403/404 passed through from the write service with
            its own ``error`` string as ``detail``; 503 (fail closed) on a
            network error, an upstream 401, any other unexpected status, or a
            malformed body.
    """
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.post(
                f"{settings.traceroot_ui_url}{path}",
                json=payload,
                headers={"X-Internal-Secret": settings.internal_api_secret},
            )
    except httpx.RequestError as e:
        logger.error(f"Failed to reach the write service: {e}")
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Write service unavailable",
        ) from e
    except ValueError as e:
        # Backstop: httpx encodes the body with allow_nan=False, so a
        # non-finite float that slipped past schema validation raises here.
        # The schemas reject NaN/Infinity with a 422, making this
        # unreachable in practice — but if it ever fires, fail closed
        # instead of letting the ValueError escape as an uncaught 500.
        logger.error(f"Write payload failed strict JSON encoding: {e}")
        raise _write_service_error() from e

    if response.status_code in _PASSTHROUGH_FALLBACKS:
        fallback = _PASSTHROUGH_FALLBACKS[response.status_code]
        try:
            body = response.json()
        except ValueError:
            body = None
        error = body.get("error") if isinstance(body, dict) else None
        raise HTTPException(
            status_code=response.status_code,
            detail=error if isinstance(error, str) and error else fallback,
        )

    if response.status_code != 200:
        # Includes 401: the internal secret is this service's own credential,
        # so an upstream rejection of it is our misconfiguration — an outage
        # from the caller's point of view, never their auth failing.
        logger.error(f"Unexpected response from the write service: {response.status_code}")
        raise _write_service_error()

    try:
        data = response.json()
    except ValueError as e:
        logger.error(f"Malformed JSON from the write service: {e}")
        raise _write_service_error() from e

    if not isinstance(data, dict):
        logger.error("Write service returned a non-object JSON body")
        raise _write_service_error()

    return data


@router.post(
    "/workspaces",
    operation_id="create_workspace",
    response_model=CreateWorkspaceResponse,
    responses=_WRITE_ERROR_RESPONSES,
    summary="Create a workspace",
)
@limiter.shared_limit(
    resolve_limit, scope=BUCKET_WRITE, key_func=key_write, exempt_when=is_request_rate_limit_exempt
)
async def create_workspace(
    request: Request,
    response: Response,
    auth: AccountStampedAuth,
    payload: CreateWorkspaceRequest,
    _live: LiveSession,
) -> CreateWorkspaceResponse:
    """Create a workspace administered by the authenticated user.

    Idempotent: re-creating a workspace the user already administers under the
    same name returns that workspace with ``created: false``.

    Args:
        request (Request): Incoming request (rate-limit plumbing).
        response (Response): Outgoing response (rate-limit plumbing).
        auth (AccountStampedAuth): Account-scope user auth (session token or
            CLI access JWT); its resolved ``user_id`` becomes the actor.
        payload (CreateWorkspaceRequest): The workspace to create.
        _live (None): Write-path liveness gate (blocks a revoked JWT session).

    Returns:
        CreateWorkspaceResponse: The created (or matched) workspace.
    """
    data = await _post_internal_write(
        "/api/internal/write/workspaces",
        {
            "actorUserId": auth.user_id,
            "name": payload.name,
            "transport": "public-api",
        },
    )
    try:
        ws = data["workspace"]
        return CreateWorkspaceResponse(
            id=ws["id"], name=ws["name"], role=ws["role"], created=data["created"]
        )
    except (KeyError, TypeError, ValidationError) as e:
        raise _write_service_error() from e


@router.post(
    "/projects",
    operation_id="create_project",
    response_model=CreateProjectResponse,
    responses=_WRITE_ERROR_RESPONSES,
    summary="Create a project",
)
@limiter.shared_limit(
    resolve_limit, scope=BUCKET_WRITE, key_func=key_write, exempt_when=is_request_rate_limit_exempt
)
async def create_project(
    request: Request,
    response: Response,
    auth: AccountStampedAuth,
    payload: CreateProjectRequest,
    _live: LiveSession,
) -> CreateProjectResponse:
    """Create a project in a workspace the authenticated user can write to.

    Requires MEMBER role or higher in the workspace (the write service decides).
    Idempotent on the project name within the workspace.

    Args:
        request (Request): Incoming request (rate-limit plumbing).
        response (Response): Outgoing response (rate-limit plumbing).
        auth (AccountStampedAuth): Account-scope user auth (session token or
            CLI access JWT); its resolved ``user_id`` becomes the actor.
        payload (CreateProjectRequest): The project to create.
        _live (None): Write-path liveness gate (blocks a revoked JWT session).

    Returns:
        CreateProjectResponse: The created (or matched) project.
    """
    body: dict[str, Any] = {
        "actorUserId": auth.user_id,
        "workspaceId": payload.workspace_id,
        "name": payload.name,
        "transport": "public-api",
    }
    # Unset optionals stay out of the body entirely — the internal zod
    # distinguishes absent from null in places, and absent is always safe.
    if payload.trace_ttl_days is not None:
        body["traceTtlDays"] = payload.trace_ttl_days
    data = await _post_internal_write("/api/internal/write/projects", body)
    try:
        project = data["project"]
        return CreateProjectResponse(
            id=project["id"],
            name=project["name"],
            workspace_id=project["workspaceId"],
            created=data["created"],
        )
    except (KeyError, TypeError, ValidationError) as e:
        raise _write_service_error() from e
