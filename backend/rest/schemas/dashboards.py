"""Request/response models for the widget query engine.

Validation split: shape and closed enums (DisplayType, AggName, filter op
Literals) are enforced here by Pydantic. The ``field``, ``measure``, and
``breakdown`` names are deliberately plain strings — they are validated by
the SQL compiler against ``rest.services.widget_registry.REGISTRY``, which
is the single source of truth for which views and fields exist.
"""

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

DisplayType = Literal["line", "area", "bar", "pie", "number", "table", "histogram"]
AggName = Literal["count", "sum", "avg", "min", "max", "p50", "p95", "p99"]


class WidgetFilter(BaseModel):
    """A single filter predicate applied to a widget query."""

    model_config = ConfigDict(extra="forbid")

    field: str
    op: Literal["=", "!=", "contains", ">", ">=", "<", "<="]
    value: str | float


class WidgetMetric(BaseModel):
    """The measure and aggregation function that define the widget's y-axis."""

    model_config = ConfigDict(extra="forbid")

    measure: str
    agg: AggName


class WidgetDisplay(BaseModel):
    """Controls how the query result is rendered on the dashboard."""

    model_config = ConfigDict(extra="forbid")

    type: DisplayType


class WidgetSpec(BaseModel):
    """Full declarative specification of a single dashboard widget."""

    model_config = ConfigDict(extra="forbid")

    view: Literal["spans", "traces"]
    filters: list[WidgetFilter] = Field(default_factory=list)
    metric: WidgetMetric
    breakdown: str | None = None
    display: WidgetDisplay


class WidgetQueryRequest(BaseModel):
    """Envelope that pairs a WidgetSpec with the dashboard time window."""

    model_config = ConfigDict(extra="forbid")

    spec: WidgetSpec
    start_time: datetime
    end_time: datetime


class WidgetQueryResponse(BaseModel):
    """Query result returned to the frontend; meta carries display hints (e.g. granularity for time-series displays)."""

    columns: list[str]
    rows: list[list[Any]]
    meta: dict[str, Any] = Field(default_factory=dict)
