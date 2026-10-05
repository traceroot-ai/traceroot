"""Request/response schemas for the public write API (create, update, delete).

Validation here is deliberately shape-level only (types + required-ness): the
deep field validation — exact messages, ranges, enum registries — lives in the
Next.js write services, whose own error strings pass through the proxy routes
unchanged. Duplicating those rules here would let the two surfaces drift and
mask the service's canonical messages.

The one exception is the widget ``spec``: it is a structured contract in its
own right (two dialects keyed by the widget ``type``), typed here so the
OpenAPI document — and every tool schema generated from it — shows the real
shape instead of a bare object.

Every create response carries a ``created`` flag: ``True`` for a fresh row,
``False`` when an idempotent re-create returned the existing one.

Updates are PATCH (partial) semantics: every field of an ``Update*Request`` is
optional, an absent field leaves the stored value untouched, and an explicit
``null`` clears the field where it is nullable (typed ``T | None``) and is a
422 where it is not. The :data:`MISSING` sentinel is the default that keeps
the two cases apart — it is excluded from the JSON schema and from
``model_dump(exclude_unset=True)``, so a handler forwards exactly what the
caller sent. Unknown keys are refused (``extra="forbid"``) so an immutable
field such as a detector's template or a widget's type is a 422, never a
silent drop. Full replacement (PUT: send the whole resource and the server
stores exactly that) is a deliberate future extension that slots in beside
these models as ``Replace*Request`` bodies validated like the creates.
"""

import json
from typing import Annotated, Any, Literal

from pydantic import AfterValidator, BaseModel, ConfigDict, Field, WithJsonSchema, model_validator
from pydantic.experimental.missing_sentinel import MISSING
from pydantic.json_schema import SkipJsonSchema

from rest.schemas.dashboards import WidgetSpec
from rest.schemas.public import AlertDetail, AlertFilterItem
from rest.services.filters.translate import MAX_FILTERS, MAX_KEY_LENGTH, MAX_VALUE_LENGTH

# Per-field byte ceiling for JSON payloads persisted verbatim into Postgres
# JSONB (measured on the serialized form). The write rate bucket only limits
# request COUNT, so without a size bound one caller could write unbounded
# JSONB volume within their request budget. 32 KiB is orders of magnitude
# above any legitimate widget spec, display config, or detector schema.
MAX_JSON_PAYLOAD_BYTES = 32 * 1024


def _require_encodable_json(value: Any) -> Any:
    """Reject payloads no strict JSON encoder can serialize, and bound size.

    ``json.loads`` accepts bare ``NaN``/``Infinity`` tokens, but the proxy's
    httpx client re-encodes bodies with ``allow_nan=False`` — a non-finite
    float that got past validation would raise there and surface as a 500.
    Catch it here so the caller gets a 422 naming the field instead. The
    same serialization pass measures the payload against
    :data:`MAX_JSON_PAYLOAD_BYTES`.

    Args:
        value (Any): The parsed JSON payload (dict or list) to check.

    Returns:
        Any: ``value`` unchanged when it is strictly JSON-encodable and
            within the size bound.

    Raises:
        ValueError: When the payload contains NaN or Infinity, or serializes
            past the per-field byte cap.
    """
    try:
        encoded = json.dumps(value, allow_nan=False)
    except ValueError as e:
        raise ValueError("must not contain NaN or Infinity") from e
    if len(encoded.encode("utf-8")) > MAX_JSON_PAYLOAD_BYTES:
        raise ValueError(f"must serialize to at most {MAX_JSON_PAYLOAD_BYTES} bytes of JSON")
    return value


# JSON payload fields forwarded verbatim to the write service. Shape-level
# only, per the module docstring — but they must survive strict re-encoding.
JsonPayloadDict = Annotated[dict, AfterValidator(_require_encodable_json)]
JsonPayloadList = Annotated[list, AfterValidator(_require_encodable_json)]


