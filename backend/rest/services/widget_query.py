"""Compile validated widget specs into parameterized ClickHouse SQL.

Security model: field names resolve through the static registry to fixed SQL
expressions; every user value binds as a ClickHouse parameter. User strings
never appear in SQL text, so injection is structurally impossible.
"""

import math
from datetime import datetime, timedelta
from typing import Any

from db.clickhouse import get_clickhouse_client
from rest.schemas.dashboards import WidgetSpec
from rest.services.widget_registry import REGISTRY, FieldDef
from rest.sql_utils import escape_ilike, to_utc_naive

MAX_GROUPS = 50  # top-N breakdown groups; remainder folds into "other"
MAX_TABLE_ROWS = 1000
HISTOGRAM_BINS = 20
QUERY_TIMEOUT_S = 10
HOUR_BUCKET_MAX = timedelta(days=2)

_AGG_SQL = {
    "count": "count({expr})",
    "sum": "sum({expr})",
    "avg": "avg({expr})",
    "min": "min({expr})",
    "max": "max({expr})",
    "p50": "quantile(0.5)({expr})",
    "p95": "quantile(0.95)({expr})",
    "p99": "quantile(0.99)({expr})",
}

_OP_SQL = {
    "=": "{expr} = {{{p}:{t}}}",
    "!=": "{expr} != {{{p}:{t}}}",
    ">": "{expr} > {{{p}:{t}}}",
    ">=": "{expr} >= {{{p}:{t}}}",
    "<": "{expr} < {{{p}:{t}}}",
    "<=": "{expr} <= {{{p}:{t}}}",
    "contains": "{expr} ILIKE {{{p}:String}}",
}


class WidgetSpecError(Exception):
    """Spec failed registry validation. `step` names the builder step at fault."""

    def __init__(self, step: str, message: str):
        self.step = step
        self.message = message
        super().__init__(f"{step}: {message}")


def _resolve_field(view_fields: dict[str, FieldDef], name: str, step: str) -> FieldDef:
    f = view_fields.get(name)
    if f is None:
        raise WidgetSpecError(step, f"Unknown field '{name}'. Allowed: {sorted(view_fields)}")
    return f


def _pick_granularity(start_time: datetime, end_time: datetime) -> str:
    return "hour" if end_time - start_time <= HOUR_BUCKET_MAX else "day"


