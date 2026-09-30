"""Project-scoped public writes for user credentials (detector/dashboard/widget).

The project-scoped siblings of the account writes: the target ``project_id``
travels in the request body (or the query, on a delete) and the write service
resolves the actor's membership/role from it, so these run on the same
account-scope credential (:data:`AccountStampedAuth` +
:func:`require_live_session`) and share the account-write module's proxy
helper, body builders, error mapping, and passthrough semantics.
"""

from typing import Any

from fastapi import APIRouter, Request, Response
from pydantic import ValidationError

from rest.rate_limit import (
    BUCKET_WRITE,
    is_request_rate_limit_exempt,
    key_write,
    limiter,
    resolve_limit,
)
from rest.routers.public.account_write import (
    _NAME_CONFLICT_RESPONSES,
    _WRITE_ERROR_RESPONSES,
    DeleteProjectId,
    DeleteReason,
    LiveSession,
    _deleted,
    _envelope,
    _patch_body,
    _resource_path,
    _send_internal_write,
    _write_service_error,
)
from rest.routers.public.deps import AccountStampedAuth
from rest.schemas.eval import ErrorResponse
from rest.schemas.public_write import (
    CreateDashboardRequest,
    CreateDashboardResponse,
    CreateDetectorRequest,
    CreateDetectorResponse,
    CreateWidgetRequest,
    CreateWidgetResponse,
    DashboardRow,
    DeleteDashboardResponse,
    DeleteDetectorResponse,
    DeleteWidgetResponse,
    DetectorRow,
    UpdateDashboardRequest,
    UpdateDashboardResponse,
    UpdateDetectorRequest,
    UpdateDetectorResponse,
    UpdateWidgetRequest,
    UpdateWidgetResponse,
    WidgetRow,
)

router = APIRouter(prefix="/public", tags=["Project (Public)"])


def _detector_fields(detector: Any) -> dict[str, Any]:
    """Map an internal detector row to :class:`DetectorRow` kwargs.

    Args:
        detector (Any): The ``detector`` object of an internal response.

    Returns:
        dict[str, Any]: Keyword arguments for the response model.

    Raises:
        KeyError: If a required field is missing (the caller fails closed).
        TypeError: If the row is not a mapping (the caller fails closed).
    """
    return {
        "id": detector["id"],
        "name": detector["name"],
        "project_id": detector["projectId"],
        "enabled": detector["enabled"],
        "sample_rate": detector["sampleRate"],
    }


def _dashboard_fields(dashboard: Any) -> dict[str, Any]:
    """Map an internal dashboard row to :class:`DashboardRow` kwargs.

    Args:
        dashboard (Any): The ``dashboard`` object of an internal response.

    Returns:
        dict[str, Any]: Keyword arguments for the response model.

    Raises:
        KeyError: If a required field is missing (the caller fails closed).
        TypeError: If the row is not a mapping (the caller fails closed).
    """
    return {
        "id": dashboard["id"],
        "name": dashboard["name"],
        "project_id": dashboard["projectId"],
    }


def _widget_fields(widget: Any) -> dict[str, Any]:
    """Map an internal widget row to :class:`WidgetRow` kwargs.

    Args:
        widget (Any): The ``widget`` object of an internal response.

    Returns:
        dict[str, Any]: Keyword arguments for the response model.

    Raises:
        KeyError: If a required field is missing (the caller fails closed).
        TypeError: If the row is not a mapping (the caller fails closed).
    """
    return {
        "id": widget["id"],
        "dashboard_id": widget["dashboardId"],
        "title": widget["title"],
        "type": widget["type"],
    }


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
    body = _envelope(
        auth, projectId=payload.project_id, name=payload.name, template=payload.template
    )
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
    data = await _send_internal_write("POST", "/api/internal/write/detectors", body)
    try:
        return CreateDetectorResponse(**_detector_fields(data["detector"]), created=data["created"])
    except (KeyError, TypeError, ValidationError) as e:
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
    body = _envelope(auth, projectId=payload.project_id, name=payload.name)
    if payload.description is not None:
        body["description"] = payload.description
    data = await _send_internal_write("POST", "/api/internal/write/dashboards", body)
    try:
        return CreateDashboardResponse(
            **_dashboard_fields(data["dashboard"]), created=data["created"]
        )
    except (KeyError, TypeError, ValidationError) as e:
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
    body = _envelope(
        auth,
        projectId=payload.project_id,
        dashboardId=payload.dashboard_id,
        title=payload.title,
        type=payload.type,
        # Only the fields the caller actually sent: the write service fills its
        # own defaults, and an unset optional (e.g. a predicate's key) must stay
        # absent rather than crossing as an explicit null.
        spec=payload.spec.model_dump(exclude_unset=True),
    )
    if payload.display_config is not None:
        body["displayConfig"] = payload.display_config
    data = await _send_internal_write("POST", "/api/internal/write/widgets", body)
    try:
        return CreateWidgetResponse(**_widget_fields(data["widget"]), created=data["created"])
    except (KeyError, TypeError, ValidationError) as e:
        raise _write_service_error() from e