def _require_bounded_spec(spec: BaseModel) -> BaseModel:
    """Hold a deep-validated spec to the same per-field byte cap as the loose JSON fields.

    Typing the spec bounds its shape, not its size: a filter value is an
    unbounded string, and the spec is persisted verbatim as JSONB.

    Args:
        spec (BaseModel): The validated spec model.

    Returns:
        BaseModel: ``spec`` unchanged when its JSON form is within the cap.

    Raises:
        ValueError: When the spec serializes past the per-field byte cap.
    """
    _require_encodable_json(spec.model_dump(mode="json", exclude_none=True))
    return spec


class CreateWorkspaceRequest(BaseModel):
    """Body for creating a workspace the caller will administer."""

    name: str


class WorkspaceRow(BaseModel):
    """A workspace as the write service returns it: id, name, the caller's role."""

    id: str
    name: str
    role: str


class CreateWorkspaceResponse(WorkspaceRow):
    """The created (or idempotently matched) workspace."""

    created: bool


class CreateProjectRequest(BaseModel):
    """Body for creating a project inside a workspace."""

    workspace_id: str
    name: str
    trace_ttl_days: int | None = None


class ProjectRow(BaseModel):
    """A project as the write service returns it."""

    id: str
    name: str
    workspace_id: str


class CreateProjectResponse(ProjectRow):
    """The created (or idempotently matched) project."""

    created: bool


class CreateDetectorRequest(BaseModel):
    """Body for creating a detector in a project."""

    project_id: str
    name: str
    template: str
    prompt: str | None = Field(
        default=None,
        description=(
            "Detector instructions. Omit to adopt the canonical instructions "
            "of a standard template; required for any other template."
        ),
    )
    sample_rate: int | None = None
    output_schema: JsonPayloadList | None = None
    trigger_conditions: JsonPayloadList | None = Field(
        default=None,
        description=(
            "Conditions gating WHICH completed traces the detector evaluates; "
            "omit or pass [] to evaluate every completed trace. Each condition "
            "is {field, op, value} (metadata also takes key): "
            "model_name/environment take =, !=; "
            "cost/total_tokens/duration_ms/errors take >, >=, <, <=, =; "
            "metadata takes =, contains. A condition is a deterministic "
            "pre-filter, not the flag decision - the prompt still judges every "
            "trace that passes."
        ),
    )
    detection_source: str | None = None
    detection_model: str | None = None
    detection_provider: str | None = None
    enable_rca: bool | None = None
    enabled: bool | None = None


class DetectorRow(BaseModel):
    """A detector as the write service returns it."""

    id: str
    name: str
    project_id: str
    enabled: bool
    sample_rate: int


class CreateDetectorResponse(DetectorRow):
    """The created (or idempotently matched) detector."""

    created: bool


class CreateDashboardRequest(BaseModel):
    """Body for creating a dashboard in a project."""

    project_id: str
    name: str
    description: str | None = None


class DashboardRow(BaseModel):
    """A dashboard as the write service returns it."""

    id: str
    name: str
    project_id: str


class CreateDashboardResponse(DashboardRow):
    """The created (or idempotently matched) dashboard."""

    created: bool


# ── widget spec dialects ────────────────────────────────────────────────
#
# A widget's ``spec`` is one of two dialects, keyed by the sibling ``type``
# field. ``type: "query"`` uses the chart spec the widget query engine runs
# (:class:`rest.schemas.dashboards.WidgetSpec`, mirroring the canonical zod
# ``WidgetSpecSchema`` in frontend/ui/src/features/dashboards/types.ts —
# guarded by the widget-spec-parity frontend test). ``type: "trace_feed"``
# uses the trace-list predicate wire format below.


