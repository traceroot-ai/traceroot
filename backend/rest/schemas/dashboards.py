"""Request/response models for the widget query engine.

Validation split: shape and closed enums (DisplayType, AggName, filter op
Literals) are enforced here by Pydantic. The ``field``, ``measure``, and
``breakdown`` names are deliberately plain strings — they are validated by
the SQL compiler against ``rest.services.widget_registry.REGISTRY``, which
is the single source of truth for which views and fields exist.
"""

from datetime import datetime
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints

DisplayType = Literal["line", "area", "bar", "pie", "number", "table", "histogram"]
AggName = Literal["count", "sum", "avg", "min", "max", "p50", "p75", "p90", "p95", "p99", "uniq"]


class _StrictModel(BaseModel):
    """Base for request-side models: reject unknown fields."""

    model_config = ConfigDict(extra="forbid")


class WidgetFilter(_StrictModel):
    """A single filter predicate applied to a widget query."""

    field: str
    op: Literal["=", "contains", ">", ">=", "<", "<="]
    # min_length mirrors the frontend schema: an empty value means the filter
    # was never completed and would silently match only empty-valued rows.
    value: Annotated[str, StringConstraints(min_length=1)] | float
    # The map key for a keyed field. Unconstrained here: whether a key is required,
    # forbidden or over-length depends on the field, so the compiler raises those.
    key: str | None = None


class WidgetMetric(_StrictModel):
    """The measure and aggregation function that define the widget's y-axis."""

    measure: str
    agg: AggName


class WidgetDisplay(_StrictModel):
    """Controls how the query result is rendered on the dashboard."""

    type: DisplayType


class WidgetSpec(_StrictModel):
    """Full declarative specification of a single dashboard widget."""

    view: Literal["spans", "traces"]
    filters: list[WidgetFilter] = Field(default_factory=list)
    metric: WidgetMetric
    breakdown: str | None = None
    display: WidgetDisplay


class WidgetQueryRequest(_StrictModel):
    """Envelope that pairs a WidgetSpec with the dashboard time window."""

    spec: WidgetSpec
    start_time: datetime
    end_time: datetime
    # Time-series bucket width, when the caller needs one specific grain rather than
    # the range-derived one. Ignored by displays that carry no time axis.
    bucket_seconds: int | None = Field(default=None, ge=1, le=86_400)


class WidgetQueryResponse(BaseModel):
    """Query result returned to the frontend; meta carries display hints (e.g. granularity for time-series displays)."""

    columns: list[str]
    rows: list[list[Any]]
    meta: dict[str, Any] = Field(default_factory=dict)