def compile_widget_query(
    spec: WidgetSpec,
    project_id: str,
    start_time: datetime,
    end_time: datetime,
) -> tuple[str, dict[str, Any]]:
    """Return (sql, params) for the spec. Raises WidgetSpecError on bad specs."""
    # Normalize like every other ClickHouse endpoint: mixed tz-aware/naive
    # datetimes (both accepted by the request schema) crash subtraction in
    # granularity picking, and a reversed window compiles a negative LIMIT
    # that ClickHouse rejects — both surfaced as opaque 500s.
    start_time = to_utc_naive(start_time)
    end_time = to_utc_naive(end_time)
    if end_time <= start_time:
        raise WidgetSpecError("time_range", "end_time must be after start_time")

    view = REGISTRY[spec.view]
    params: dict[str, Any] = {
        "project_id": project_id,
        "start_time": start_time,
        "end_time": end_time,
    }

    # --- filters ---
    conditions: list[str] = []
    for i, flt in enumerate(spec.filters):
        f = _resolve_field(view.fields, flt.field, "filters")
        if flt.op not in f.filter_ops:
            raise WidgetSpecError(
                "filters",
                f"Op '{flt.op}' not allowed for '{flt.field}'. Allowed: {list(f.filter_ops)}",
            )
        pname = f"f{i}"
        if f.type == "string":
            ch_type = "String"
            if flt.op == "contains":
                # Escape %, _, and \ so they match literally rather than acting
                # as ILIKE wildcards or escape characters in the user's value.
                param_value = f"%{escape_ilike(str(flt.value))}%"
            else:
                param_value = flt.value
        else:
            ch_type = "Float64"
            try:
                param_value = float(flt.value)
            except (ValueError, TypeError):
                raise WidgetSpecError(
                    "filters", f"Value for '{flt.field}' must be numeric"
                ) from None
        conditions.append(_OP_SQL[flt.op].format(expr=f.expr, p=pname, t=ch_type))
        params[pname] = param_value
    where = f"WHERE {' AND '.join(conditions)}" if conditions else ""

    base = f"({view.base_sql})"

    # A number tile renders exactly one value, so a breakdown would silently
    # drop every group but the first — reject it like histogram does.
    if spec.display.type == "number" and spec.breakdown is not None:
        raise WidgetSpecError("breakdown", "Number display does not support a breakdown dimension")

    # Pie and bar plot one mark per category; without a breakdown the query
    # collapses to a single unlabeled datum with nothing to chart.
    if spec.display.type in ("pie", "bar") and spec.breakdown is None:
        raise WidgetSpecError(
            "breakdown", f"{spec.display.type} display requires a breakdown dimension"
        )

    # --- histogram compiles to its own shape ---
    if spec.display.type == "histogram":
        if spec.breakdown is not None:
            raise WidgetSpecError("breakdown", "Histogram does not support a breakdown dimension")
        measure = _resolve_field(view.fields, spec.metric.measure, "metric")
        if measure.type != "number" or measure.expr == "*":
            raise WidgetSpecError("metric", f"'{spec.metric.measure}' cannot be histogrammed")
        # toFloat64 is required because histogram() rejects Decimal types (e.g. cost is Decimal64).
        # It is a no-op for Int64/Float64/Nullable measures.
        sql = (
            f"SELECT tupleElement(b, 1) AS lo, tupleElement(b, 2) AS hi, tupleElement(b, 3) AS height "
            f"FROM (SELECT arrayJoin(histogram({HISTOGRAM_BINS})(toFloat64({measure.expr}))) AS b "
            f"FROM {base} {where})"
        )
        return sql, params

    # --- metric ---
    measure = _resolve_field(view.fields, spec.metric.measure, "metric")
    if spec.metric.agg not in measure.aggs:
        raise WidgetSpecError(
            "metric",
            f"Agg '{spec.metric.agg}' not allowed for '{spec.metric.measure}'."
            f" Allowed: {list(measure.aggs)}",
        )
    metric_sql = _AGG_SQL[spec.metric.agg].format(expr=measure.expr)

    # --- dimensions: optional time bucket + optional breakdown ---
    select_cols: list[str] = []
    group_cols: list[str] = []
    order_by = ""

    is_timeseries = spec.display.type in ("line", "area")
    # Bound unconditionally: both the bucketing branch and the row-cap branch
    # below key off is_timeseries, and an implicit binding would let them drift.
    gran = _pick_granularity(start_time, end_time)
    # Fill empty buckets across the whole window so the x-axis spans the
    # selected range even when stored data starts later: missing buckets come
    # back as zero rows instead of the chart starting at first data. WITH FILL
    # TO is exclusive, so the bound is one step past the bucket of the last
    # in-window instant (end_time - 1ms) — that covers the trailing straddle
    # bucket of a misaligned window and stays exact for aligned ones.
    # Bound unconditionally, like gran, so the two is_timeseries branches
    # below can't drift apart.
    bucket_fn = "toStartOfHour" if gran == "hour" else "toStartOfDay"
    step = "INTERVAL 1 HOUR" if gran == "hour" else "INTERVAL 1 DAY"
    fill = (
        f" WITH FILL FROM {bucket_fn}({{start_time:DateTime64(3)}}, 'UTC')"
        f" TO {bucket_fn}({{end_time:DateTime64(3)}} - INTERVAL 1 MILLISECOND, 'UTC')"
        f" + {step} STEP {step}"
    )
    if is_timeseries:
        # 'UTC' aligns day/hour boundaries with the UTC time-range params,
        # regardless of the ClickHouse server's local timezone.
        select_cols.append(f"{bucket_fn}(event_time, 'UTC') AS bucket")
        group_cols.append("bucket")
        order_by = f"ORDER BY bucket{fill}"

    if spec.breakdown is not None:
        bd = _resolve_field(view.fields, spec.breakdown, "breakdown")
        if not bd.groupable:
            raise WidgetSpecError("breakdown", f"'{spec.breakdown}' is not groupable")
        # Top-N guard: keep the MAX_GROUPS largest groups, fold the rest into
        # 'other' so a high-cardinality breakdown can't return unbounded rows.
        # Note: a genuine breakdown value named "other" will merge with this fold
        # bucket — accepted tradeoff for simplicity.
        # NULL breakdown values also fold into 'other': NULL fails the IN
        # membership test so the outer if() takes the else branch. Intentional —
        # surfacing a separate NULL bucket would require extra special-casing for
        # little benefit on the dashboard.
        # ifNull pins the column type to plain String: for a Nullable
        # breakdown expr the if() supertype would be Nullable(String), making
        # WITH FILL's synthesized rows carry NULL instead of the '' the
        # frontend pivot recognizes as a gap row. Runtime values are never
        # NULL — NULLs fail the IN test and fold into 'other'.
        select_cols.append(
            f"ifNull(if({bd.expr} IN (SELECT {bd.expr} FROM {base} {where} "
            f"GROUP BY {bd.expr} ORDER BY {metric_sql} DESC LIMIT {MAX_GROUPS}), "
            f"toString({bd.expr}), 'other'), '') AS {spec.breakdown}"
        )
        group_cols.append(spec.breakdown)
        if is_timeseries:
            # Include breakdown in ORDER BY for deterministic ordering when
            # multiple breakdown values share the same bucket. WITH FILL stays
            # on the bucket sort key; filled rows carry the breakdown column's
            # String default ('') and a zero value, which the frontend pivot
            # treats as domain-only rows.
            order_by = f"ORDER BY bucket{fill}, {spec.breakdown}"
        else:
            order_by = "ORDER BY value DESC"

    select_cols.append(f"{metric_sql} AS value")
    group_by = f"GROUP BY {', '.join(group_cols)}" if group_cols else ""

    # Row cap: for table display use a fixed row limit.
    # For timeseries or breakdown displays, derive the cap from the actual
    # query window so that long ranges aren't silently truncated.
    if spec.display.type == "table":
        row_limit = MAX_TABLE_ROWS
    elif is_timeseries:
        # Each time bucket can have up to (MAX_GROUPS + 1) rows: one per
        # breakdown group plus the 'other' fold bucket. Compute the number of
        # expected buckets from the window size so every bucket is included.
        granule_seconds = 3600 if gran == "hour" else 86400
        window_seconds = (end_time - start_time).total_seconds()
        # +1: misaligned windows straddle one extra bucket (half-open [start, end) over toStartOfX boundaries).
        n_buckets = math.ceil(window_seconds / granule_seconds) + 1
        row_limit = n_buckets * (MAX_GROUPS + 1)
    elif spec.breakdown is not None:
        # Pure breakdown (no time axis): one row per group + 'other'.
        row_limit = MAX_GROUPS + 1
    else:
        # No dimensions: single aggregate row.
        row_limit = 1

    limit = f"LIMIT {row_limit}"

    sql = f"SELECT {', '.join(select_cols)} FROM {base} {where} {group_by} {order_by} {limit}"
    return sql, params


def run_widget_query(
    spec: WidgetSpec, project_id: str, start_time: datetime, end_time: datetime
) -> dict[str, Any]:
    """Compile and execute, returning the response contract dict."""
    # Normalized once here; compile_widget_query re-normalizing is idempotent
    # and keeps it safe for direct callers.
    start_time = to_utc_naive(start_time)
    end_time = to_utc_naive(end_time)
    sql, params = compile_widget_query(spec, project_id, start_time, end_time)
    client = get_clickhouse_client()
    result = client.query(
        sql,
        parameters=params,
        settings={"readonly": 1, "max_execution_time": QUERY_TIMEOUT_S},
    )
    meta: dict[str, Any] = {}
    if spec.display.type in ("line", "area"):
        meta["granularity"] = _pick_granularity(start_time, end_time)
    return {
        "columns": list(result.column_names),
        "rows": [list(r) for r in result.result_rows],
        "meta": meta,
    }