class _TraceFeedPredicateBase(BaseModel):
    """Common shape of one trace-feed filter predicate.

    Mirrors the trace-list predicate wire format the dashboard trace-feed
    renderer accepts (``isValidPredicate`` in
    frontend/ui/src/features/filters/predicate.ts). ``field`` names a trace
    filter column; whether ``key`` is required (keyed fields such as metadata)
    or must be absent is registry-dependent and enforced by the write service
    and the trace-list query, not here.
    """

    model_config = ConfigDict(extra="forbid")

    field: str
    key: Annotated[str, Field(min_length=1, max_length=MAX_KEY_LENGTH)] | SkipJsonSchema[None] = (
        None
    )


class TraceFeedInPredicate(_TraceFeedPredicateBase):
    """Membership predicate: the field's value is one of the listed strings."""

    op: Literal["in"]
    value: list[Annotated[str, Field(max_length=MAX_VALUE_LENGTH)]] = Field(min_length=1)


class TraceFeedNumericPredicate(_TraceFeedPredicateBase):
    """Numeric comparison predicate (equality or ordering) on a finite number."""

    op: Literal["eq", "gt", "gte", "lt", "lte"]
    value: float = Field(allow_inf_nan=False)


class TraceFeedTextPredicate(_TraceFeedPredicateBase):
    """Text predicate: exact match or substring containment."""

    op: Literal["eq", "contains"]
    value: str = Field(min_length=1, max_length=MAX_VALUE_LENGTH)


TraceFeedPredicate = TraceFeedInPredicate | TraceFeedNumericPredicate | TraceFeedTextPredicate


class TraceFeedSpec(BaseModel):
    """Spec for a ``trace_feed`` widget: a filtered live list of recent traces.

    Mirrors the trace-list predicate wire format (canonical shape: what
    ``isValidPredicate`` in frontend/ui/src/features/filters/predicate.ts
    accepts and the dashboard seed produces). ``limit`` carries the trace-list
    page-size bound; it defaults to 10 rows in the renderer when omitted.
    """

    model_config = ConfigDict(extra="forbid")

    filters: list[TraceFeedPredicate] = Field(default_factory=list, max_length=MAX_FILTERS)
    limit: Annotated[int, Field(ge=1, le=200)] | SkipJsonSchema[None] = None


class CreateWidgetRequest(BaseModel):
    """Body for creating a widget on a dashboard.

    Unlike the other create bodies, ``spec`` is deep-validated here: it is a
    structured contract the agent/CLI must compose (a wrong shape only
    surfaces at render time otherwise), and the union below is what generated
    tool schemas show the model.
    """

    project_id: str
    dashboard_id: str
    title: str
    type: str
    spec: Annotated[WidgetSpec | TraceFeedSpec, AfterValidator(_require_bounded_spec)] = Field(
        description=(
            'The widget\'s content. For type "query": a chart spec '
            '(view/filters/metric/breakdown/display). For type "trace_feed": '
            "a trace-list feed spec (predicate filters + row limit)."
        )
    )
    display_config: JsonPayloadDict | None = None

    @model_validator(mode="after")
    def _spec_matches_type(self) -> "CreateWidgetRequest":
        """Reject a spec parsed into the dialect the ``type`` field doesn't name.

        Returns:
            CreateWidgetRequest: The validated request.

        Raises:
            ValueError: If ``type`` is ``query``/``trace_feed`` but ``spec``
                parsed as the other dialect. Unknown types pass through so the
                write service's canonical type message stays authoritative.
        """
        expected = {"query": WidgetSpec, "trace_feed": TraceFeedSpec}.get(self.type)
        if expected is not None and not isinstance(self.spec, expected):
            raise ValueError(
                f"spec does not match widget type {self.type!r}: "
                f"expected the {expected.__name__} dialect"
            )
        return self


class WidgetRow(BaseModel):
    """A widget as the write service returns it."""

    id: str
    dashboard_id: str
    title: str
    type: str


class CreateWidgetResponse(WidgetRow):
    """The created widget (widget creation is strict, never idempotent)."""

    created: bool


