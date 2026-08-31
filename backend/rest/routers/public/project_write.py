"""Project-scoped public writes for user credentials (detector/dashboard/widget).

The project-scoped siblings of the account writes: the target ``project_id``
travels in the request body and the write service resolves the actor's
membership/role from it, so these run on the same account-scope credential
(:data:`AccountStampedAuth` + :func:`require_live_session`) and share the
account-write module's proxy helper, error mapping, and passthrough semantics.
"""

from typing import Any

from fastapi import APIRouter, Request, Response

from rest.rate_limit import (
    BUCKET_WRITE,
    is_request_rate_limit_exempt,
    key_write,
    limiter,
    resolve_limit,
)
from rest.routers.public.account_write import (
    _WRITE_ERROR_RESPONSES,
    LiveSession,
    _post_internal_write,
    _write_service_error,
)
from rest.routers.public.deps import AccountStampedAuth
from rest.schemas.public_write import (
    CreateDashboardRequest,
    CreateDashboardResponse,
    CreateDetectorRequest,
    CreateDetectorResponse,
    CreateWidgetRequest,
    CreateWidgetResponse,
)

router = APIRouter(prefix="/public", tags=["Project (Public)"])


@router.post(
    "/detectors",
    operation_id="create_detector",
    response_model=CreateDetectorResponse,
    responses=_WRITE_ERROR_RESPONSES,
    summary="Create a detector",
)
@limiter.shared_limit(
    resolve_limit, scope=BUCKET_WRITE, key_func=key_write, exempt_when=is_request_rate_limit_exempt
)
async def create_detector(
    request: Request,
    response: Response,
    auth: AccountStampedAuth,
    payload: CreateDetectorRequest,
    _live: LiveSession,
) -> CreateDetectorResponse:
    """Create a detector in a project the authenticated user can write to.

    Requires MEMBER role or higher in the project's workspace (the write
    service decides). Idempotent on the detector name within the project.

    Args:
        request (Request): Incoming request (rate-limit plumbing).
        response (Response): Outgoing response (rate-limit plumbing).
        auth (AccountStampedAuth): Account-scope user auth (session token or
            CLI access JWT); its resolved ``user_id`` becomes the actor.
        payload (CreateDetectorRequest): The detector to create.
        _live (None): Write-path liveness gate (blocks a revoked JWT session).

    Returns:
        CreateDetectorResponse: The created (or matched) detector.
    """
    body: dict[str, Any] = {
        "actorUserId": auth.user_id,
        "projectId": payload.project_id,
        "name": payload.name,
        "template": payload.template,
        "transport": "public-api",
    }
    # Unset optionals stay out of the body entirely — the internal zod
    # distinguishes absent from null in places, and absent is always safe.
    # An absent prompt in particular tells the write service to fill the
    # canonical instructions of a standard template.
    optionals = {
        "prompt": payload.prompt,
        "sampleRate": payload.sample_rate,
        "outputSchema": payload.output_schema,
        "triggerConditions": payload.trigger_conditions,
        "detectionSource": payload.detection_source,
        "detectionModel": payload.detection_model,
        "detectionProvider": payload.detection_provider,
        "enableRca": payload.enable_rca,
        "enabled": payload.enabled,
    }
    body.update({key: value for key, value in optionals.items() if value is not None})
    data = await _post_internal_write("/api/internal/write/detectors", body)
    try:
        detector = data["detector"]
        return CreateDetectorResponse(
            id=detector["id"],
            name=detector["name"],
            project_id=detector["projectId"],
            enabled=detector["enabled"],
            sample_rate=detector["sampleRate"],
            created=data["created"],
        )
    except (KeyError, TypeError) as e:
        raise _write_service_error() from e


@router.post(
    "/dashboards",
    operation_id="create_dashboard",
    response_model=CreateDashboardResponse,
    responses=_WRITE_ERROR_RESPONSES,
    summary="Create a dashboard",
)
@limiter.shared_limit(
    resolve_limit, scope=BUCKET_WRITE, key_func=key_write, exempt_when=is_request_rate_limit_exempt
)
async def create_dashboard(
    request: Request,
    response: Response,
    auth: AccountStampedAuth,
    payload: CreateDashboardRequest,
    _live: LiveSession,
) -> CreateDashboardResponse:
    """Create a dashboard in a project the authenticated user can write to.

    Requires MEMBER role or higher in the project's workspace (the write
    service decides). Idempotent on the dashboard name within the project.

    Args:
        request (Request): Incoming request (rate-limit plumbing).
        response (Response): Outgoing response (rate-limit plumbing).
        auth (AccountStampedAuth): Account-scope user auth (session token or
            CLI access JWT); its resolved ``user_id`` becomes the actor.
        payload (CreateDashboardRequest): The dashboard to create.
        _live (None): Write-path liveness gate (blocks a revoked JWT session).

    Returns:
        CreateDashboardResponse: The created (or matched) dashboard.
    """
    body: dict[str, Any] = {
        "actorUserId": auth.user_id,
        "projectId": payload.project_id,
        "name": payload.name,
        "transport": "public-api",
    }
    if payload.description is not None:
        body["description"] = payload.description
    data = await _post_internal_write("/api/internal/write/dashboards", body)
    try:
        dashboard = data["dashboard"]
        return CreateDashboardResponse(
            id=dashboard["id"],
            name=dashboard["name"],
            project_id=dashboard["projectId"],
            created=data["created"],
        )
    except (KeyError, TypeError) as e:
        raise _write_service_error() from e


@router.post(
    "/widgets",
    operation_id="create_widget",
    response_model=CreateWidgetResponse,
    responses=_WRITE_ERROR_RESPONSES,
    summary="Create a dashboard widget",
)
@limiter.shared_limit(
    resolve_limit, scope=BUCKET_WRITE, key_func=key_write, exempt_when=is_request_rate_limit_exempt
)
async def create_widget(
    request: Request,
    response: Response,
    auth: AccountStampedAuth,
    payload: CreateWidgetRequest,
    _live: LiveSession,
) -> CreateWidgetResponse:
    """Create a widget on a dashboard the authenticated user can write to.

    Requires MEMBER role or higher in the project's workspace (the write
    service decides). Strict create — never idempotent, ``created`` is always
    ``true`` on success.

    Args:
        request (Request): Incoming request (rate-limit plumbing).
        response (Response): Outgoing response (rate-limit plumbing).
        auth (AccountStampedAuth): Account-scope user auth (session token or
            CLI access JWT); its resolved ``user_id`` becomes the actor.
        payload (CreateWidgetRequest): The widget to create.
        _live (None): Write-path liveness gate (blocks a revoked JWT session).

    Returns:
        CreateWidgetResponse: The created widget.
    """
    body: dict[str, Any] = {
        "actorUserId": auth.user_id,
        "projectId": payload.project_id,
        "dashboardId": payload.dashboard_id,
        "title": payload.title,
        "type": payload.type,
        # Only the fields the caller actually sent: the write service fills its
        # own defaults, and an unset optional (e.g. a predicate's key) must stay
        # absent rather than crossing as an explicit null.
        "spec": payload.spec.model_dump(exclude_unset=True),
        "transport": "public-api",
    }
    if payload.display_config is not None:
        body["displayConfig"] = payload.display_config
    data = await _post_internal_write("/api/internal/write/widgets", body)
    try:
        widget = data["widget"]
        return CreateWidgetResponse(
            id=widget["id"],
            dashboard_id=widget["dashboardId"],
            title=widget["title"],
            type=widget["type"],
            created=data["created"],
        )
    except (KeyError, TypeError) as e:
        raise _write_service_error() from e
