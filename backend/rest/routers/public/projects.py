"""The first-key write for the ``traceroot setup`` wizard.

One write the onboarding wizard cannot work without: minting a project its first
API key. It runs under a **user** credential, because it happens before any
project key exists — a project key knows exactly one project, so asking it to
mint that project's first key is circular.

Deliberately just this one. This is not a general write API, and it should not
grow into one: everything else a user writes has a browser surface that already
owns it. This exists only because onboarding has no key yet, so nothing else can
produce one.

Project creation is deliberately absent: the public write surface already serves
``POST /api/v1/public/projects``, and the setup wizard always resolves a workspace
before calling it, so a second handler here would only shadow that one.

Reads are deliberately absent. ``list_workspaces`` and ``list_projects`` in
:mod:`rest.routers.public.account_read` already answer "which project?" on the
same credential; a second listing here would shadow that route on the same path.

Authentication is :data:`AccountStampedAuth`, so both credential kinds (session
token and CLI access JWT) are handled in one place. The handler forwards only
the resolved ``user_id`` to the Next.js internal route that owns the write —
never the raw credential — matching :mod:`rest.routers.public.account_read`.
"""

import json
import logging
from typing import Any

import httpx
from fastapi import APIRouter, HTTPException, Request, Response, status

from rest.rate_limit import (
    BUCKET_WRITE,
    is_request_rate_limit_exempt,
    key_write,
    limiter,
    resolve_limit,
)
from rest.routers.public.account_write import LiveSession
from rest.routers.public.deps import AccountStampedAuth
from shared.config import settings

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/public/projects", tags=["Projects (Public)"])


def _project_service_error() -> HTTPException:
    """Build the controlled 503 used whenever the project service is ambiguous.

    A shared fail-closed error so any upstream ambiguity — a network failure,
    a non-JSON body, or a malformed payload — surfaces as a 503 rather than an
    uncaught 500 (parity with the account-read sibling).

    Returns:
        HTTPException: A 503 with a generic ``Project service error`` detail.
    """
    return HTTPException(
        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        detail="Project service error",
    )


async def _call_internal(route: str, payload: dict[str, Any]) -> Response:
    """Perform one write against a Next.js internal route.

    The control plane owns the workspace/project tables, so the write itself
    happens there. This forwards the already-authenticated ``user_id`` in the
    body under ``X-Internal-Secret``; the raw credential never leaves this
    process. Ids and minted secrets are never logged.

    Args:
        route (str): The internal route name under ``/api/internal/``.
        payload (dict[str, Any]): Request body, including the resolved
            ``userId``.

    Returns:
        Response: The internal route's JSON body and status, relayed verbatim so
            a 400/403/404/409 keeps its meaning for the caller. Error bodies are
            normalised to ``{"detail": ...}``, the shape public clients expect.

    Raises:
        HTTPException: 503 (fail closed) on a network error or a malformed body.
    """
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            upstream = await client.post(
                f"{settings.traceroot_ui_url}/api/internal/{route}",
                json=payload,
                headers={"X-Internal-Secret": settings.internal_api_secret},
            )
    except httpx.RequestError as e:
        logger.error(f"Project write failed to reach the control plane: {e}")
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Project service unavailable",
        ) from e

    try:
        body = upstream.json()
    except ValueError as e:
        logger.error(f"Malformed JSON from project service: {e}")
        raise _project_service_error() from e

    if not isinstance(body, dict):
        logger.error("Project service returned a non-object body")
        raise _project_service_error()

    if upstream.status_code >= 400:
        # The internal routes answer `{error}`; public clients read `{detail}`.
        raise HTTPException(
            status_code=upstream.status_code,
            detail=body.get("error", "Project request failed"),
        )

    body.pop("valid", None)
    return Response(
        content=json.dumps(body),
        status_code=upstream.status_code,
        media_type="application/json",
    )


@router.post("/{project_id}/api-keys", include_in_schema=False)
@limiter.shared_limit(
    resolve_limit, scope=BUCKET_WRITE, key_func=key_write, exempt_when=is_request_rate_limit_exempt
)
async def create_project_api_key(
    project_id: str,
    request: Request,
    response: Response,
    auth: AccountStampedAuth,
    _live: LiveSession,
) -> Response:
    """Mint an API key for one of this user's projects.

    Distinct from ``POST /public/api-keys``, which authenticates with a key for
    the same project it mints into — useful for rotation, useless before the
    first key exists.

    Args:
        project_id (str): The project to mint into.
        request (Request): Incoming request; the JSON body carries ``name`` and
            optionally ``scope`` / ``expires_in_days``.
        response (Response): Outgoing response (rate-limit plumbing).
        auth (AccountStampedAuth): Account-scope user auth (session token or CLI
            access JWT); carries the resolved ``user_id``.
        _live (LiveSession): Refuses a JWT whose minting session has been revoked
            or expired. The key minted here does not expire by default, so a
            revoked token must not be able to leave one behind.

    Returns:
        Response: 201 with the minted key, which appears in this response and
            nowhere else, or the control plane's error.
    """
    try:
        body = await request.json()
    except ValueError as e:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="Request body must be JSON"
        ) from e
    if not isinstance(body, dict):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="Request body must be a JSON object"
        )

    payload: dict[str, Any] = {
        "userId": auth.user_id,
        "projectId": project_id,
        "name": body.get("name"),
    }
    if body.get("scope") is not None:
        payload["scope"] = body["scope"]
    if body.get("expires_in_days") is not None:
        payload["expiresInDays"] = body["expires_in_days"]

    return await _call_internal("user-create-project-key", payload)