# Alert vocabulary mirrored from the frontend core package (ALERT_VIEWS,
# ALERT_AGGREGATIONS, ALERT_WINDOWS, ALERT_THRESHOLD_OPERATORS,
# ALERT_NO_DATA_MODES, AlertRenotify). Only these stable enums are pinned
# here so the generated tool schema can offer them; measure-per-view and
# filter evaluability stay with the write service, the single validator for
# the UI and the API.
AlertView = Literal["SPANS"]
AlertAggregation = Literal[
    "sum", "avg", "count", "max", "min", "p50", "p75", "p90", "p95", "p99", "uniq"
]
AlertWindow = Literal["1m", "5m", "10m", "30m", "1h", "2h"]
AlertThresholdOperator = Literal[">", ">=", "<", "<=", "=", "!="]
AlertNoDataMode = Literal["HOLD", "ZERO", "NOTIFY"]


class AlertRenotifyRequest(BaseModel):
    """How often an alert re-notifies while it stays in the alerting state."""

    mode: Literal["OFF", "EVERY"]
    # The None arm is skipped in the JSON schema: nested schemas are emitted
    # as-is into the tool registry, and a typeless anyOf there breaks the
    # model tool definitions. Optionality still shows through ``required``.
    interval_minutes: int | SkipJsonSchema[None] = Field(
        None, description="Minutes between repeat notifications; required when mode is EVERY"
    )

    @model_validator(mode="after")
    def _interval_matches_mode(self) -> "AlertRenotifyRequest":
        """Require a positive interval for EVERY and forbid one for OFF.

        The write service's strict shape refuses the same contradictions; the
        check runs here too so the caller gets a 422 naming the field before
        the proxy call.

        Returns:
            AlertRenotifyRequest: The validated model.

        Raises:
            ValueError: When EVERY has no positive interval or OFF carries one.
        """
        if self.mode == "EVERY":
            if self.interval_minutes is None or self.interval_minutes <= 0:
                raise ValueError("interval_minutes must be a positive integer when mode is EVERY")
        elif self.interval_minutes is not None:
            raise ValueError("interval_minutes is not allowed when mode is OFF")
        return self


def _require_bounded_filters(filters: list[AlertFilterItem]) -> list[AlertFilterItem]:
    """Bound the serialized size of a filter list like any other JSON payload.

    Args:
        filters (list[AlertFilterItem]): The parsed filter items.

    Returns:
        list[AlertFilterItem]: ``filters`` unchanged when within the byte cap.

    Raises:
        ValueError: When the items serialize past :data:`MAX_JSON_PAYLOAD_BYTES`.
    """
    _require_encodable_json([f.model_dump(exclude_none=True) for f in filters])
    return filters


# The item schema is written out rather than referenced: the tool registry
# generator resolves a request-body $ref one level deep only, and an array
# whose items point at a component would fail its build. Every property
# declares a type (a list for the two-armed value) because some model
# providers reject tool parameters that carry only an anyOf.
_ALERT_FILTER_ITEM_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "field": {"type": "string", "description": "A span field, e.g. model_name or metadata"},
        "key": {
            "type": "string",
            "description": "The map entry to compare; required for the metadata field",
        },
        "op": {"type": "string", "enum": ["=", "contains"]},
        "value": {"type": ["string", "number"]},
    },
    "required": ["field", "op", "value"],
    "additionalProperties": False,
}

AlertFilters = Annotated[
    list[AlertFilterItem],
    AfterValidator(_require_bounded_filters),
    WithJsonSchema(
        {
            "type": "array",
            "items": _ALERT_FILTER_ITEM_SCHEMA,
            "description": "Row predicates the measure is evaluated over",
        }
    ),
]


class CreateAlertRequest(BaseModel):
    """Body for creating a threshold alert in a project."""

    project_id: str
    name: str
    view: AlertView
    measure: str = Field(description="A measure of the view, e.g. latency, cost, count")
    aggregation: AlertAggregation
    filters: AlertFilters = Field(default_factory=list)
    window: AlertWindow
    threshold_operator: AlertThresholdOperator
    threshold: float = Field(allow_inf_nan=False)
    renotify: AlertRenotifyRequest
    no_data_mode: AlertNoDataMode | None = Field(
        None, description="What a window that measured nothing means; column default when omitted"
    )


