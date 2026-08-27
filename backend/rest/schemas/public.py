"""Response schemas for the public, API-key-authenticated API."""

from datetime import datetime
from typing import Any, Literal

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


class DetectorResultItem(BaseModel):
    """One detector's result within a finding, normalized from the stored payload.

    The stored finding ``payload`` uses camelCase keys (``detectorId`` /
    ``detectorName``); the public API exposes snake_case. Only triggered detectors
    are persisted, so ``identified`` is always ``True`` for a present item. ``data``
    is the detector's opaque output, passed through verbatim. ``template`` is looked
    up from the Postgres ``detectors`` row and is ``None`` when that row is absent
    (e.g. a deleted detector).
    """

    detector_id: str
    detector_name: str
    template: str | None
    summary: str
    identified: bool
    data: Any | None


class RCAResult(BaseModel):
    """Free-text root-cause analysis for a finding (Postgres ``detector_rcas``).

    ``trace_id``/``trace_status``/``attempt`` describe the latest
    ``detector_rca_executions`` row for this RCA and are ``None`` on legacy rows
    created before executions existed.
    """

    status: str
    result: str | None
    trace_id: str | None = None
    trace_status: Literal["disabled", "pending", "available", "failed"] | None = None
    attempt: int | None = None


class FindingSummary(BaseModel):
    """A detector finding row for the list view; ``detectors`` are display labels."""

    finding_id: str
    project_id: str
    trace_id: str
    summary: str
    timestamp: datetime
    detectors: list[str]
    # The producing detector runs. A finding is per-trace but a run is
    # per-(trace, detector), so a finding that fired N detectors has N runs —
    # this lists all of them (parallel to ``detectors``, but as a set: not
    # index-aligned). Empty when no run row references the finding (e.g.
    # legacy/manually-created findings that predate run recording).
    run_ids: list[str] = []


class FindingDetail(FindingSummary):
    """A finding plus its per-detector results and optional free-text RCA."""

    results: list[DetectorResultItem]
    rca: RCAResult | None


class PublicFindingListResponse(BaseModel):
    """Paginated list of detector findings for the public API."""

    data: list[FindingSummary]
    meta: PaginationMeta


class DetectorItem(BaseModel):
    """A detector from the project's catalog (Postgres ``detectors``).

    ``detector_id`` is the value to pass to ``findings list --detector`` to filter
    findings to this detector.
    """

    detector_id: str
    name: str
    template: str
    enabled: bool
    created_at: datetime


class DetectorDetail(DetectorItem):
    """A detector's full configuration (Postgres ``detectors`` + optional trigger).

    ``trigger_conditions`` comes from ``detector_triggers.conditions`` and is
    None when the detector has no trigger row (it then runs on every sampled
    trace).
    """

    prompt: str
    output_schema: Any | None
    sample_rate: int
    enable_rca: bool
    detection_model: str | None
    detection_provider: str | None
    detection_source: str | None
    updated_at: datetime
    trigger_conditions: Any | None


class PublicDetectorListResponse(BaseModel):
    """Paginated list of the project's detectors for the public API."""

    data: list[DetectorItem]
    meta: PaginationMeta


class WorkspaceListItem(BaseModel):
    """A workspace the authenticated user belongs to, with their role in it."""

    id: str
    name: str
    role: str


class PublicWorkspaceListResponse(BaseModel):
    """Account-scope discovery: the workspaces the user can access.

    Returned by ``list_workspaces`` — a user-credential-only op that needs no
    ``project_id``. Not paginated: a user's workspace membership is small and
    bounded.
    """

    data: list[WorkspaceListItem]


class ProjectListItem(BaseModel):
    """A project the user can access, tagged with its owning workspace."""

    id: str
    name: str
    workspace_id: str
    workspace_name: str


class PublicProjectListResponse(BaseModel):
    """Account-scope discovery: the projects the user can access.

    Returned by ``list_projects`` — a user-credential-only op. Projects are
    flattened across the user's workspaces; an optional ``workspace_id`` query
    narrows the result to one workspace.
    """

    data: list[ProjectListItem]
