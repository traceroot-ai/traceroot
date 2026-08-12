"""Account-scope discovery API for user credentials (the CLI login flow).

Two user-credential-only reads that answer "which project?" *before* a project
is known: ``list_workspaces`` and ``list_projects``. Unlike the project-scoped
public reads, these take no ``project_id`` and reject API keys (403) — they run
on :data:`AccountStampedAuth`, which authenticates a user session token only.

The account membership graph lives in Postgres/Prisma, so the listing is
delegated to the Next.js internal ``user-memberships`` route (secret-authed,
keyed by the caller's token). The raw token is never logged.
"""

import logging
from typing import Annotated, Any

import httpx
from fastapi import APIRouter, Header, HTTPException, Query, Request, Response, status

from rest.rate_limit import (
    BUCKET_READ,
    is_request_rate_limit_exempt,
    key_read,
    limiter,
    resolve_limit,
)
from rest.routers.public.deps import AccountStampedAuth
from rest.schemas.public import (
    ProjectListItem,
    PublicProjectListResponse,
    PublicWorkspaceListResponse,
    WorkspaceListItem,
)
from shared.config import settings

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/public", tags=["Account (Public)"])


def _account_service_error() -> HTTPException:
    """Build the controlled 503 used whenever the account service is ambiguous.

    A shared fail-closed error so any upstream ambiguity — non-200, malformed
    JSON, a missing ``workspaces`` array, or a membership item missing a
    required field — surfaces as a 503, never an uncaught 500 (parity with the
    auth-dependency siblings).

    Returns:
        HTTPException: A 503 with a generic ``Account service error`` detail.
    """
    return HTTPException(
        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        detail="Account service error",
    )


def _bearer_token(authorization: str | None) -> str:
    """Extract the bearer token from an ``Authorization`` header.

    The value has already been authenticated by :data:`AccountStampedAuth`; this
    re-reads it so the route can forward the raw token to the internal listing
    call. The token is never logged.

    Args:
        authorization (str | None): The ``Authorization: Bearer <token>`` header.

    Returns:
        str: The raw bearer token.

    Raises:
        HTTPException: 401 if the header is missing or malformed (defensive — the
            dependency has already validated it).
    """
    parts = (authorization or "").split(" ", 1)
    if len(parts) != 2 or parts[0].lower() != "bearer" or not parts[1].strip():
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid Authorization header format. Expected: Bearer <token>",
        )
    return parts[1]


async def _fetch_memberships(token: str) -> list[dict[str, Any]]:
    """Fetch the caller's workspace/project graph from the internal route.

    Calls the Next.js internal ``user-memberships`` route (secret-authed, keyed
    by the token). Fails closed with a 503 on any ambiguity — network error,
    unexpected status, or a malformed body — mirroring the auth siblings. The
    raw token is never logged.

    Args:
        token (str): The caller's raw user session token, forwarded to the
            internal route. Never logged.

    Returns:
        list[dict[str, Any]]: The ``workspaces`` array, each entry carrying
            ``id``/``name``/``role`` and a ``projects`` list of ``id``/``name``.

    Raises:
        HTTPException: 503 (fail closed) on a network error, a non-200 status, a
            malformed body, or a missing ``workspaces`` array.
    """
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.post(
                f"{settings.traceroot_ui_url}/api/internal/user-memberships",
                json={"token": token},
                headers={"X-Internal-Secret": settings.internal_api_secret},
            )
    except httpx.RequestError as e:
        logger.error(f"Failed to list user memberships: {e}")
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Account service unavailable",
        ) from e

    if response.status_code != 200:
        logger.error(f"Unexpected response from account service: {response.status_code}")
        raise _account_service_error()

    try:
        data = response.json()
    except ValueError as e:
        logger.error(f"Malformed JSON from account service: {e}")
        raise _account_service_error() from e

    if not isinstance(data, dict) or not isinstance(data.get("workspaces"), list):
        logger.error("Account service returned a malformed memberships body")
        raise _account_service_error()

    return data["workspaces"]


@router.get(
    "/workspaces", response_model=PublicWorkspaceListResponse, operation_id="list_workspaces"
)
@limiter.shared_limit(
    resolve_limit, scope=BUCKET_READ, key_func=key_read, exempt_when=is_request_rate_limit_exempt
)
async def list_workspaces(
    request: Request,
    response: Response,
    auth: AccountStampedAuth,
    authorization: Annotated[str | None, Header()] = None,
) -> PublicWorkspaceListResponse:
    """List the workspaces the authenticated user belongs to.

    A user-credential-only discovery op (no ``project_id``). Use it, then
    ``list_projects``, to resolve the project a subsequent request scopes to.

    Args:
        request (Request): Incoming request (rate-limit plumbing).
        response (Response): Outgoing response (rate-limit plumbing).
        auth (AccountStampedAuth): Account-scope user auth; also stamps the
            per-user rate-limit identity.
        authorization (str | None): The bearer header, re-read to forward the
            already-authenticated token to the internal listing call.

    Returns:
        PublicWorkspaceListResponse: The user's workspaces (id, name, role).
    """
    token = _bearer_token(authorization)
    workspaces = await _fetch_memberships(token)
    try:
        items = [
            WorkspaceListItem(id=ws["id"], name=ws["name"], role=ws["role"]) for ws in workspaces
        ]
    except (KeyError, TypeError) as e:
        # A membership item missing a required field is a malformed upstream
        # response → fail closed with a controlled 503 (parity with the auth
        # siblings), never an uncaught 500.
        raise _account_service_error() from e
    return PublicWorkspaceListResponse(data=items)


@router.get("/projects", response_model=PublicProjectListResponse, operation_id="list_projects")
@limiter.shared_limit(
    resolve_limit, scope=BUCKET_READ, key_func=key_read, exempt_when=is_request_rate_limit_exempt
)
async def list_projects(
    request: Request,
    response: Response,
    auth: AccountStampedAuth,
    authorization: Annotated[str | None, Header()] = None,
    workspace_id: str | None = Query(
        None, description="Restrict the result to projects in this workspace."
    ),
) -> PublicProjectListResponse:
    """List the projects the authenticated user can access, across workspaces.

    A user-credential-only discovery op (no ``project_id``). Projects are
    flattened across the user's workspaces and tagged with their owning
    workspace; the answer is what you pass as ``project_id`` to a project-scoped
    request.

    Args:
        request (Request): Incoming request (rate-limit plumbing).
        response (Response): Outgoing response (rate-limit plumbing).
        auth (AccountStampedAuth): Account-scope user auth; also stamps the
            per-user rate-limit identity.
        authorization (str | None): The bearer header, re-read to forward the
            already-authenticated token to the internal listing call.
        workspace_id (str | None): Optional filter; when given, only projects in
            that workspace are returned.

    Returns:
        PublicProjectListResponse: The accessible projects (id, name,
            workspace_id, workspace_name).
    """
    token = _bearer_token(authorization)
    workspaces = await _fetch_memberships(token)
    items: list[ProjectListItem] = []
    try:
        for ws in workspaces:
            if workspace_id is not None and ws["id"] != workspace_id:
                continue
            for project in ws.get("projects", []):
                items.append(
                    ProjectListItem(
                        id=project["id"],
                        name=project["name"],
                        workspace_id=ws["id"],
                        workspace_name=ws["name"],
                    )
                )
    except (KeyError, TypeError) as e:
        # A membership/project item missing a required field is a malformed
        # upstream response → fail closed with a controlled 503 (parity with the
        # auth siblings), never an uncaught 500.
        raise _account_service_error() from e
    return PublicProjectListResponse(data=items)
