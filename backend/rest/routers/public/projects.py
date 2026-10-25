"""The first-key write for the ``traceroot setup`` wizard.

One write the onboarding wizard cannot work without: minting a project its first
API key. It runs under a **user** credential, because it happens before any
project key exists — a project key knows exactly one project, so asking it to
mint that project's first key is circular.

Deliberately just this one, plus its undo. This is not a general write API, and
it should not grow into one: everything else a user writes has a browser surface
that already owns it. This exists only because onboarding has no key yet, so
nothing else can produce one. The revoke beside it exists for the same reason:
a run that fails after minting must take its keys back, and the key-authenticated
revoke cannot remove the key making the request.

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
import re
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

# The body is buffered into this process before anything validates it, and the
# only limit downstream is 100 characters on `name` — checked after the parse.
# Sized well above the largest legal body (three short fields) and far below
# anything that would pressure a worker. The eval proxy carries the same ceiling
# for the same reason; extracting one shared reader is tracked separately.
_MAX_BODY_BYTES = 64 * 1024

# One path segment: an opaque id, deliberately narrow. The eval gateway's
# `_SEGMENT_RE` is the same class, so a key id the other public routes refuse is
# refused here too: no `/`, `%`, `\`, `:` or whitespace, and nothing over 128.
_PATH_SEGMENT_RE = re.compile(r"[A-Za-z0-9_.~-]{1,128}")

# Dot-segments match the character class above, so they are excluded by name.
_DOT_SEGMENTS = frozenset({".", ".."})


async def _read_capped_body(request: Request) -> bytes:
    """Buffer the request body, refusing anything over ``_MAX_BODY_BYTES``.

    A declared ``Content-Length`` is rejected up front so an oversized upload is
    refused before it is read; the streaming check is what actually enforces the
    cap, since a chunked or mis-declared body has no trustworthy length.

    Raises:
        HTTPException: 413 if the body exceeds the cap.
    """
    declared = request.headers.get("content-length")
    if declared is not None and declared.isdigit() and int(declared) > _MAX_BODY_BYTES:
        raise HTTPException(
            status_code=status.HTTP_413_CONTENT_TOO_LARGE,
            detail="Request body too large",
        )
    chunks: list[bytes] = []
    total = 0
    async for chunk in request.stream():
        total += len(chunk)
        if total > _MAX_BODY_BYTES:
            raise HTTPException(
                status_code=status.HTTP_413_CONTENT_TOO_LARGE,
                detail="Request body too large",
            )
        chunks.append(chunk)
    return b"".join(chunks)


def _path_segment(value: str) -> str:
    """Validate one caller-supplied path segment before it is forwarded.

    Args:
        value (str): The caller-supplied segment, such as a key id.

    Returns:
        str: ``value`` unchanged, once it is known to be one opaque segment.

    Raises:
        HTTPException: 404 if it is not. A 404 rather than a 400, matching the
            eval gateway's answer to the same input.
    """
    if value in _DOT_SEGMENTS or not _PATH_SEGMENT_RE.fullmatch(value):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found")
    return value


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


async def _call_internal(
    route: str, payload: dict[str, Any], required: dict[str, type]
) -> Response:
    """Perform one write against a Next.js internal route.

    The control plane owns the workspace/project tables, so the write itself
    happens there. This forwards the already-authenticated ``user_id`` in the
    body under ``X-Internal-Secret``; the raw credential never leaves this
    process. Ids and minted secrets are never logged.

    Args:
        route (str): The internal route name under ``/api/internal/``.
        payload (dict[str, Any]): Request body, including the resolved
            ``userId``.
        required (dict[str, type]): The fields a success from this route must
            carry, and their types. A mint that answered 201 without its key
            would otherwise read as done when nothing usable came back.

    Returns:
        Response: The internal route's JSON body and status, relayed verbatim so
            a 400/403/404/409 keeps its meaning for the caller. Error bodies are
            normalised to ``{"detail": ...}``, the shape public clients expect.

    Raises:
        HTTPException: 503 (fail closed) on a network error, a malformed body,
            an error without a string ``error``, or a success missing a
            required field.
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
        # The internal routes answer `{error}`; public clients read `{detail}`,
        # always a string. An error body without one is as ambiguous as a
        # non-JSON body, so it fails closed the same way.
        error = body.get("error")
        if not isinstance(error, str):
            logger.error("Project service returned an error without a message")
            raise _project_service_error()
        raise HTTPException(status_code=upstream.status_code, detail=error)

    if any(not isinstance(body.get(field), kind) for field, kind in required.items()):
        logger.error("Project service returned a success without its required fields")
        raise _project_service_error()

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

    A mint can commit and still lose its reply: the control plane writes the key,
    then the answer times out, drops, or arrives in a shape this cannot read. The
    caller then gets a 503 although the key exists, and a retry under the same
    name gets a 409, because the name is now taken. The secret is not
    recoverable, since it was only ever in the lost reply, so a caller retries
    under a new name, and the first key stays live until it is revoked.

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
        body = json.loads(await _read_capped_body(request))
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

    return await _call_internal("user-create-project-key", payload, {"id": str, "key": str})


@router.delete(
    "/{project_id}/api-keys/{key_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    include_in_schema=False,
)
@limiter.shared_limit(
    resolve_limit, scope=BUCKET_WRITE, key_func=key_write, exempt_when=is_request_rate_limit_exempt
)
async def revoke_project_api_key(
    project_id: str,
    key_id: str,
    request: Request,
    response: Response,
    auth: AccountStampedAuth,
    _live: LiveSession,
) -> Response:
    """Revoke an API key in one of this user's projects.

    The undo of :func:`create_project_api_key`, for a setup run that fails after
    minting. ``DELETE /public/api-keys/{id}`` cannot serve it: it authenticates
    with an admin key of the same project and refuses to revoke that key itself.

    The control plane runs the dashboard's own revoke, so a login can revoke
    exactly what it could in the browser: the workspace admin role, and a key
    outside ``project_id`` is a 404, never revoked.

    Args:
        project_id (str): The project the key belongs to.
        key_id (str): The key to revoke; one opaque path segment.
        request (Request): Incoming request (rate-limit plumbing).
        response (Response): Outgoing response (rate-limit plumbing).
        auth (AccountStampedAuth): Account-scope user auth (session token or CLI
            access JWT); carries the resolved ``user_id``.
        _live (LiveSession): Refuses a JWT whose minting session has been revoked
            or expired, as on the mint.

    Returns:
        Response: 204 once the key is revoked.

    Raises:
        HTTPException: 404 for a key id that is not one opaque segment, before
            anything is forwarded; otherwise the control plane's 403/404
            verbatim, or a 503 when its response is ambiguous.
    """
    payload: dict[str, Any] = {
        "userId": auth.user_id,
        "projectId": project_id,
        "keyId": _path_segment(key_id),
    }
    await _call_internal("user-revoke-project-key", payload, {"deleted": bool})
    return Response(status_code=status.HTTP_204_NO_CONTENT)