# ── partial updates ─────────────────────────────────────────────────────


@router.patch(
    "/detectors/{detector_id}",
    operation_id="update_detector",
    response_model=UpdateDetectorResponse,
    responses=_NAME_CONFLICT_RESPONSES,
    summary="Edit a detector",
)
@limiter.shared_limit(
    resolve_limit, scope=BUCKET_WRITE, key_func=key_write, exempt_when=is_request_rate_limit_exempt
)
async def update_detector(
    request: Request,
    response: Response,
    auth: AccountStampedAuth,
    detector_id: str,
    payload: UpdateDetectorRequest,
    _live: LiveSession,
) -> UpdateDetectorResponse:
    """Edit a detector in a project the authenticated user can write to.

    Requires MEMBER role or higher in the project's workspace (the write
    service decides). Only the sent fields change; ``template`` is immutable.

    Args:
        request (Request): Incoming request (rate-limit plumbing).
        response (Response): Outgoing response (rate-limit plumbing).
        auth (AccountStampedAuth): Account-scope user auth (session token or
            CLI access JWT); its resolved ``user_id`` becomes the actor.
        detector_id (str): The detector to edit.
        payload (UpdateDetectorRequest): The project and the fields to change.
        _live (None): Write-path liveness gate (blocks a revoked JWT session).

    Returns:
        UpdateDetectorResponse: The updated detector and the changed fields.

    Raises:
        HTTPException: The write service's 400/403/404/409 verbatim, or a
            503 when its response is ambiguous.
    """
    data = await _send_internal_write(
        "PATCH", _resource_path("detectors", detector_id), _patch_body(auth, payload)
    )
    try:
        return UpdateDetectorResponse(
            updated=data["updated"],
            changed=data["changed"],
            detector=DetectorRow(**_detector_fields(data["detector"])),
        )
    except (KeyError, TypeError, ValidationError) as e:
        raise _write_service_error() from e


@router.patch(
    "/dashboards/{dashboard_id}",
    operation_id="update_dashboard",
    response_model=UpdateDashboardResponse,
    responses=_NAME_CONFLICT_RESPONSES,
    summary="Edit a dashboard",
)
@limiter.shared_limit(
    resolve_limit, scope=BUCKET_WRITE, key_func=key_write, exempt_when=is_request_rate_limit_exempt
)
async def update_dashboard(
    request: Request,
    response: Response,
    auth: AccountStampedAuth,
    dashboard_id: str,
    payload: UpdateDashboardRequest,
    _live: LiveSession,
) -> UpdateDashboardResponse:
    """Edit a dashboard's name or description.

    Requires MEMBER role or higher in the project's workspace (the write
    service decides). A null ``description`` clears it.

    Args:
        request (Request): Incoming request (rate-limit plumbing).
        response (Response): Outgoing response (rate-limit plumbing).
        auth (AccountStampedAuth): Account-scope user auth (session token or
            CLI access JWT); its resolved ``user_id`` becomes the actor.
        dashboard_id (str): The dashboard to edit.
        payload (UpdateDashboardRequest): The project and the fields to change.
        _live (None): Write-path liveness gate (blocks a revoked JWT session).

    Returns:
        UpdateDashboardResponse: The updated dashboard and the changed fields.

    Raises:
        HTTPException: The write service's 400/403/404/409 verbatim, or a
            503 when its response is ambiguous.
    """
    data = await _send_internal_write(
        "PATCH", _resource_path("dashboards", dashboard_id), _patch_body(auth, payload)
    )
    try:
        return UpdateDashboardResponse(
            updated=data["updated"],
            changed=data["changed"],
            dashboard=DashboardRow(**_dashboard_fields(data["dashboard"])),
        )
    except (KeyError, TypeError, ValidationError) as e:
        raise _write_service_error() from e


