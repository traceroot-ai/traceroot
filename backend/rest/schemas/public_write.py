"""Request/response schemas for the public write API (create operations).

Validation here is deliberately shape-level only (types + required-ness): the
deep field validation — exact messages, ranges, enum registries — lives in the
Next.js write services, whose own error strings pass through the proxy routes
unchanged. Duplicating those rules here would let the two surfaces drift and
mask the service's canonical messages.

Every response carries a ``created`` flag: ``True`` for a fresh row, ``False``
when an idempotent re-create returned the existing one.
"""

import json
from typing import Annotated, Any

from pydantic import AfterValidator, BaseModel


def _require_encodable_json(value: Any) -> Any:
    """Reject payloads no strict JSON encoder can serialize.

    ``json.loads`` accepts bare ``NaN``/``Infinity`` tokens, but the proxy's
    httpx client re-encodes bodies with ``allow_nan=False`` — a non-finite
    float that got past validation would raise there and surface as a 500.
    Catch it here so the caller gets a 422 naming the field instead.

    Args:
        value (Any): The parsed JSON payload (dict or list) to check.

    Returns:
        Any: ``value`` unchanged when it is strictly JSON-encodable.

    Raises:
        ValueError: When the payload contains NaN or Infinity.
    """
    try:
        json.dumps(value, allow_nan=False)
    except ValueError as e:
        raise ValueError("must not contain NaN or Infinity") from e
    return value


# JSON payload fields forwarded verbatim to the write service. Shape-level
# only, per the module docstring — but they must survive strict re-encoding.
JsonPayloadDict = Annotated[dict, AfterValidator(_require_encodable_json)]
JsonPayloadList = Annotated[list, AfterValidator(_require_encodable_json)]


class CreateWorkspaceRequest(BaseModel):
    """Body for creating a workspace the caller will administer."""

    name: str


class CreateWorkspaceResponse(BaseModel):
    """The created (or idempotently matched) workspace."""

    id: str
    name: str
    role: str
    created: bool


class CreateProjectRequest(BaseModel):
    """Body for creating a project inside a workspace."""

    workspace_id: str
    name: str
    trace_ttl_days: int | None = None


class CreateProjectResponse(BaseModel):
    """The created (or idempotently matched) project."""

    id: str
    name: str
    workspace_id: str
    created: bool


class CreateDetectorRequest(BaseModel):
    """Body for creating a detector in a project."""

    project_id: str
    name: str
    template: str
    prompt: str
    sample_rate: int | None = None
    output_schema: JsonPayloadList | None = None
    trigger_conditions: JsonPayloadList | None = None
    detection_source: str | None = None
    detection_model: str | None = None
    detection_provider: str | None = None
    enable_rca: bool | None = None
    enabled: bool | None = None


class CreateDetectorResponse(BaseModel):
    """The created (or idempotently matched) detector."""

    id: str
    name: str
    project_id: str
    enabled: bool
    sample_rate: int
    created: bool


class CreateDashboardRequest(BaseModel):
    """Body for creating a dashboard in a project."""

    project_id: str
    name: str
    description: str | None = None


class CreateDashboardResponse(BaseModel):
    """The created (or idempotently matched) dashboard."""

    id: str
    name: str
    project_id: str
    created: bool


class CreateWidgetRequest(BaseModel):
    """Body for creating a widget on a dashboard."""

    project_id: str
    dashboard_id: str
    title: str
    type: str
    spec: JsonPayloadDict
    display_config: JsonPayloadDict | None = None


class CreateWidgetResponse(BaseModel):
    """The created widget (widget creation is strict, never idempotent)."""

    id: str
    dashboard_id: str
    title: str
    type: str
    created: bool
