"""Request/response models for internal alert evaluation.

``view`` and ``measure`` stay plain strings the evaluation service resolves, so
an unknown one is that alert's ``error`` rather than a rejection of the batch.
"""

from datetime import datetime, timedelta
from typing import Annotated

from pydantic import BaseModel, ConfigDict, Field

from rest.schemas.dashboards import AggName, WidgetFilter

__all__ = [
    "MAX_ALERTS_PER_REQUEST",
    "MAX_ALERT_WINDOW",
    "MAX_ALERT_WINDOW_MS",
    "MAX_ALERT_WINDOW_END_LAG",
    "AlertEvaluationSpec",
    "AlertEvaluationRequest",
    "AlertEvaluationResult",
    "AlertEvaluationResponse",
]

# Each alert costs up to two capped ClickHouse reads, so bounding the batch
# bounds the request's worst-case wall time. Authority for the copy in
# frontend/worker/src/alerts/evaluator-client.ts, which chunks a larger claim.
MAX_ALERTS_PER_REQUEST = 50

# Enforced here, so a window past this ceiling fails evaluation forever rather
# than degrading. Authority for ALERT_WINDOWS in frontend/packages/core/src/constants.ts.
MAX_ALERT_WINDOW = timedelta(hours=2)

# The same ceiling in the unit ALERT_WINDOWS is written in.
MAX_ALERT_WINDOW_MS = int(MAX_ALERT_WINDOW.total_seconds() * 1000)

# How far behind the server's clock a window may end.
MAX_ALERT_WINDOW_END_LAG = timedelta(hours=1)


class AlertEvaluationSpec(BaseModel):
    """One alert's measurement, as stored on the rule."""

    model_config = ConfigDict(extra="forbid")

    alert_id: str
    view: str
    measure: str
    aggregation: AggName
    # The widget engine's own predicate shape, so a saved alert filter and its
    # live preview compile through one declaration.
    filters: list[WidgetFilter] = Field(default_factory=list)


class AlertEvaluationRequest(BaseModel):
    """A batch of alerts to evaluate over one shared window."""

    model_config = ConfigDict(extra="forbid")

    project_id: str
    window_start: datetime
    window_end: datetime
    alerts: Annotated[
        list[AlertEvaluationSpec], Field(min_length=1, max_length=MAX_ALERTS_PER_REQUEST)
    ]


class AlertEvaluationResult(BaseModel):
    """One alert's measured value, or why it could not be measured."""

    alert_id: str
    value: float | None = None
    row_count: int = 0
    error: str | None = None


class AlertEvaluationResponse(BaseModel):
    """One result per requested alert, in request order."""

    results: list[AlertEvaluationResult]
