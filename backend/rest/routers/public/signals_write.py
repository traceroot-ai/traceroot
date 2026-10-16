"""Project-scoped public write for a signal's status (user credentials only).

A sibling of the alert status route: the target ``project_id`` travels in the
body and the write service resolves the actor's membership and role from it,
so this runs on the account-scope credential (:data:`AccountStampedAuth` +
:func:`require_live_session`) and shares the account-write proxy helper, body
builder, error mapping and passthrough semantics. A project API key cannot
change a signal: those keys live in customer applications and can leak.

Only ``resolved`` and ``open`` are settable. A dismissed signal never reopens
on a new finding, so dismissing stays a web-app decision a person makes. The
write service's messages pass through verbatim as the public ``detail``.
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
    _WRITE_ERROR_RESPONSES,
    LiveSession,
    _envelope,
    _resource_path,
    _send_internal_write,
    _write_service_error,
)
from rest.routers.public.deps import AccountStampedAuth
from rest.schemas.eval import ErrorResponse
from rest.schemas.public_write import SignalStatusRequest, SignalStatusResponse, SignalStatusRow

router = APIRouter(prefix="/public", tags=["Signals"])


def _change_body(payload: SignalStatusRequest) -> dict[str, Any]:
    """Build the internal ``change`` object: status, plus reason and note when sent.

    Args:
        payload (SignalStatusRequest): The validated public body.

    Returns:
        dict[str, Any]: ``{"status", "reason"?, "note"?}`` as the core schema takes it.
    """
    change: dict[str, Any] = {"status": payload.status}
    if payload.reason is not None:
        change["reason"] = payload.reason
    if payload.note is not None:
        change["note"] = payload.note
    return change


@router.patch(
    "/signals/{signal_id}/status",
    operation_id="set_signal_status",
    response_model=SignalStatusResponse,
    responses={
        **_WRITE_ERROR_RESPONSES,
        409: {
            "model": ErrorResponse,
            "description": "The status changed since the caller read it, or the signal was merged",
        },
    },
    summary="Resolve or reopen a signal",
)
@limiter.shared_limit(
    resolve_limit, scope=BUCKET_WRITE, key_func=key_write, exempt_when=is_request_rate_limit_exempt
)
async def set_signal_status(
    request: Request,
    response: Response,
    auth: AccountStampedAuth,
    signal_id: str,
    payload: SignalStatusRequest,
    _live: LiveSession,
) -> SignalStatusResponse:
    """Resolve or reopen a signal. Dismissing is not possible here.

    Requires MEMBER role or higher in the project's workspace (the write
    service decides). Resolving needs a ``reason``; the reason ``other`` also
    needs a ``note``. A resolved signal opens again by itself when its
    detector finds the problem in a trace that started after the resolve. Send
    ``expected_status`` to refuse the change when someone else changed the
    status first. Setting the status the signal already has changes nothing.

    Args:
        request (Request): Incoming request (rate-limit plumbing).
        response (Response): Outgoing response (rate-limit plumbing).
        auth (AccountStampedAuth): Account-scope user auth (session token or
            CLI access JWT); its resolved ``user_id`` becomes the actor.
        signal_id (str): The signal to change.
        payload (SignalStatusRequest): The project, the target status, and
            the reason, note and expected status.
        _live (None): Write-path liveness gate (blocks a revoked JWT session).

    Returns:
        SignalStatusResponse: The signal with its new status.

    Raises:
        HTTPException: The write service's 400/403/404/409 verbatim, or a
            503 when its response is ambiguous.
    """
    body = _envelope(auth, projectId=payload.project_id, change=_change_body(payload))
    if payload.expected_status is not None:
        body["expectedStatus"] = payload.expected_status
    data = await _send_internal_write(
        "PATCH", _resource_path("signals", signal_id, "/status"), body
    )
    try:
        signal = data["signal"]
        return SignalStatusResponse(
            updated=data["updated"],
            changed=data["changed"],
            signal=SignalStatusRow(
                signal_id=signal["id"],
                project_id=signal["projectId"],
                detector_id=signal["detectorId"],
                title=signal["title"],
                status=signal["status"],
                resolved_at=signal["resolvedAt"],
                reopen_count=signal["reopenCount"],
            ),
        )
    except (KeyError, TypeError, ValidationError) as e:
        raise _write_service_error() from e
