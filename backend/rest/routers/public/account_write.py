"""Account-scope public writes for user credentials (workspace/project create, update, delete).

Thin authenticated proxies to the Next.js internal write routes, which own the
Postgres/Prisma control-plane data and the actual authorization/validation
decisions (role gates, field rules, idempotency, the update diff). Like the
account reads, these run on :data:`AccountStampedAuth` — user-credential-only,
no ``project_id`` query — and additionally on :func:`require_live_session`, so
a JWT whose minting session was revoked is blocked before any write. The
handler forwards only the resolved ``user_id`` (as ``actorUserId``) plus the
payload — never the raw credential — and stamps ``transport: "public-api"``
for the audit trail.

Updates are PATCH: the handler forwards exactly the fields the caller sent
(an explicit null included, meaning clear), so the write service can tell an
untouched field from a cleared one. Deletes take their tenancy and the
required ``reason`` as query parameters on the public surface and forward
them as a JSON body to the internal route, which is service-to-service.

Upstream error strings pass through verbatim as the public ``detail``: the
write service's messages are the single source of truth for both the cookie
and the public surface, so the two never drift.
"""

import logging
from typing import Annotated, Any
from urllib.parse import quote

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status
from pydantic import AfterValidator, BaseModel, ValidationError

from rest.rate_limit import (
    BUCKET_WRITE,
    is_request_rate_limit_exempt,
    key_write,
    limiter,
    resolve_limit,
)
from rest.routers.public.deps import AccountStampedAuth, AuthResult, require_live_session
from rest.schemas.eval import ErrorResponse
from rest.schemas.public_write import (
    CreateProjectRequest,
    CreateProjectResponse,
    CreateWorkspaceRequest,
    CreateWorkspaceResponse,
    DeletedResource,
    DeleteProjectResponse,
    DeleteWorkspaceResponse,
    ProjectRow,
    UpdateProjectRequest,
    UpdateProjectResponse,
    UpdateWorkspaceRequest,
    UpdateWorkspaceResponse,
    WorkspaceRow,
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
    status.HTTP_409_CONFLICT: "Name already in use",
}

_WRITE_ERROR_RESPONSES: dict[int | str, dict[str, Any]] = {
    400: {"model": ErrorResponse, "description": "Invalid request"},
    401: {"model": ErrorResponse, "description": "Authentication failed or session revoked"},
    403: {"model": ErrorResponse, "description": "Insufficient role or wrong credential kind"},
    404: {"model": ErrorResponse, "description": "Not found"},
    503: {"model": ErrorResponse, "description": "Write service unavailable"},
}

# The updates that can collide on a unique name document the conflict beside
# the shared write errors.
_NAME_CONFLICT_RESPONSES: dict[int | str, dict[str, Any]] = {
    **_WRITE_ERROR_RESPONSES,
    409: {"model": ErrorResponse, "description": "Name already in use"},
}


def _require_substantive_reason(reason: str) -> str:
    """Refuse a reason that is blank once stripped, so it never reaches the service.

    ``min_length`` counts whitespace, so without this a reason of three spaces
    would be forwarded and bounce back as the write service's 400.

    Args:
        reason (str): The raw ``reason`` query value.

    Returns:
        str: ``reason`` unchanged.

    Raises:
        ValueError: When the stripped reason is shorter than three characters.
    """
    if len(reason.strip()) < 3:
        raise ValueError("must contain at least 3 non-whitespace characters")
    return reason


# The query aliases every delete shares. A delete takes its tenancy and its
# reason in the query (a DELETE body is legal but poorly supported by tooling).
# The reason is required on the API itself so no client can skip it: it is
# the consent step and the audit trail.
DeleteReason = Annotated[
    str,
    Query(
        min_length=3,
        max_length=500,
        description="Why the resource is being deleted; recorded on the audit row",
    ),
    AfterValidator(_require_substantive_reason),
]
DeleteProjectId = Annotated[str, Query(description="The project the resource belongs to")]


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


