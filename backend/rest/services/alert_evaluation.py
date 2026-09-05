"""Reduce alert rules to scalars over one caller-supplied window.

The scheduler tick runs in the Node worker, which has no ClickHouse client, so it
reaches the widget query engine over the internal alert-evaluate endpoint.
"""

import logging
import math
from collections.abc import Sequence
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime
from typing import Any, NamedTuple

from rest.schemas.alerts import (
    ALERT_ERROR_KIND_QUERY,
    ALERT_ERROR_KIND_SPEC,
    MAX_ALERT_WINDOW,
    MAX_ALERT_WINDOW_END_LAG,
    AlertEvaluationResult,
    AlertEvaluationSpec,
)
from rest.schemas.dashboards import AggName, WidgetDisplay, WidgetFilter, WidgetMetric, WidgetSpec
from rest.services.widget_query import _NON_ADDITIVE_AGGS, WidgetSpecError, run_widget_query
from rest.sql_utils import to_utc_naive

logger = logging.getLogger(__name__)

ALERT_VIEW_SPANS = "SPANS"

# The registry's count(*) sentinel field, on both views.
COUNT_FIELD = "count"

# Per-batch query concurrency. The worker sends chunks of up to 25 alerts
# (ALERT_EVALUATION_CHUNK_SIZE) and aborts the request at 30s, while one query
# may run to its 10s server cap. 13 workers hold the worst case to two 10s
# waves — inside the client's budget with margin — without letting a single
# tick monopolize the shared ClickHouse connection pool.
_MAX_CONCURRENT_QUERIES = 13


class _MeasureSource(NamedTuple):
    view: str
    field: str


# Mirrors ``SOURCE_BY_ALERT_MEASURE`` in frontend/packages/core/src/alerts.ts,
# because the evaluated number must be the previewed number.
_WIDGET_SOURCE_BY_ALERT_MEASURE: dict[str, _MeasureSource] = {
    "count": _MeasureSource("spans", COUNT_FIELD),
    "trace_id": _MeasureSource("spans", "trace_id"),
    "latency": _MeasureSource("spans", "duration_ms"),
    "cost": _MeasureSource("spans", "cost"),
    "input_tokens": _MeasureSource("spans", "input_tokens"),
    "output_tokens": _MeasureSource("spans", "output_tokens"),
    "total_tokens": _MeasureSource("spans", "total_tokens"),
    "total_tokens_per_second": _MeasureSource("spans", "tokens_per_second"),
    "unique_user_ids": _MeasureSource("traces", "user_id"),
    "unique_session_ids": _MeasureSource("traces", "session_id"),
}


def evaluate_alerts(
    alerts: Sequence[AlertEvaluationSpec],
    project_id: str,
    window_start: datetime,
    window_end: datetime,
) -> list[AlertEvaluationResult]:
    """Measure every alert over ``[window_start, window_end)``.

    An unmeasurable alert carries its reason in ``error`` and never fails the others.

    Raises:
        WidgetSpecError: If the window itself is invalid — a request fault, not one alert's.
    """
    start_time = to_utc_naive(window_start)
    end_time = to_utc_naive(window_end)
    if end_time <= start_time:
        raise WidgetSpecError("time_range", "window_end must be after window_start")
    if end_time - start_time > MAX_ALERT_WINDOW:
        raise WidgetSpecError(
            "time_range",
            f"window must span at most {int(MAX_ALERT_WINDOW.total_seconds())} seconds",
        )
    # The span cap bounds the window's width; this bounds its anchor, which is
    # what keeps an unclamped read from reaching past a plan's retention cutoff.
    if datetime.now(UTC).replace(tzinfo=None) - end_time > MAX_ALERT_WINDOW_END_LAG:
        raise WidgetSpecError(
            "time_range",
            "window_end must be within "
            f"{int(MAX_ALERT_WINDOW_END_LAG.total_seconds())} seconds of now",
        )
    if not alerts:
        return []
    # Concurrent, not serial: a serial loop cost up to chunk-size x the 10s
    # per-query cap against the caller's 30s abort, and failed hardest on the
    # highest-volume projects. The shared ClickHouse client is sessionless and
    # pooled (see ClickHouseClient.from_settings), so overlapping queries are
    # its normal operating mode. ``map`` preserves request order.
    with ThreadPoolExecutor(max_workers=min(_MAX_CONCURRENT_QUERIES, len(alerts))) as pool:
        return list(
            pool.map(lambda alert: _evaluate_one(alert, project_id, start_time, end_time), alerts)
        )