class CreateAlertResponse(BaseModel):
    """The created alert with its full rule (alert creation is strict, never idempotent)."""

    created: bool
    alert: AlertDetail


# ── partial updates (PATCH) ──────────────────────────────────────────────
#
# See the module docstring for the null rule. Field sets are the create's
# fields minus the immutable ones (tenancy, a detector's template, a widget's
# dashboard and type) plus what the UI already edits; the write service owns
# the deep validation and the diff, and reports the fields it changed.

# The spec union shared by the widget create and update bodies. The update has
# no ``type`` beside it: the stored type is authoritative and the write
# service checks the dialect against it, so a foreign dialect is its 400.
WidgetSpecBody = Annotated[WidgetSpec | TraceFeedSpec, AfterValidator(_require_bounded_spec)]


class _UpdateRequest(BaseModel):
    """Base of every PATCH body: unknown keys are a 422, never a silent drop."""

    model_config = ConfigDict(extra="forbid")


class UpdateWorkspaceRequest(_UpdateRequest):
    """Body for renaming a workspace the caller administers."""

    name: str | MISSING = MISSING


class UpdateProjectRequest(_UpdateRequest):
    """Body for editing a project (requires ADMIN in its workspace)."""

    name: str | MISSING = MISSING
    trace_ttl_days: int | None | MISSING = Field(
        MISSING, description="Trace retention in days (1-365); null returns to the plan default"
    )


class UpdateDetectorRequest(_UpdateRequest):
    """Body for editing a detector; ``template`` is immutable and not accepted."""

    project_id: str
    name: str | MISSING = MISSING
    prompt: str | MISSING = Field(
        MISSING,
        description=(
            "Detector instructions, stored verbatim. There is no reset to a "
            "template's default on update: send the canonical text to restore it."
        ),
    )
    enabled: bool | MISSING = Field(
        MISSING,
        description=(
            "The pause switch. Detection is ingestion-triggered, so enabling "
            "starts nothing retroactively."
        ),
    )
    sample_rate: int | MISSING = MISSING
    enable_rca: bool | MISSING = MISSING
    output_schema: JsonPayloadList | MISSING = Field(
        MISSING, description="Replaces the whole output schema array"
    )
    trigger_conditions: JsonPayloadList | MISSING = Field(
        MISSING,
        description=(
            "Replaces the whole trigger array; [] removes the trigger so every "
            "completed trace is evaluated. Each condition is {field, op, value} "
            "(metadata also takes key): model_name/environment take =, !=; "
            "cost/total_tokens/duration_ms/errors take >, >=, <, <=, =; "
            "metadata takes =, contains."
        ),
    )
    detection_source: Literal["system", "byok"] | None | MISSING = MISSING
    detection_model: str | None | MISSING = MISSING
    detection_provider: str | None | MISSING = MISSING


class UpdateDashboardRequest(_UpdateRequest):
    """Body for editing a dashboard's name or description (layout stays UI-only)."""

    project_id: str
    name: str | MISSING = MISSING
    description: str | None | MISSING = Field(MISSING, description="null clears the description")


class UpdateWidgetRequest(_UpdateRequest):
    """Body for editing a widget; ``type`` and ``dashboard_id`` are immutable."""

    project_id: str
    title: str | MISSING = MISSING
    spec: WidgetSpecBody | MISSING = Field(
        MISSING,
        description=(
            "Replaces the whole spec, in the dialect of the widget's stored type. "
            'For type "query": a chart spec (view/filters/metric/breakdown/display). '
            'For type "trace_feed": a trace-list feed spec (predicate filters + row limit).'
        ),
    )
    display_config: JsonPayloadDict | None | MISSING = Field(
        MISSING, description="Replaces the whole display config; null resets it to {}"
    )


