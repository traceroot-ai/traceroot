"""Project-scoped public write for threshold alerts (user credentials only).

A sibling of the detector/dashboard/widget creates: the target ``project_id``
travels in the request body and the write service resolves the actor's
membership/role from it, so this runs on the same account-scope credential
(:data:`AccountStampedAuth` + :func:`require_live_session`) and shares the
account-write module's proxy helper, error mapping, and passthrough semantics.

The write service is the single validator for the UI and the API (measure per
view, filter evaluability, the per-project cap); its messages pass through
verbatim as the public ``detail``, including the cap's own 409 string.
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
    LiveSession,
    _post_internal_write,
    _write_service_error,
)
from rest.routers.public.deps import AccountStampedAuth
from rest.schemas.eval import ErrorResponse
from rest.schemas.public_write import CreateAlertRequest, CreateAlertResponse

router = APIRouter(prefix="/public", tags=["Alerts (Public)"])


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
    renotify: dict[str, Any] = {"mode": payload.renotify.mode}
    if payload.renotify.interval_minutes is not None:
        renotify["intervalMinutes"] = payload.renotify.interval_minutes
    body: dict[str, Any] = {
        "actorUserId": auth.user_id,
        "projectId": payload.project_id,
        "name": payload.name,
        "view": payload.view,
        "measure": payload.measure,
        "aggregation": payload.aggregation,
        # exclude_none: an unkeyed filter must travel without ``key`` — the
        # write service's strict shape takes an absent key, never a null one.
        "filters": [f.model_dump(exclude_none=True) for f in payload.filters],
        "window": payload.window,
        "thresholdOperator": payload.threshold_operator,
        "threshold": payload.threshold,
        "renotify": renotify,
        "transport": "public-api",
    }
    # An unset no-data mode stays out of the body entirely: the write service
    # reads absent as "take the column default", which is what a caller that
    # said nothing about gaps expects.
    if payload.no_data_mode is not None:
        body["noDataMode"] = payload.no_data_mode
    data = await _post_internal_write("/api/internal/write/alerts", body)
    try:
        return CreateAlertResponse(
            created=data["created"], alert=alert_detail_from_internal(data["alert"])
        )
    except (KeyError, TypeError, ValidationError, AttributeError) as e:
        raise _write_service_error() from e
