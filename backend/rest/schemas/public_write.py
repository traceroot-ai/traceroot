"""Request/response schemas for the public write API (create operations).

Validation here is deliberately shape-level only (types + required-ness): the
deep field validation — exact messages, ranges, enum registries — lives in the
Next.js write services, whose own error strings pass through the proxy routes
unchanged. Duplicating those rules here would let the two surfaces drift and
mask the service's canonical messages.

Every response carries a ``created`` flag: ``True`` for a fresh row, ``False``
when an idempotent re-create returned the existing one.
"""

from pydantic import BaseModel


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
    output_schema: list | None = None
    trigger_conditions: list | None = None
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
    spec: dict
    display_config: dict | None = None


class CreateWidgetResponse(BaseModel):
    """The created widget (widget creation is strict, never idempotent)."""

    id: str
    dashboard_id: str
    title: str
    type: str
    created: bool
