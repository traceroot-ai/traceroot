"""Request/response models for the widget query engine.

Validation split: shape and closed enums (DisplayType, AggName, filter op
Literals) are enforced here by Pydantic. The ``field``, ``measure``, and
``breakdown`` names are deliberately plain strings — they are validated by
the SQL compiler against ``rest.services.widget_registry.REGISTRY``, which
is the single source of truth for which views and fields exist.
"""

from datetime import datetime
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, WithJsonSchema

DisplayType = Literal["line", "area", "bar", "pie", "number", "table", "histogram"]
AggName = Literal["count", "sum", "avg", "min", "max", "p50", "p95", "p99"]


class _StrictModel(BaseModel):
    """Base for request-side models: reject unknown fields."""

    model_config = ConfigDict(extra="forbid")


class WidgetFilter(_StrictModel):
    """A single filter predicate applied to a widget query."""

    field: str
    op: Literal["=", "contains", ">", ">=", "<", "<="]
    # min_length mirrors the frontend schema: an empty value means the filter
    # was never completed and would silently match only empty-valued rows.
    # The union keeps a top-level JSON-Schema type array: this model feeds
    # generated tool schemas (via the public widget-create body), and some
    # model providers reject properties without a `type`. The empty-string
    # guard lives in a per-branch anyOf rather than beside the type array —
    # a bare minLength next to ["string", "number"] is applied to numbers by
    # the agent's argument validator, which then rejects every numeric filter
    # with no usable error.
    value: Annotated[
        Annotated[str, StringConstraints(min_length=1)] | float,
        WithJsonSchema(
            {
                "type": ["string", "number"],
                "anyOf": [{"type": "string", "minLength": 1}, {"type": "number"}],
            }
        ),
    ]


class WidgetMetric(_StrictModel):
    """The measure and aggregation function that define the widget's y-axis."""

    measure: str
    agg: AggName


class WidgetDisplay(_StrictModel):
    """Controls how the query result is rendered on the dashboard."""

    type: DisplayType


class WidgetSpec(_StrictModel):
    """Full declarative specification of a single dashboard widget.

    Mirrors the canonical zod ``WidgetSpecSchema``
    (frontend/ui/src/features/dashboards/types.ts); the frontend
    widget-spec-parity test guards the two against structural drift.
    """

    view: Literal["spans", "traces"]
    filters: list[WidgetFilter] = Field(default_factory=list)
    metric: WidgetMetric
    breakdown: str | None = None
    display: WidgetDisplay


# The preset ids a window may be described with; the durations live in
# rest.services.date_presets (a test keeps this Literal equal to that table).
RangeId = Literal["30m", "1h", "3h", "6h", "1d", "7d", "14d", "30d", "60d", "90d"]


class WidgetQueryRequest(_StrictModel):
    """Envelope that pairs a WidgetSpec with the time window to answer it for.

    The window is either a ``range`` preset (the site picker's ids — how the
    agent and the CLI describe one) or explicit ``start_time``/``end_time``
    (how the dashboard page and the card previews do). Neither means the
    site's default window; both, or one bound alone, is rejected. The rules
    live in ``rest.services.date_presets.resolve_window`` so every query
    surface applies the same ones.
    """

    spec: WidgetSpec
    range: RangeId | None = Field(
        default=None,
        description=(
            "A preset window ending now, by the site picker's id. Give this or "
            "explicit start_time/end_time; neither means the site's 24-hour default."
        ),
    )
    start_time: datetime | None = None
    end_time: datetime | None = None


class QueryWindow(BaseModel):
    """The window a query was actually answered for.

    ``range`` is the preset id the caller gave (or the default's, when they
    gave nothing) and None for explicit bounds. ``clamped`` is True when the
    plan's retention pulled ``start_time`` forward — the honest reason a
    caller's window and the answered one differ.
    """

    start_time: datetime
    end_time: datetime
    range: RangeId | None
    clamped: bool


class WidgetQueryResponse(BaseModel):
    """Query result returned to the frontend; meta carries display hints (e.g. granularity for time-series displays)."""

    columns: list[str]
    rows: list[list[Any]]
    meta: dict[str, Any] = Field(default_factory=dict)
    window: QueryWindow