@router.patch(
    "/widgets/{widget_id}",
    operation_id="update_widget",
    response_model=UpdateWidgetResponse,
    responses=_WRITE_ERROR_RESPONSES,
    summary="Edit a dashboard widget",
)
@limiter.shared_limit(
    resolve_limit, scope=BUCKET_WRITE, key_func=key_write, exempt_when=is_request_rate_limit_exempt
)
async def update_widget(
    request: Request,
    response: Response,
    auth: AccountStampedAuth,
    widget_id: str,
    payload: UpdateWidgetRequest,
    _live: LiveSession,
) -> UpdateWidgetResponse:
    """Edit a widget's title, spec, or display config.

    Requires MEMBER role or higher in the project's workspace (the write
    service decides). A sent ``spec`` replaces the whole spec and is checked
    against the widget's stored type by the service; ``type`` is immutable.

    Args:
        request (Request): Incoming request (rate-limit plumbing).
        response (Response): Outgoing response (rate-limit plumbing).
        auth (AccountStampedAuth): Account-scope user auth (session token or
            CLI access JWT); its resolved ``user_id`` becomes the actor.
        widget_id (str): The widget to edit.
        payload (UpdateWidgetRequest): The project and the fields to change.
        _live (None): Write-path liveness gate (blocks a revoked JWT session).

    Returns:
        UpdateWidgetResponse: The updated widget and the changed fields.

    Raises:
        HTTPException: The write service's 400/403/404 verbatim, or a 503
            when its response is ambiguous.
    """
    data = await _send_internal_write(
        "PATCH", _resource_path("widgets", widget_id), _patch_body(auth, payload)
    )
    try:
        return UpdateWidgetResponse(
            updated=data["updated"],
            changed=data["changed"],
            widget=WidgetRow(**_widget_fields(data["widget"])),
        )
    except (KeyError, TypeError, ValidationError) as e:
        raise _write_service_error() from e


# ── deletes ─────────────────────────────────────────────────────────────


@router.delete(
    "/detectors/{detector_id}",
    operation_id="delete_detector",
    response_model=DeleteDetectorResponse,
    responses=_WRITE_ERROR_RESPONSES,
    summary="Delete a detector",
)
@limiter.shared_limit(
    resolve_limit, scope=BUCKET_WRITE, key_func=key_write, exempt_when=is_request_rate_limit_exempt
)
async def delete_detector(
    request: Request,
    response: Response,
    auth: AccountStampedAuth,
    detector_id: str,
    project_id: DeleteProjectId,
    reason: DeleteReason,
    _live: LiveSession,
) -> DeleteDetectorResponse:
    """Hard-delete a detector; its existing findings stay readable.

    Requires MEMBER role or higher in the project's workspace (the write
    service decides). Not idempotent: a second delete of the same id is a 404.

    Args:
        request (Request): Incoming request (rate-limit plumbing).
        response (Response): Outgoing response (rate-limit plumbing).
        auth (AccountStampedAuth): Account-scope user auth (session token or
            CLI access JWT); its resolved ``user_id`` becomes the actor.
        detector_id (str): The detector to delete.
        project_id (str): The project the detector belongs to.
        reason (str): Why it is being deleted; recorded on the audit row.
        _live (None): Write-path liveness gate (blocks a revoked JWT session).

    Returns:
        DeleteDetectorResponse: The removed detector.

    Raises:
        HTTPException: The write service's 400/403/404 verbatim, or a 503
            when its response is ambiguous.
    """
    data = await _send_internal_write(
        "DELETE",
        _resource_path("detectors", detector_id),
        _envelope(auth, projectId=project_id, reason=reason),
    )
    try:
        return DeleteDetectorResponse(
            deleted=data["deleted"], reason=data["reason"], detector=_deleted(data["detector"])
        )
    except (KeyError, TypeError, ValidationError) as e:
        raise _write_service_error() from e