def _evaluate_one(
    alert: AlertEvaluationSpec,
    project_id: str,
    start_time: datetime,
    end_time: datetime,
) -> AlertEvaluationResult:
    try:
        source = _resolve_source(alert)
        value, row_count = _run_scalar_and_count(
            _build_spec(source.view, source.field, alert.aggregation, alert.filters),
            project_id,
            start_time,
            end_time,
        )
        return AlertEvaluationResult(
            alert_id=alert.alert_id,
            value=_measured_value(value, row_count, alert.aggregation),
            row_count=row_count,
        )
    except WidgetSpecError as e:
        # Step-prefixed, and kind-tagged: a broken rule is a different answer than
        # a transient failure, and the caller acts on the difference by parking
        # the rule rather than retrying it every minute.
        return AlertEvaluationResult(
            alert_id=alert.alert_id,
            error=f"{e.step}: {e.message}",
            error_kind=ALERT_ERROR_KIND_SPEC,
        )
    except Exception as e:
        logger.exception(f"Alert evaluation failed for {alert.alert_id}: {e}")
        return AlertEvaluationResult(
            alert_id=alert.alert_id,
            error="Query execution failed",
            error_kind=ALERT_ERROR_KIND_QUERY,
        )


def _measured_value(value: float | None, row_count: int, agg: AggName) -> float | None:
    """The value if the empty window still measured something, else ``None``.

    count/sum/uniq of nothing is honestly zero, so those alerts can judge an
    outage. The rest cannot: over an empty set ClickHouse returns ``min``/``max``
    as the column type's default, which reads as a latency win on a dead pipeline.
    """
    if row_count == 0 and agg in _NON_ADDITIVE_AGGS:
        return None
    return value


def _resolve_source(alert: AlertEvaluationSpec) -> _MeasureSource:
    if alert.view != ALERT_VIEW_SPANS:
        raise WidgetSpecError("view", f"Unsupported alert view '{alert.view}'")
    source = _WIDGET_SOURCE_BY_ALERT_MEASURE.get(alert.measure)
    if source is None:
        raise WidgetSpecError("measure", f"Unknown alert measure '{alert.measure}'")
    # A distinct count over `traces` is the span-grain number only while nothing
    # narrows it, so the preview refuses this combination too.
    if alert.filters and source.view != "spans":
        raise WidgetSpecError("filters", f"Measure '{alert.measure}' cannot carry span filters")
    return source


def _build_spec(view: str, field: str, agg: AggName, filters: Sequence[WidgetFilter]) -> WidgetSpec:
    # A number display with no breakdown is the engine's scalar shape.
    return WidgetSpec(
        view=view,
        filters=list(filters),
        metric=WidgetMetric(measure=field, agg=agg),
        breakdown=None,
        display=WidgetDisplay(type="number"),
    )


def _run_scalar_and_count(
    spec: WidgetSpec, project_id: str, start_time: datetime, end_time: datetime
) -> tuple[float | None, int]:
    """The scalar and the row count it aggregated over, from one folded query.

    Only the row count separates an empty window from an aggregate that
    returned null; folding it as a second column halves what evaluation asks
    of ClickHouse compared to a separate count(*) probe.
    """
    result = run_widget_query(
        spec=spec,
        project_id=project_id,
        start_time=start_time,
        end_time=end_time,
        include_row_count=True,
    )
    rows = result["rows"]
    if not rows or not rows[0]:
        return None, 0
    row = rows[0]
    return _to_float(row[0]), int(row[1])


def _to_float(raw: Any) -> float | None:
    # An average or quantile over an empty window comes back NaN rather than
    # NULL, and NaN has no JSON spelling; both mean the same absent value.
    if raw is None:
        return None
    value = float(raw)
    return value if math.isfinite(value) else None
