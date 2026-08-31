"""Request/response schemas for the public write API (create operations).

Validation here is deliberately shape-level only (types + required-ness): the
deep field validation — exact messages, ranges, enum registries — lives in the
Next.js write services, whose own error strings pass through the proxy routes
unchanged. Duplicating those rules here would let the two surfaces drift and
mask the service's canonical messages.

The one exception is the widget ``spec``: it is a structured contract in its
own right (two dialects keyed by the widget ``type``), typed here so the
OpenAPI document — and every tool schema generated from it — shows the real
shape instead of a bare object.

Every response carries a ``created`` flag: ``True`` for a fresh row, ``False``
when an idempotent re-create returned the existing one.
"""

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator
from pydantic.json_schema import SkipJsonSchema

from rest.schemas.dashboards import WidgetSpec
from rest.services.filters.translate import MAX_FILTERS, MAX_KEY_LENGTH, MAX_VALUE_LENGTH


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
    spec: WidgetSpec | TraceFeedSpec = Field(
        description=(
            'The widget\'s content. For type "query": a chart spec '
            '(view/filters/metric/breakdown/display). For type "trace_feed": '
            "a trace-list feed spec (predicate filters + row limit)."
        )
    )
    display_config: dict | None = None

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


class CreateWidgetResponse(BaseModel):
    """The created widget (widget creation is strict, never idempotent)."""

    id: str
    dashboard_id: str
    title: str
    type: str
    created: bool