@router.delete(
    "/dashboards/{dashboard_id}",
    operation_id="delete_dashboard",
    response_model=DeleteDashboardResponse,
    responses={
        **_WRITE_ERROR_RESPONSES,
        409: {"model": ErrorResponse, "description": "Cannot delete a project's last dashboard"},
    },
    summary="Delete a dashboard",
)
@limiter.shared_limit(
    resolve_limit, scope=BUCKET_WRITE, key_func=key_write, exempt_when=is_request_rate_limit_exempt
)
async def delete_dashboard(
    request: Request,
    response: Response,
    auth: AccountStampedAuth,
    dashboard_id: str,
    project_id: DeleteProjectId,
    reason: DeleteReason,
    _live: LiveSession,
) -> DeleteDashboardResponse:
    """Hard-delete a dashboard together with its widgets.

    Requires MEMBER role or higher in the project's workspace (the write
    service decides). A project's last dashboard cannot be deleted.

    Args:
        request (Request): Incoming request (rate-limit plumbing).
        response (Response): Outgoing response (rate-limit plumbing).
        auth (AccountStampedAuth): Account-scope user auth (session token or
            CLI access JWT); its resolved ``user_id`` becomes the actor.
        dashboard_id (str): The dashboard to delete.
        project_id (str): The project the dashboard belongs to.
        reason (str): Why it is being deleted; recorded on the audit row.
        _live (None): Write-path liveness gate (blocks a revoked JWT session).

    Returns:
        DeleteDashboardResponse: The removed dashboard and its widget count.

    Raises:
        HTTPException: The write service's 400/403/404/409 verbatim, or a
            503 when its response is ambiguous.
    """
    data = await _send_internal_write(
        "DELETE",
        _resource_path("dashboards", dashboard_id),
        _envelope(auth, projectId=project_id, reason=reason),
    )
    try:
        return DeleteDashboardResponse(
            deleted=data["deleted"],
            reason=data["reason"],
            cascaded=data.get("cascaded"),
            dashboard=_deleted(data["dashboard"]),
        )
    except (KeyError, TypeError, ValidationError) as e:
        raise _write_service_error() from e


@router.delete(
    "/widgets/{widget_id}",
    operation_id="delete_widget",
    response_model=DeleteWidgetResponse,
    responses=_WRITE_ERROR_RESPONSES,
    summary="Delete a dashboard widget",
)
@limiter.shared_limit(
    resolve_limit, scope=BUCKET_WRITE, key_func=key_write, exempt_when=is_request_rate_limit_exempt
)
async def delete_widget(
    request: Request,
    response: Response,
    auth: AccountStampedAuth,
    widget_id: str,
    project_id: DeleteProjectId,
    reason: DeleteReason,
    _live: LiveSession,
) -> DeleteWidgetResponse:
    """Hard-delete a widget and its entry in the dashboard's layout.

    Requires MEMBER role or higher in the project's workspace (the write
    service decides).

    Args:
        request (Request): Incoming request (rate-limit plumbing).
        response (Response): Outgoing response (rate-limit plumbing).
        auth (AccountStampedAuth): Account-scope user auth (session token or
            CLI access JWT); its resolved ``user_id`` becomes the actor.
        widget_id (str): The widget to delete.
        project_id (str): The project the widget's dashboard belongs to.
        reason (str): Why it is being deleted; recorded on the audit row.
        _live (None): Write-path liveness gate (blocks a revoked JWT session).

    Returns:
        DeleteWidgetResponse: The removed widget.

    Raises:
        HTTPException: The write service's 400/403/404 verbatim, or a 503
            when its response is ambiguous.
    """
    data = await _send_internal_write(
        "DELETE",
        _resource_path("widgets", widget_id),
        _envelope(auth, projectId=project_id, reason=reason),
    )
    try:
        return DeleteWidgetResponse(
            deleted=data["deleted"], reason=data["reason"], widget=_deleted(data["widget"])
        )
    except (KeyError, TypeError, ValidationError) as e:
        raise _write_service_error() from e
