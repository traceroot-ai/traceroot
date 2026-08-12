"""Shared dependencies for the public, API-key-authenticated API.

The API-key auth dependency lives here (not inside any one endpoint module) so
every public route — ingestion plus the read endpoints (whoami, traces) — can
depend on it without importing from a sibling endpoint. Authentication is
delegated to the Next.js internal ``validate-api-key`` route, which owns the
Postgres/Prisma control-plane data.
"""

import hashlib
import logging
from dataclasses import dataclass
from typing import Annotated, Literal

import httpx
from fastapi import Depends, Header, HTTPException, Query, Request, status

from rest.rate_limit import clear_request_rate_limit_exempt, set_rate_limit_identity
from shared.config import settings

logger = logging.getLogger(__name__)


@dataclass
class AuthResult:
    """Result of API key authentication.

    The billing fields drive ingestion gating. The identity fields
    (``project_name``/``workspace_name``/``key_name``/``key_hint``) power the
    ``whoami`` endpoint; they are optional because ``validate-api-key`` may not
    return them, and ingestion does not need them.

    ``kind`` discriminates the credential that produced this result: an API key
    (``"api_key"``, the default so every existing construction stays valid) or a
    user session token (``"user"``). ``user_id``/``role`` are populated only on
    the user path; they are ``None`` for API-key results.
    """

    project_id: str
    workspace_id: str
    billing_plan: str
    ingestion_blocked: bool
    project_name: str | None = None
    workspace_name: str | None = None
    key_name: str | None = None
    key_hint: str | None = None
    kind: Literal["api_key", "user"] = "api_key"
    user_id: str | None = None
    role: str | None = None


async def authenticate_api_key(
    authorization: Annotated[str | None, Header()] = None,
) -> AuthResult:
    """Authenticate the request via the Next.js internal validate-api-key route.

    Expects ``Authorization: Bearer <api_key>``. The raw key is hashed before it
    leaves this process; the full token is never forwarded or logged.
    """
    if not authorization:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing Authorization header",
        )

    parts = authorization.split(" ", 1)
    if len(parts) != 2 or parts[0].lower() != "bearer":
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid Authorization header format. Expected: Bearer <api_key>",
        )

    api_key = parts[1]
    # SHA256 is appropriate for API keys (high-entropy random UUIDs, not user passwords).
    # codeql[py/weak-sensitive-data-hashing]
    key_hash = hashlib.sha256(api_key.encode()).hexdigest()

    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.post(
                f"{settings.traceroot_ui_url}/api/internal/validate-api-key",
                json={"keyHash": key_hash},
                headers={"X-Internal-Secret": settings.internal_api_secret},
            )
    except httpx.RequestError as e:
        logger.error(f"Failed to validate API key: {e}")
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Authentication service unavailable",
        ) from e

    if response.status_code == 401:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authentication failed",
        )

    if response.status_code != 200:
        logger.error(f"Unexpected response from auth service: {response.status_code}")
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Authentication service error",
        )

    # A 200 with a malformed body (non-JSON, or a non-object) is an auth-service
    # error, not a client error — surface a controlled 503, never an uncaught 500.
    try:
        data = response.json()
    except ValueError as e:
        logger.error(f"Malformed JSON from auth service: {e}")
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Authentication service error",
        ) from e

    if not isinstance(data, dict):
        logger.error("Auth service returned a non-object JSON body")
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Authentication service error",
        )

    if not data.get("valid"):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=data.get("error", "Invalid API key"),
        )

    # A valid:true response missing required fields is also malformed → 503.
    try:
        project_id = data["projectId"]
        workspace_id = data["workspaceId"]
        billing_plan = data["billingPlan"]
        ingestion_blocked = data["ingestionBlocked"]
    except KeyError as e:
        logger.error(f"Auth service response missing required field: {e}")
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Authentication service error",
        ) from e

    # The subscript above rejects an absent workspaceId, but an empty one would
    # still key every such tenant into one shared ingest bucket. Reject it too,
    # so ingest and the dashboard-read path both guarantee a usable workspace.
    if not workspace_id:
        logger.error("Auth service response has an empty workspaceId")
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Authentication service error",
        )

    # ingestionBlocked gates billing enforcement, so fail closed on a malformed
    # value: a non-bool (or the missing case above) must not be read as "not
    # blocked", which would silently bypass the free-plan ingestion limit.
    if not isinstance(ingestion_blocked, bool):
        logger.error("Auth service returned a non-boolean ingestionBlocked")
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Authentication service error",
        )

    return AuthResult(
        kind="api_key",
        project_id=project_id,
        workspace_id=workspace_id,
        billing_plan=billing_plan,
        ingestion_blocked=ingestion_blocked,
        project_name=data.get("projectName"),
        workspace_name=data.get("workspaceName"),
        key_name=data.get("keyName"),
        key_hint=data.get("keyHint"),
    )