class UpdateAlertRequest(_UpdateRequest):
    """Body for editing an alert rule (the ten rule fields, all optional).

    The write service validates the patch merged with the stored rule; an
    edit to any evaluated field resets the evaluation state (and clears an
    open page), which the response reports. Status has its own route.
    """

    project_id: str
    name: str | MISSING = MISSING
    view: AlertView | MISSING = MISSING
    measure: str | MISSING = Field(
        MISSING, description="A measure of the view, e.g. latency, cost, count"
    )
    aggregation: AlertAggregation | MISSING = MISSING
    filters: AlertFilters | MISSING = MISSING
    window: AlertWindow | MISSING = MISSING
    threshold_operator: AlertThresholdOperator | MISSING = MISSING
    threshold: Annotated[float, Field(allow_inf_nan=False)] | MISSING = MISSING
    renotify: AlertRenotifyRequest | MISSING = MISSING
    no_data_mode: AlertNoDataMode | MISSING = Field(
        MISSING, description="What a window that measured nothing means"
    )


class AlertStatusRequest(_UpdateRequest):
    """Body for pausing or resuming an alert.

    Only ACTIVE and PAUSED are settable: PARKED is the evaluator's verdict.
    """

    project_id: str
    status: Literal["ACTIVE", "PAUSED"]


class _UpdateResponse(BaseModel):
    """Common head of every update response.

    ``changed`` lists the public (snake_case) names of the fields the request
    actually changed; a patch whose values all equal the stored ones is a 200
    with an empty list and writes nothing.
    """

    updated: bool
    changed: list[str]


class UpdateWorkspaceResponse(_UpdateResponse):
    """The updated workspace."""

    workspace: WorkspaceRow


class UpdateProjectResponse(_UpdateResponse):
    """The updated project."""

    project: ProjectRow


class UpdateDetectorResponse(_UpdateResponse):
    """The updated detector."""

    detector: DetectorRow


class UpdateDashboardResponse(_UpdateResponse):
    """The updated dashboard."""

    dashboard: DashboardRow


class UpdateWidgetResponse(_UpdateResponse):
    """The updated widget."""

    widget: WidgetRow


class UpdateAlertResponse(_UpdateResponse):
    """The updated alert with its full rule, plus what the edit did to its state."""

    alert: AlertDetail
    state_reset: bool = Field(
        False,
        description=(
            "True when the edit voided the evaluation state and made the rule "
            "due now (any evaluated field changed, or the alert was resumed)"
        ),
    )
    page_cleared: bool = Field(
        False, description="True when the alert was firing and the edit discarded that page"
    )


# ── deletes ──────────────────────────────────────────────────────────────


class DeletedResource(BaseModel):
    """What a delete removed: the row's id and name, for the receipt."""

    id: str
    name: str


class _DeleteResponse(BaseModel):
    """Common head of every delete response: the reason is echoed as recorded."""

    deleted: bool
    reason: str


class DeleteWorkspaceResponse(_DeleteResponse):
    """A hard-deleted workspace and the counts of what cascaded with it."""

    cascaded: dict[str, int] | None = None
    workspace: DeletedResource


class DeleteProjectResponse(_DeleteResponse):
    """A soft-deleted project (its data stays for the retention window)."""

    project: DeletedResource


class DeleteDetectorResponse(_DeleteResponse):
    """A hard-deleted detector (its findings stay readable)."""

    detector: DeletedResource


class DeleteDashboardResponse(_DeleteResponse):
    """A hard-deleted dashboard and the count of widgets removed with it."""

    cascaded: dict[str, int] | None = None
    dashboard: DeletedResource


class DeleteWidgetResponse(_DeleteResponse):
    """A hard-deleted widget (its layout entry is removed with it)."""

    widget: DeletedResource


class DeleteAlertResponse(_DeleteResponse):
    """A hard-deleted alert; ``page_cleared`` reports an open page it discarded."""

    page_cleared: bool = False
    alert: DeletedResource