async def _send_internal_write(method: str, path: str, payload: dict) -> dict:
    """Send a write to an internal write route and return its success body.

    The single proxy call every public write goes through: creates (POST),
    partial updates (PATCH) and deletes (DELETE) alike — the internal DELETE
    reads its envelope from a JSON body, which is unremarkable
    service-to-service. Client errors the write service owns (400/403/404/
    409) pass through with the SAME status and the upstream body's ``error``
    string as the public ``detail`` — the service's messages are canonical,
    and the raw body is never surfaced. Everything ambiguous fails closed as
    a 503: a network error, a malformed body, or a 401 — the internal secret
    is ours, so an upstream 401 is our misconfiguration, not the caller's
    credential failing.

    Args:
        method (str): The HTTP method (``"POST"``, ``"PATCH"``, ``"DELETE"``).
        path (str): Internal write route path (appended to the UI base URL),
            e.g. ``"/api/internal/write/workspaces"``.
        payload (dict): The camelCase JSON body (actor envelope + fields;
            never logged).

    Returns:
        dict: The parsed 200 response body (the resource envelope, e.g.
            ``{"created": bool, "<resource>": {...}}``).

    Raises:
        HTTPException: 400/403/404/409 passed through from the write service
            with its own ``error`` string as ``detail``; 503 (fail closed) on
            a network error, an upstream 401, any other unexpected status, or
            a malformed body.
    """
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.request(
                method,
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


def _resource_path(resource: str, resource_id: str, suffix: str = "") -> str:
    """Build an internal write route path for one resource by id.

    The id is percent-encoded (including ``/``) before it is spliced into the
    path, so a reserved character in a public path parameter cannot rewrite
    the internal request's path or query.

    Args:
        resource (str): The plural resource segment, e.g. ``"detectors"``.
        resource_id (str): The resource id from the public path.
        suffix (str): An optional sub-route, e.g. ``"/status"``.

    Returns:
        str: ``"/api/internal/write/{resource}/{id}{suffix}"``.
    """
    return f"/api/internal/write/{resource}/{quote(resource_id, safe='')}{suffix}"


def _camel(name: str) -> str:
    """Convert a public snake_case field name to the internal camelCase one.

    Args:
        name (str): A snake_case field name, e.g. ``"trace_ttl_days"``.

    Returns:
        str: The camelCase name, e.g. ``"traceTtlDays"``.
    """
    head, *rest = name.split("_")
    return head + "".join(part.capitalize() for part in rest)


def _envelope(auth: AuthResult, **fields: Any) -> dict[str, Any]:
    """Build an internal write body: the actor envelope around the given fields.

    Args:
        auth (AuthResult): The resolved account-scope credential; its
            ``user_id`` becomes the actor (the raw credential never travels).
        **fields (Any): The camelCase body fields — the tenancy id where the
            resource has one (``projectId=...``) plus the resource fields.

    Returns:
        dict[str, Any]: ``{"actorUserId", <fields>, "transport": "public-api"}``.
    """
    return {"actorUserId": auth.user_id, **fields, "transport": "public-api"}


def _patch_body(auth: AuthResult, payload: BaseModel) -> dict[str, Any]:
    """Build the internal PATCH body: the envelope plus only the sent fields.

    ``model_dump(exclude_unset=True)`` is what makes the null rule mechanical:
    a field the caller left out never appears, a field sent as null crosses as
    null. Nested models dump recursively under the same rule, so a widget spec
    forwards exactly the keys the caller provided. Top-level names are
    converted to the internal camelCase (which also maps a body ``project_id``
    onto the envelope's ``projectId``); nested models keep their own wire
    names, so a handler whose nested shape differs re-maps it by hand.

    Args:
        auth (AuthResult): The resolved account-scope credential.
        payload (BaseModel): The validated ``Update*Request``.

    Returns:
        dict[str, Any]: The camelCase JSON body for the internal PATCH.
    """
    fields = {_camel(name): value for name, value in payload.model_dump(exclude_unset=True).items()}
    return _envelope(auth, **fields)


def _workspace_fields(workspace: Any) -> dict[str, Any]:
    """Map an internal workspace row to :class:`WorkspaceRow` kwargs.

    Args:
        workspace (Any): The ``workspace`` object of an internal response.

    Returns:
        dict[str, Any]: Keyword arguments for the response model.

    Raises:
        KeyError: If a required field is missing (the caller fails closed).
        TypeError: If the row is not a mapping (the caller fails closed).
    """
    return {"id": workspace["id"], "name": workspace["name"], "role": workspace["role"]}


def _project_fields(project: Any) -> dict[str, Any]:
    """Map an internal project row to :class:`ProjectRow` kwargs.

    Args:
        project (Any): The ``project`` object of an internal response.

    Returns:
        dict[str, Any]: Keyword arguments for the response model.

    Raises:
        KeyError: If a required field is missing (the caller fails closed).
        TypeError: If the row is not a mapping (the caller fails closed).
    """
    return {"id": project["id"], "name": project["name"], "workspace_id": project["workspaceId"]}


def _deleted(row: Any) -> DeletedResource:
    """Map the ``{id, name}`` a delete returns to :class:`DeletedResource`.

    Args:
        row (Any): The ``<resource>`` object of an internal delete response.

    Returns:
        DeletedResource: The removed row's id and name.

    Raises:
        KeyError: If a field is missing (the caller fails closed).
        TypeError: If the row is not a mapping (the caller fails closed).
        ValidationError: If a field is wrongly typed (the caller fails closed).
    """
    return DeletedResource(id=row["id"], name=row["name"])


@router.post(
    "/workspaces",
    operation_id="create_workspace",
    response_model=CreateWorkspaceResponse,
    responses={
        **_WRITE_ERROR_RESPONSES,
        409: {
            "model": ErrorResponse,
            "description": "Name already used by a workspace the user no longer administers",
        },
    },
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
    data = await _send_internal_write(
        "POST", "/api/internal/write/workspaces", _envelope(auth, name=payload.name)
    )
    try:
        return CreateWorkspaceResponse(
            **_workspace_fields(data["workspace"]), created=data["created"]
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
    body = _envelope(auth, workspaceId=payload.workspace_id, name=payload.name)
    # Unset optionals stay out of the body entirely — the internal zod
    # distinguishes absent from null in places, and absent is always safe.
    if payload.trace_ttl_days is not None:
        body["traceTtlDays"] = payload.trace_ttl_days
    data = await _send_internal_write("POST", "/api/internal/write/projects", body)
    try:
        return CreateProjectResponse(**_project_fields(data["project"]), created=data["created"])
    except (KeyError, TypeError, ValidationError) as e:
        raise _write_service_error() from e


@router.patch(
    "/workspaces/{workspace_id}",
    operation_id="update_workspace",
    response_model=UpdateWorkspaceResponse,
    responses=_NAME_CONFLICT_RESPONSES,
    summary="Rename a workspace",
)
@limiter.shared_limit(
    resolve_limit, scope=BUCKET_WRITE, key_func=key_write, exempt_when=is_request_rate_limit_exempt
)
async def update_workspace(
    request: Request,
    response: Response,
    auth: AccountStampedAuth,
    workspace_id: str,
    payload: UpdateWorkspaceRequest,
    _live: LiveSession,
) -> UpdateWorkspaceResponse:
    """Rename a workspace the authenticated user administers.

    Requires ADMIN role in the workspace (the write service decides).
    Workspace membership is the tenancy here, so a workspace outside the
    caller's memberships is a 403 rather than a 404, as on the project
    create; a name the caller already administers a workspace under is a
    409.

    Args:
        request (Request): Incoming request (rate-limit plumbing).
        response (Response): Outgoing response (rate-limit plumbing).
        auth (AccountStampedAuth): Account-scope user auth (session token or
            CLI access JWT); its resolved ``user_id`` becomes the actor.
        workspace_id (str): The workspace to edit.
        payload (UpdateWorkspaceRequest): The fields to change.
        _live (None): Write-path liveness gate (blocks a revoked JWT session).

    Returns:
        UpdateWorkspaceResponse: The updated workspace and the changed fields.

    Raises:
        HTTPException: The write service's 400/403/404/409 verbatim, or a
            503 when its response is ambiguous.
    """
    data = await _send_internal_write(
        "PATCH", _resource_path("workspaces", workspace_id), _patch_body(auth, payload)
    )
    try:
        return UpdateWorkspaceResponse(
            updated=data["updated"],
            changed=data["changed"],
            workspace=WorkspaceRow(**_workspace_fields(data["workspace"])),
        )
    except (KeyError, TypeError, ValidationError) as e:
        raise _write_service_error() from e


@router.patch(
    "/projects/{project_id}",
    operation_id="update_project",
    response_model=UpdateProjectResponse,
    responses=_NAME_CONFLICT_RESPONSES,
    summary="Edit a project",
)
@limiter.shared_limit(
    resolve_limit, scope=BUCKET_WRITE, key_func=key_write, exempt_when=is_request_rate_limit_exempt
)
async def update_project(
    request: Request,
    response: Response,
    auth: AccountStampedAuth,
    project_id: str,
    payload: UpdateProjectRequest,
    _live: LiveSession,
) -> UpdateProjectResponse:
    """Edit a project's name or trace retention.

    Requires ADMIN role in the project's workspace (the write service
    decides). A null ``trace_ttl_days`` returns retention to the plan default.

    Args:
        request (Request): Incoming request (rate-limit plumbing).
        response (Response): Outgoing response (rate-limit plumbing).
        auth (AccountStampedAuth): Account-scope user auth (session token or
            CLI access JWT); its resolved ``user_id`` becomes the actor.
        project_id (str): The project to edit.
        payload (UpdateProjectRequest): The fields to change.
        _live (None): Write-path liveness gate (blocks a revoked JWT session).

    Returns:
        UpdateProjectResponse: The updated project and the changed fields.

    Raises:
        HTTPException: The write service's 400/403/404/409 verbatim, or a
            503 when its response is ambiguous.
    """
    data = await _send_internal_write(
        "PATCH", _resource_path("projects", project_id), _patch_body(auth, payload)
    )
    try:
        return UpdateProjectResponse(
            updated=data["updated"],
            changed=data["changed"],
            project=ProjectRow(**_project_fields(data["project"])),
        )
    except (KeyError, TypeError, ValidationError) as e:
        raise _write_service_error() from e


@router.delete(
    "/workspaces/{workspace_id}",
    operation_id="delete_workspace",
    response_model=DeleteWorkspaceResponse,
    responses={
        **_WRITE_ERROR_RESPONSES,
        409: {
            "model": ErrorResponse,
            "description": "The typed name does not match, or this is the caller's only workspace",
        },
    },
    summary="Delete a workspace",
)
@limiter.shared_limit(
    resolve_limit, scope=BUCKET_WRITE, key_func=key_write, exempt_when=is_request_rate_limit_exempt
)
async def delete_workspace(
    request: Request,
    response: Response,
    auth: AccountStampedAuth,
    workspace_id: str,
    name: Annotated[str, Query(description="The workspace's current name, typed as confirmation")],
    reason: DeleteReason,
    _live: LiveSession,
) -> DeleteWorkspaceResponse:
    """Hard-delete a workspace and everything in it.

    Requires ADMIN role in the workspace (the write service decides); a
    workspace outside the caller's memberships is a 403, as on the update.
    The cascade removes every project, its data references, access keys,
    memberships and invites; the typed ``name`` must equal the workspace's
    current name, and the caller's only workspace cannot be deleted.

    Args:
        request (Request): Incoming request (rate-limit plumbing).
        response (Response): Outgoing response (rate-limit plumbing).
        auth (AccountStampedAuth): Account-scope user auth (session token or
            CLI access JWT); its resolved ``user_id`` becomes the actor.
        workspace_id (str): The workspace to delete.
        name (str): The workspace's current name, as a typed confirmation.
        reason (str): Why it is being deleted; recorded on the audit row.
        _live (None): Write-path liveness gate (blocks a revoked JWT session).

    Returns:
        DeleteWorkspaceResponse: The removed workspace and the cascade counts.

    Raises:
        HTTPException: The write service's 400/403/404/409 verbatim, or a
            503 when its response is ambiguous.
    """
    data = await _send_internal_write(
        "DELETE",
        _resource_path("workspaces", workspace_id),
        _envelope(auth, name=name, reason=reason),
    )
    try:
        return DeleteWorkspaceResponse(
            deleted=data["deleted"],
            reason=data["reason"],
            cascaded=data.get("cascaded"),
            workspace=_deleted(data["workspace"]),
        )
    except (KeyError, TypeError, ValidationError) as e:
        raise _write_service_error() from e


@router.delete(
    "/projects/{project_id}",
    operation_id="delete_project",
    response_model=DeleteProjectResponse,
    responses=_WRITE_ERROR_RESPONSES,
    summary="Delete a project",
)
@limiter.shared_limit(
    resolve_limit, scope=BUCKET_WRITE, key_func=key_write, exempt_when=is_request_rate_limit_exempt
)
async def delete_project(
    request: Request,
    response: Response,
    auth: AccountStampedAuth,
    project_id: str,
    reason: DeleteReason,
    _live: LiveSession,
) -> DeleteProjectResponse:
    """Soft-delete a project.

    Requires ADMIN role in the project's workspace (the write service
    decides). The project drops out of every list and read and its access
    keys stop authenticating; its data stays for the retention window.

    Args:
        request (Request): Incoming request (rate-limit plumbing).
        response (Response): Outgoing response (rate-limit plumbing).
        auth (AccountStampedAuth): Account-scope user auth (session token or
            CLI access JWT); its resolved ``user_id`` becomes the actor.
        project_id (str): The project to delete.
        reason (str): Why it is being deleted; recorded on the audit row.
        _live (None): Write-path liveness gate (blocks a revoked JWT session).

    Returns:
        DeleteProjectResponse: The removed project.

    Raises:
        HTTPException: The write service's 400/403/404 verbatim, or a 503
            when its response is ambiguous.
    """
    data = await _send_internal_write(
        "DELETE", _resource_path("projects", project_id), _envelope(auth, reason=reason)
    )
    try:
        return DeleteProjectResponse(
            deleted=data["deleted"], reason=data["reason"], project=_deleted(data["project"])
        )
    except (KeyError, TypeError, ValidationError) as e:
        raise _write_service_error() from e