Auth = Annotated[AuthResult, Depends(authenticate_api_key)]


async def authenticate_and_stamp_identity(request: Request, auth: Auth) -> AuthResult:
    """Authenticate, then stamp the workspace/plan onto the request for limiting.

    A thin wrapper over the API-key auth so the rate limiter can key the bucket
    by workspace and resolve the plan tier. It runs during dependency resolution
    — before slowapi evaluates the limit — so ``key_func`` sees the identity on
    ``request.state``. Shared by every enforced public route (ingest + reads).

    Public API-key calls are never the trusted internal service-to-service caller,
    so a clean (non-exempt) baseline is established defensively.

    Args:
        request (Request): Incoming request; its ``state`` is stamped with the
            resolved rate-limit identity.
        auth (Auth): API-key auth dependency resolving the workspace and plan.

    Returns:
        AuthResult: The authenticated result, passed through to the route handler.
    """
    clear_request_rate_limit_exempt()
    set_rate_limit_identity(request, auth.workspace_id, auth.billing_plan)
    return auth


StampedAuth = Annotated[AuthResult, Depends(authenticate_and_stamp_identity)]


async def authenticate_user_token(token: str, project_id: str) -> AuthResult:
    """Authenticate a user session token against the internal validate-user-token route.

    Mirrors :func:`authenticate_api_key`'s httpx structure and fail-closed 503
    mapping. The token is a better-auth session token (the CLI's credential), not
    an API key; it is POSTed to the internal route for introspection and is never
    logged. A non-empty ``project_id`` is required — the caller guarantees it.

    Args:
        token (str): The raw user session token to validate. Never logged.
        project_id (str): The project the caller is scoping the request to; sent
            to the internal route so it can check membership and access.

    Returns:
        AuthResult: A ``kind="user"`` result carrying the resolved project,
            workspace, plan, role, and user id. ``ingestion_blocked`` is always
            ``True`` for user credentials (see below).

    Raises:
        HTTPException: 401 for an invalid/expired token, 403 when the token is
            valid but has no access to ``project_id``, and 503 (fail closed) for
            any introspection ambiguity — network error, unexpected status, or a
            malformed/incomplete 200 body.
    """
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.post(
                f"{settings.traceroot_ui_url}/api/internal/validate-user-token",
                json={"token": token, "projectId": project_id},
                headers={"X-Internal-Secret": settings.internal_api_secret},
            )
    except httpx.RequestError as e:
        logger.error(f"Failed to validate user token: {e}")
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Authentication service unavailable",
        ) from e

    if response.status_code == 401:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authentication failed",
        )

    # A valid token that simply lacks access to this project — instructive, not a 503.
    if response.status_code == 403:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=f"No access to project '{project_id}'",
        )

    if response.status_code != 200:
        logger.error(f"Unexpected response from auth service: {response.status_code}")
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Authentication service error",
        )

    # A 200 with a malformed body (non-JSON, or a non-object) is an auth-service
    # error, not a client error — surface a controlled 503, never an uncaught 500.
    try:
        data = response.json()
    except ValueError as e:
        logger.error(f"Malformed JSON from auth service: {e}")
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Authentication service error",
        ) from e

    if not isinstance(data, dict):
        logger.error("Auth service returned a non-object JSON body")
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Authentication service error",
        )

    if not data.get("valid"):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=data.get("error", "Invalid token"),
        )

    # A valid:true (200) response missing required project fields is malformed → 503.
    try:
        resolved_project_id = data["projectId"]
        workspace_id = data["workspaceId"]
        billing_plan = data["billingPlan"]
        role = data["role"]
        user_id = data["userId"]
    except KeyError as e:
        logger.error(f"Auth service response missing required field: {e}")
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Authentication service error",
        ) from e

    # An empty workspaceId would key every such tenant into one shared rate-limit
    # bucket. Reject it too (parity with the API-key path).
    if not workspace_id:
        logger.error("Auth service response has an empty workspaceId")
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Authentication service error",
        )

    return AuthResult(
        kind="user",
        project_id=resolved_project_id,
        workspace_id=workspace_id,
        billing_plan=billing_plan,
        # ingestion is API-key-only: a user session token must never be usable to
        # ingest. Block it defensively even though no route wires user auth to
        # ingest, so the invariant holds regardless of future route wiring.
        ingestion_blocked=True,
        role=role,
        user_id=user_id,
    )


