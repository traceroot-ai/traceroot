"""Response schemas for the public, API-key-authenticated API."""

from pydantic import BaseModel

from rest.schemas.common import PaginationMeta
from rest.schemas.traces import TraceDetailResponse, TraceListItem


class WhoamiResponse(BaseModel):
    """Identity a project API key resolves to, for `login` / `status`.

    Name fields are nullable: they depend on what the internal key-validation
    contract returns, and the backend never fabricates them. The full API token
    is never included — only ``key_hint``.
    """

    project_id: str
    project_name: str | None
    workspace_id: str
    workspace_name: str | None
    key_name: str | None
    key_hint: str | None
    host: str
    ui_base_url: str


class PublicTraceListItem(TraceListItem):
    """A trace list item plus a backend-built link to its UI detail view."""

    trace_url: str


class PublicTraceListResponse(BaseModel):
    """Paginated list of traces for the public API."""

    data: list[PublicTraceListItem]
    meta: PaginationMeta


class PublicTraceDetailResponse(TraceDetailResponse):
    """Full trace payload plus a backend-built link to its UI detail view."""

    trace_url: str
