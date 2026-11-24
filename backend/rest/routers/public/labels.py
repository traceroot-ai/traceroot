"""Write-only label ingestion for existing project labels."""

from typing import Annotated

from fastapi import APIRouter, HTTPException, Request, Response, status
from pydantic import BaseModel, ConfigDict, StringConstraints, ValidationError

from rest.rate_limit import (
    BUCKET_INGEST,
    is_request_rate_limit_exempt,
    key_ingest,
    limiter,
    resolve_limit,
)
from rest.routers.labels_common import MAX_LABEL_LENGTH, require_label_target
from rest.routers.public.account_write import _send_internal_write, _write_service_error
from rest.routers.public.deps import KeyStampedAuth
from rest.schemas.eval import ErrorResponse

router = APIRouter(prefix="/public", tags=["Labels"])

TargetId = Annotated[str, StringConstraints(min_length=1, max_length=128)]


class WriteLabelRequest(BaseModel):
    """Apply an existing project label to a user trace or span."""

    model_config = ConfigDict(extra="forbid")

    trace_id: TargetId
    span_id: TargetId | None = None
    value: Annotated[
        str, StringConstraints(strip_whitespace=True, min_length=1, max_length=MAX_LABEL_LENGTH)
    ]
    idempotency_key: Annotated[
        str, StringConstraints(strip_whitespace=True, min_length=1, max_length=128)
    ]


class WriteLabelResponse(BaseModel):
    """The saved assignment ID, also returned on retries."""

    id: Annotated[str, StringConstraints(min_length=1)]


@router.post(
    "/labels",
    operation_id="write_label",
    response_model=WriteLabelResponse,
    responses={
        400: {"model": ErrorResponse, "description": "Invalid label request"},
        403: {"model": ErrorResponse, "description": "Label target outside retention"},
        404: {"model": ErrorResponse, "description": "Project label or eligible target not found"},
        409: {"model": ErrorResponse, "description": "Idempotency key used for a different label"},
    },
    summary="Apply a production label",
)
@limiter.shared_limit(
    resolve_limit,
    scope=BUCKET_INGEST,
    key_func=key_ingest,
    exempt_when=is_request_rate_limit_exempt,
)
async def write_label(
    request: Request, response: Response, auth: KeyStampedAuth, payload: WriteLabelRequest
) -> WriteLabelResponse:
    """Apply a project label to a production trace or one of its spans.

    Use a project API key and the same idempotency key on retry. Retrying the
    same trace, span and value returns the original assignment ID.
    """
    try:
        await require_label_target(
            auth.project_id, payload.trace_id, payload.span_id, auth.billing_plan
        )
    except HTTPException as e:
        if e.status_code == status.HTTP_403_FORBIDDEN:
            raise HTTPException(
                status_code=e.status_code, detail="Label target outside retention"
            ) from e
        raise

    assignment = {
        "projectId": auth.project_id,
        "traceId": payload.trace_id,
        "value": payload.value,
        "idempotencyKey": payload.idempotency_key,
    }
    if payload.span_id is not None:
        assignment["spanId"] = payload.span_id
    data = await _send_internal_write("POST", "/api/internal/labels", assignment)
    try:
        return WriteLabelResponse.model_validate(data)
    except ValidationError as e:
        raise _write_service_error() from e