async def authenticate_public_caller(
    authorization: Annotated[str | None, Header()] = None,
    project_id: Annotated[
        str | None,
        Query(
            description=(
                "Target project for the request. Required when authenticating with a user "
                "session token (a user credential is only meaningful scoped to a project); "
                "for an API key it is optional and, if given, must match the key's project."
            ),
        ),
    ] = None,
) -> AuthResult:
    """Authenticate a public caller by either an API key or a user session token.

    The unified public-API auth dependency. It parses the bearer token exactly
    like :func:`authenticate_api_key`, then discriminates on the ``tr-`` prefix:
    API keys are ``tr-<uuid>``; user session tokens never start with ``tr-``.

    Security invariant: a ``tr-``-prefixed value can never reach
    :func:`authenticate_user_token` — it always routes to the API-key validator.
    Conversely a non-``tr-`` value never reaches the key validator.

    Args:
        authorization (str | None): The ``Authorization: Bearer <token>`` header.
        project_id (str | None): Optional ``project_id`` query parameter. For an
            API key it is an optional cross-check; for a user token it is required
            (a user credential is only meaningful scoped to a project).

    Returns:
        AuthResult: The API-key result (``kind="api_key"``) or the user result
            (``kind="user"``).

    Raises:
        HTTPException: 401 for a missing/malformed header (or failed auth), 400
            when ``project_id`` is missing for a user token or contradicts the
            API key's project, 403/503 per the delegated validators.
    """
    if not authorization:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing Authorization header",
        )

    parts = authorization.split(" ", 1)
    if len(parts) != 2 or parts[0].lower() != "bearer":
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid Authorization header format. Expected: Bearer <token>",
        )

    token = parts[1]

    # An empty/whitespace-only token is a malformed credential, not an upstream
    # outage — reject it here as 401 rather than letting it reach a validator and
    # surface as a misleading 503.
    if not token.strip():
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid Authorization header. Expected: Bearer <token>",
        )

    # Discriminate case-insensitively and ignoring surrounding whitespace so any
    # key-shaped value (e.g. "TR-…", or a stray-space " tr-…") routes to the key
    # validator — where the raw key is hashed before it leaves this process — and
    # never to the user endpoint, which would POST the raw key unhashed.
    if token.strip().lower().startswith("tr-"):
        # Key path: reuse the existing validator verbatim (do not duplicate it).
        result = await authenticate_api_key(authorization)
        # An API key already fixes its project; a provided project_id may only
        # confirm it, never override it.
        if project_id and project_id != result.project_id:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="project_id does not match the API key's project",
            )
        return result

    # User path: a user credential is only meaningful scoped to a project.
    if not project_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                "project_id query parameter is required for user credentials; "
                "call list_projects to find one."
            ),
        )
    return await authenticate_user_token(token, project_id)


DualAuth = Annotated[AuthResult, Depends(authenticate_public_caller)]


async def authenticate_and_stamp_public_caller(request: Request, auth: DualAuth) -> AuthResult:
    """Authenticate a public caller, then stamp workspace/plan for rate limiting.

    The dual-credential analog of :func:`authenticate_and_stamp_identity`: both
    credential kinds carry ``workspace_id`` and ``billing_plan`` for
    project-scoped requests, so the stamping is identical. It runs during
    dependency resolution — before slowapi evaluates the limit — so ``key_func``
    sees the identity on ``request.state``.

    Args:
        request (Request): Incoming request; its ``state`` is stamped with the
            resolved rate-limit identity.
        auth (DualAuth): Dual-credential auth dependency resolving the workspace
            and plan.

    Returns:
        AuthResult: The authenticated result, passed through to the route handler.
    """
    clear_request_rate_limit_exempt()
    set_rate_limit_identity(request, auth.workspace_id, auth.billing_plan)
    return auth


DualStampedAuth = Annotated[AuthResult, Depends(authenticate_and_stamp_public_caller)]
