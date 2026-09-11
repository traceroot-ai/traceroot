"""Response schemas for the public, API-key-authenticated API."""

from datetime import datetime
from typing import Annotated, Any, Literal

from pydantic import BaseModel, Field, model_validator

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
    """Free-text root-cause analysis for a finding (Postgres ``detector_rcas``)."""

    status: str
    result: str | None


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


class DashboardSummary(BaseModel):
    """The dashboard fields shared by the list and detail reads.

    ``creator`` is the created-by user's display name (or email), resolved by
    the internal route; it is None when the creating account was deleted.
    """

    id: str
    name: str
    description: str | None
    is_default: bool
    creator: str | None
    create_time: datetime
    update_time: datetime


class DashboardListItem(DashboardSummary):
    """A dashboard in the project's catalog (Postgres ``dashboards``).

    ``id`` is the value ``create_widget`` takes as ``dashboard_id``.
    """

    widget_count: int


class DashboardWidgetItem(BaseModel):
    """A widget on a dashboard (Postgres ``widgets``)."""

    id: str
    title: str
    type: str
    spec: Any
    create_time: datetime


class DashboardDetail(DashboardSummary):
    """One dashboard with its widgets, ordered by creation time."""

    widgets: list[DashboardWidgetItem]


class PublicDashboardListResponse(BaseModel):
    """The project's dashboards for the public API.

    Not paginated: a project's dashboard catalog is small and bounded.
    """

    data: list[DashboardListItem]


class AlertSummary(BaseModel):
    """The alert fields shared by the list and detail reads (Postgres ``alerts``).

    ``threshold`` is stored as a decimal and served as a JSON number.
    ``creator`` is the created-by user's display name (or email), resolved by
    the internal route; it is None when the creating account was deleted.
    """

    id: str
    name: str
    view: str
    measure: str
    aggregation: str
    window: str
    threshold_operator: str
    threshold: float
    status: str
    severity: str
    severity_changed_at: datetime | None
    alerted_at: datetime | None
    last_evaluated_at: datetime | None
    last_error: str | None
    last_error_at: datetime | None
    last_notify_status: str | None
    last_notify_error: str | None
    last_notify_at: datetime | None
    create_time: datetime
    update_time: datetime
    creator: str | None


class AlertFilterItem(BaseModel):
    """A row predicate an alert's measure is evaluated over.

    Mirrors the alert filter vocabulary in the frontend core package: ``op``
    is one of the two alert operators, and ``key`` names the map entry on a
    keyed field (metadata).
    """

    field: str
    key: str | None = None
    op: Literal["=", "contains"]
    # allow_inf_nan=False on the float arm only: a stored non-finite value can
    # never be re-encoded by a strict JSON encoder, so it is malformed upstream.
    value: str | Annotated[float, Field(allow_inf_nan=False)]


class AlertRenotify(BaseModel):
    """How often an alert re-notifies while it stays in the alerting state.

    Kept a single-level object rather than a discriminated union: the tool
    registry generator refuses nested schema references. The cross-field
    rule is enforced by a validator instead, so a contradictory stored rule
    fails the detail read closed rather than passing through half-typed.
    """

    mode: Literal["OFF", "EVERY"]
    interval_minutes: int | None = None

    @model_validator(mode="after")
    def _interval_matches_mode(self) -> "AlertRenotify":
        """Require a positive interval for EVERY and forbid one for OFF.

        Returns:
            AlertRenotify: The validated model.

        Raises:
            ValueError: When EVERY has no positive interval or OFF carries one.
        """
        if self.mode == "EVERY":
            if self.interval_minutes is None or self.interval_minutes <= 0:
                raise ValueError("interval_minutes must be a positive integer when mode is EVERY")
        elif self.interval_minutes is not None:
            raise ValueError("interval_minutes is not allowed when mode is OFF")
        return self


class AlertDetail(AlertSummary):
    """One alert with its full rule: the summary plus filters and gap handling."""

    filters: list[AlertFilterItem]
    renotify: AlertRenotify
    no_data_mode: str


class AlertCapacity(BaseModel):
    """How many alerts the project holds against its per-project cap."""

    used: int
    max: int


class AlertListMeta(PaginationMeta):
    """Pagination plus the project's alert capacity."""

    capacity: AlertCapacity


class PublicAlertListResponse(BaseModel):
    """Paginated list of the project's alerts for the public API."""

    data: list[AlertSummary]
    meta: AlertListMeta
