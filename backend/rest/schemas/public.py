"""Response schemas for the public, API-key-authenticated API."""

from pydantic import BaseModel

from rest.schemas.common import PaginationMeta
from rest.schemas.traces import SpanResponse, TraceDetailResponse, TraceListItem


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


class GitSource(BaseModel):
    """A single span's source location (trace-resident git metadata)."""

    span_id: str
    file: str | None
    line: int | None
    function: str | None


class GitContext(BaseModel):
    """git_context.json: repo/ref + per-span source locations."""

    git_repo: str | None
    git_ref: str | None
    sources: list[GitSource]


class ExportManifest(BaseModel):
    """manifest.json: index of the bundle's parts."""

    trace_id: str
    project_id: str
    bundle_version: str
    files: list[str]


class PublicTraceExportResponse(BaseModel):
    """V1 export bundle: trace (== `traces get`) + spans + git_context + manifest."""

    manifest: ExportManifest
    trace: PublicTraceDetailResponse
    # Same span shape as `trace.spans` (the documented export.spans == detail.spans
    # invariant). Export defaults to the `full` projection, so these carry per-span
    # input/output/metadata; a narrowed `fields=skeleton` projection leaves them
    # null. See rest.projection and the export endpoint's default `fields`.
    spans: list[SpanResponse]
    git_context: GitContext
