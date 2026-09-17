"""Project-scoped public writes for threshold alerts (user credentials only).

Siblings of the detector/dashboard/widget writes: the target ``project_id``
travels in the request body (or the query, on the delete) and the write
service resolves the actor's membership/role from it, so these run on the
same account-scope credential (:data:`AccountStampedAuth` +
:func:`require_live_session`) and share the account-write module's proxy
helper, body builders, error mapping, and passthrough semantics.

The write service is the single validator for the UI and the API (measure per
view, filter evaluability, the per-project cap, the merged-rule check on an
edit); its messages pass through verbatim as the public ``detail``, including
the cap's own 409 string and the parked-alert refusal on a pause.
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
from rest.routers.alert_read_common import alert_detail_from_internal
from rest.routers.public.account_write import (
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
    AlertRenotifyRequest,
    AlertStatusRequest,
    CreateAlertRequest,
    CreateAlertResponse,
    DeleteAlertResponse,
    UpdateAlertRequest,
    UpdateAlertResponse,
)

router = APIRouter(prefix="/public", tags=["Alerts (Public)"])


def _renotify_body(renotify: AlertRenotifyRequest) -> dict[str, Any]:
    """Map the renotify settings to the write service's camelCase shape.

    An unset interval stays out of the object entirely: the write service's
    strict OFF shape refuses a null one.

    Args:
        renotify (AlertRenotifyRequest): The validated renotify settings.

    Returns:
        dict[str, Any]: ``{"mode", "intervalMinutes"?}``.
    """
    body: dict[str, Any] = {"mode": renotify.mode}
    if renotify.interval_minutes is not None:
        body["intervalMinutes"] = renotify.interval_minutes
    return body


def _alert_update_response(data: dict[str, Any]) -> UpdateAlertResponse:
    """Translate an internal alert update envelope to the public response.

    Shared by the rule edit and the status route, which answer with the same
    shape: the full detail plus the state flags an edit or a resume sets.

    Args:
        data (dict[str, Any]): The internal route's 200 body.

    Returns:
        UpdateAlertResponse: The public response.

    Raises:
        HTTPException: The shared 503 when the envelope is missing, wrongly
            typed, or malformed.
    """
    try:
        return UpdateAlertResponse(
            updated=data["updated"],
            changed=data["changed"],
            alert=alert_detail_from_internal(data["alert"]),
            state_reset=data.get("stateReset", False),
            page_cleared=data.get("pageCleared", False),
        )
    except (KeyError, TypeError, ValidationError, AttributeError) as e:
        raise _write_service_error() from e


@router.post(
    "/alerts",
    operation_id="create_alert",
    response_model=CreateAlertResponse,
    responses={
        **_WRITE_ERROR_RESPONSES,
        409: {
            "model": ErrorResponse,
            "description": "The project has reached its alert limit",
        },
    },
    summary="Create an alert",
)
@limiter.shared_limit(
    resolve_limit, scope=BUCKET_WRITE, key_func=key_write, exempt_when=is_request_rate_limit_exempt
)
async def create_alert(
    request: Request,
    response: Response,
    auth: AccountStampedAuth,
    payload: CreateAlertRequest,
    _live: LiveSession,
) -> CreateAlertResponse:
    """Create a threshold alert in a project the authenticated user can write to.

    Requires MEMBER role or higher in the project's workspace (the write
    service decides). Strict create — alerts have no unique name, so every
    call inserts and ``created`` is always ``true`` on success.

    Args:
        request (Request): Incoming request (rate-limit plumbing).
        response (Response): Outgoing response (rate-limit plumbing).
        auth (AccountStampedAuth): Account-scope user auth (session token or
            CLI access JWT); its resolved ``user_id`` becomes the actor.
        payload (CreateAlertRequest): The alert rule to create.
        _live (None): Write-path liveness gate (blocks a revoked JWT session).

    Returns:
        CreateAlertResponse: The created alert with its full rule.
    """
    body = _envelope(
        auth,
        projectId=payload.project_id,
        name=payload.name,
        view=payload.view,
        measure=payload.measure,
        aggregation=payload.aggregation,
        # exclude_none: an unkeyed filter must travel without ``key`` — the
        # write service's strict shape takes an absent key, never a null one.
        filters=[f.model_dump(exclude_none=True) for f in payload.filters],
        window=payload.window,
        thresholdOperator=payload.threshold_operator,
        threshold=payload.threshold,
        renotify=_renotify_body(payload.renotify),
    )
    # An unset no-data mode stays out of the body entirely: the write service
    # reads absent as "take the column default", which is what a caller that
    # said nothing about gaps expects.
    if payload.no_data_mode is not None:
        body["noDataMode"] = payload.no_data_mode
    data = await _send_internal_write("POST", "/api/internal/write/alerts", body)
    try:
        return CreateAlertResponse(
            created=data["created"], alert=alert_detail_from_internal(data["alert"])
        )
    except (KeyError, TypeError, ValidationError, AttributeError) as e:
        raise _write_service_error() from e


@router.patch(
    "/alerts/{alert_id}",
    operation_id="update_alert",
    response_model=UpdateAlertResponse,
    responses=_WRITE_ERROR_RESPONSES,
    summary="Edit an alert rule",
)
@limiter.shared_limit(
    resolve_limit, scope=BUCKET_WRITE, key_func=key_write, exempt_when=is_request_rate_limit_exempt
)
async def update_alert(
    request: Request,
    response: Response,
    auth: AccountStampedAuth,
    alert_id: str,
    payload: UpdateAlertRequest,
    _live: LiveSession,
) -> UpdateAlertResponse:
    """Edit an alert's rule in a project the authenticated user can write to.

    Requires MEMBER role or higher in the project's workspace (the write
    service decides). The patch is validated merged with the stored rule; an
    edit to any evaluated field resets the evaluation state, clears an open
    page, and re-arms a parked alert — the response reports the first two.

    Args:
        request (Request): Incoming request (rate-limit plumbing).
        response (Response): Outgoing response (rate-limit plumbing).
        auth (AccountStampedAuth): Account-scope user auth (session token or
            CLI access JWT); its resolved ``user_id`` becomes the actor.
        alert_id (str): The alert to edit.
        payload (UpdateAlertRequest): The project and the rule fields to change.
        _live (None): Write-path liveness gate (blocks a revoked JWT session).

    Returns:
        UpdateAlertResponse: The updated alert, the changed fields, and the
            state flags.

    Raises:
        HTTPException: The write service's 400/403/404 verbatim, or a 503
            when its response is ambiguous.
    """
    body = _patch_body(auth, payload)
    # The nested rule pieces keep the create's wire shape: filters without a
    # null key, renotify with its camelCase interval.
    if "filters" in body:
        body["filters"] = [f.model_dump(exclude_none=True) for f in payload.filters]
    if "renotify" in body:
        body["renotify"] = _renotify_body(payload.renotify)
    data = await _send_internal_write("PATCH", _resource_path("alerts", alert_id), body)
    return _alert_update_response(data)


@router.patch(
    "/alerts/{alert_id}/status",
    operation_id="set_alert_status",
    response_model=UpdateAlertResponse,
    responses={
        **_WRITE_ERROR_RESPONSES,
        409: {
            "model": ErrorResponse,
            "description": "A parked alert cannot be paused; resume it to run it again",
        },
    },
    summary="Pause or resume an alert",
)
@limiter.shared_limit(
    resolve_limit, scope=BUCKET_WRITE, key_func=key_write, exempt_when=is_request_rate_limit_exempt
)
async def set_alert_status(
    request: Request,
    response: Response,
    auth: AccountStampedAuth,
    alert_id: str,
    payload: AlertStatusRequest,
    _live: LiveSession,
) -> UpdateAlertResponse:
    """Pause or resume an alert without touching its rule.

    Requires MEMBER role or higher in the project's workspace (the write
    service decides). Pausing keeps the severity it stopped at; resuming is a
    cold start (state reset, due now). Setting the status the alert already
    has is a 200 with nothing changed.

    Args:
        request (Request): Incoming request (rate-limit plumbing).
        response (Response): Outgoing response (rate-limit plumbing).
        auth (AccountStampedAuth): Account-scope user auth (session token or
            CLI access JWT); its resolved ``user_id`` becomes the actor.
        alert_id (str): The alert to pause or resume.
        payload (AlertStatusRequest): The project and the target status.
        _live (None): Write-path liveness gate (blocks a revoked JWT session).

    Returns:
        UpdateAlertResponse: The alert with its new status and the state flags.

    Raises:
        HTTPException: The write service's 400/403/404/409 verbatim, or a
            503 when its response is ambiguous.
    """
    data = await _send_internal_write(
        "PATCH", _resource_path("alerts", alert_id, "/status"), _patch_body(auth, payload)
    )
    return _alert_update_response(data)


@router.delete(
    "/alerts/{alert_id}",
    operation_id="delete_alert",
    response_model=DeleteAlertResponse,
    responses=_WRITE_ERROR_RESPONSES,
    summary="Delete an alert",
)
@limiter.shared_limit(
    resolve_limit, scope=BUCKET_WRITE, key_func=key_write, exempt_when=is_request_rate_limit_exempt
)
async def delete_alert(
    request: Request,
    response: Response,
    auth: AccountStampedAuth,
    alert_id: str,
    project_id: DeleteProjectId,
    reason: DeleteReason,
    _live: LiveSession,
) -> DeleteAlertResponse:
    """Hard-delete an alert.

    Requires MEMBER role or higher in the project's workspace (the write
    service decides). An outstanding page is discarded, not resolved: the
    response reports ``page_cleared`` when one was open.

    Args:
        request (Request): Incoming request (rate-limit plumbing).
        response (Response): Outgoing response (rate-limit plumbing).
        auth (AccountStampedAuth): Account-scope user auth (session token or
            CLI access JWT); its resolved ``user_id`` becomes the actor.
        alert_id (str): The alert to delete.
        project_id (str): The project the alert belongs to.
        reason (str): Why it is being deleted; recorded on the audit row.
        _live (None): Write-path liveness gate (blocks a revoked JWT session).

    Returns:
        DeleteAlertResponse: The removed alert and whether a page was cleared.

    Raises:
        HTTPException: The write service's 400/403/404 verbatim, or a 503
            when its response is ambiguous.
    """
    data = await _send_internal_write(
        "DELETE",
        _resource_path("alerts", alert_id),
        _envelope(auth, projectId=project_id, reason=reason),
    )
    try:
        return DeleteAlertResponse(
            deleted=data["deleted"],
            reason=data["reason"],
            page_cleared=data.get("pageCleared", False),
            alert=_deleted(data["alert"]),
        )
    except (KeyError, TypeError, ValidationError) as e:
        raise _write_service_error() from e
