"""Compile validated widget specs into parameterized ClickHouse SQL.

Security model: field names resolve through the static registry to fixed SQL
expressions; every user value binds as a ClickHouse parameter. User strings
never appear in SQL text, so injection is structurally impossible.
"""

import math
from collections.abc import Callable
from datetime import datetime, timedelta
from typing import Any

from db.clickhouse import get_clickhouse_client
from db.clickhouse.query_settings import READ_QUERY_SETTINGS
from rest.schemas.dashboards import WidgetFilter, WidgetSpec
from rest.services.filters.translate import MAX_KEY_LENGTH, keyed_map_match
from rest.services.widget_registry import KEYED_COLUMN_SLOT, REGISTRY, FieldDef, ViewDef
from rest.sql_utils import escape_ilike, to_utc_naive

MAX_GROUPS = 50  # top-N breakdown groups; remainder folds into "other"
MAX_TABLE_ROWS = 1000
HISTOGRAM_BINS = 20
HOUR_BUCKET_MAX = timedelta(days=2)
# Ceiling on an explicitly bucketed series: the range-derived path is bounded by
# its own coarsening, a caller-chosen bucket is not. 500 is more points than a
# chart column of pixels can distinguish, and with a breakdown it caps the
# result at (MAX_GROUPS + 1) * 500 rows — the same order as the widest
# range-derived query — so one tile cannot become an unbounded read.
MAX_EXPLICIT_BUCKETS = 500

_AGG_SQL = {
    "count": "count({expr})",
    "sum": "sum({expr})",
    "avg": "avg({expr})",
    "min": "min({expr})",
    "max": "max({expr})",
    "p50": "quantile(0.5)({expr})",
    "p75": "quantile(0.75)({expr})",
    "p90": "quantile(0.9)({expr})",
    "p95": "quantile(0.95)({expr})",
    "p99": "quantile(0.99)({expr})",
    # uniqExact, not uniq: the approximate variant can drift near a threshold,
    # and every existing distinct-count in the backend already uses uniqExact.
    "uniq": "uniqExact({expr})",
}

# Aggregations where an empty time bucket has no meaningful value: count/sum
# of nothing is honestly 0, but the average or a percentile of nothing is a
# gap, not a zero. Drives Nullable metrics on time series so WITH FILL rows
# come back NULL and charts render gaps instead of false drops to zero.
_NON_ADDITIVE_AGGS = frozenset({"avg", "min", "max", "p50", "p75", "p90", "p95", "p99"})

_OP_SQL = {
    "=": "{expr} = {{{p}:{t}}}",
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


def _time_bucket(
    start_time: datetime, end_time: datetime, bucket_seconds: int | None
) -> tuple[Callable[[str], str], str, int]:
    """The bucket expression builder, the WITH FILL step and the width in seconds."""
    if bucket_seconds is not None:
        step = f"INTERVAL {bucket_seconds} SECOND"
        return (lambda expr: f"toStartOfInterval({expr}, {step}, 'UTC')"), step, bucket_seconds
    gran = _pick_granularity(start_time, end_time)
    if gran == "hour":
        return (lambda expr: f"toStartOfHour({expr}, 'UTC')"), "INTERVAL 1 HOUR", 3600
    return (lambda expr: f"toStartOfDay({expr}, 'UTC')"), "INTERVAL 1 DAY", 86400


def _keyed_condition(f: FieldDef, flt: WidgetFilter, index: int, params: dict[str, Any]) -> str:
    """Lower one keyed filter to a guarded ``map[key] <op> value`` comparison.

    The key binds as a query parameter exactly like the value: nothing about a keyed filter
    reaches SQL as an identifier, which is what makes an arbitrary typed key safe. An
    unrecognized key matches nothing rather than erroring.

    Raises:
        WidgetSpecError: If the key is missing, empty, or longer than ``MAX_KEY_LENGTH``.
    """
    if not flt.key:
        raise WidgetSpecError("filters", f"Filter on '{flt.field}' requires a non-empty key")
    if len(flt.key) > MAX_KEY_LENGTH:
        raise WidgetSpecError(
            "filters", f"Key on '{flt.field}' exceeds {MAX_KEY_LENGTH} characters"
        )
    kname = f"f{index}k"
    params[kname] = flt.key
    pname = f"f{index}"
    text = _string_value_text(flt.value)
    # ILIKE for contains, with `%`/`_` escaped as on the unkeyed string path below.
    params[pname] = f"%{escape_ilike(text)}%" if flt.op == "contains" else text
    return keyed_map_match(f.expr, f"{{{kname}:String}}", f"{{{pname}:String}}", flt.op)


def _string_value_text(value: str | float) -> str:
    """A value's spelling on any String comparison, keyed or unkeyed.

    ``WidgetFilter`` lets pydantic coerce a JSON ``5`` to ``5.0``, whose ``str()`` is
    ``"5.0"`` and matches a stored ``"5"`` nowhere. The alert filter schema accepts a number
    for any field, so every String comparison routes through this one spelling.
    """
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value)


def _base_relation(view: ViewDef, keyed_exprs: list[str]) -> str:
    """The view's base relation, carrying the Map columns this spec's keyed filters read.

    Splicing rather than declaring, so a spec with no keyed filter compiles the exact
    relation it did before keyed filters existed; see ``KEYED_COLUMN_SLOT``.
    """
    if not keyed_exprs:
        return view.base_sql
    # dict.fromkeys dedups with stable order: two predicates may name the same Map column.
    return view.base_sql.replace(KEYED_COLUMN_SLOT, ", " + ", ".join(dict.fromkeys(keyed_exprs)))


def compile_widget_query(
    spec: WidgetSpec,
    project_id: str,
    start_time: datetime,
    end_time: datetime,
    bucket_seconds: int | None = None,
    include_row_count: bool = False,
) -> tuple[str, dict[str, Any]]:
    """Return (sql, params) for the spec. Raises WidgetSpecError on bad specs.

    ``include_row_count`` adds ``count() AS row_count`` beside the scalar of a
    number display, over exactly the metric's FROM/WHERE. Alert evaluation
    needs the population size to tell an empty window from a null aggregate,
    and folding it here costs one column where a second query would double the
    ClickHouse load of every tick.
    """
    # Normalize like every other ClickHouse endpoint: mixed tz-aware/naive
    # datetimes (both accepted by the request schema) crash subtraction in
    # granularity picking, and a reversed window compiles a negative LIMIT
    # that ClickHouse rejects — both surfaced as opaque 500s.
    start_time = to_utc_naive(start_time)
    end_time = to_utc_naive(end_time)
    if end_time <= start_time:
        raise WidgetSpecError("time_range", "end_time must be after start_time")
    is_timeseries = spec.display.type in ("line", "area")
    # Checked before the histogram early-return so a misuse cannot pass silently.
    if include_row_count and spec.display.type != "number":
        raise WidgetSpecError(
            "display",
            f"include_row_count requires a number display; got '{spec.display.type}'",
        )
    if bucket_seconds is not None:
        # A width on a display with no time axis means the caller has the request's
        # shape wrong — same stance as the key-on-an-unkeyed-field guard below.
        if not is_timeseries:
            raise WidgetSpecError(
                "bucket_seconds",
                f"bucket_seconds requires a time axis; display '{spec.display.type}' has none",
            )
        if (end_time - start_time).total_seconds() > bucket_seconds * MAX_EXPLICIT_BUCKETS:
            raise WidgetSpecError(
                "bucket_seconds",
                f"A {bucket_seconds}s bucket covers this range in more than"
                f" {MAX_EXPLICIT_BUCKETS} buckets",
            )

    view = REGISTRY[spec.view]
    params: dict[str, Any] = {
        "project_id": project_id,
        "start_time": start_time,
        "end_time": end_time,
    }

    # --- filters ---
    conditions: list[str] = []
    keyed_exprs: list[str] = []
    for i, flt in enumerate(spec.filters):
        f = _resolve_field(view.fields, flt.field, "filters")
        if flt.op not in f.filter_ops:
            raise WidgetSpecError(
                "filters",
                f"Op '{flt.op}' not allowed for '{flt.field}'. Allowed: {list(f.filter_ops)}",
            )
        # A key on an unkeyed field means the caller has the field's shape wrong; dropping
        # it silently would answer a different question than the one asked.
        if flt.key is not None and not f.requires_key:
            raise WidgetSpecError("filters", f"Field '{flt.field}' does not take a key")
        if f.requires_key:
            conditions.append(_keyed_condition(f, flt, i, params))
            keyed_exprs.append(f.expr)
            continue
        pname = f"f{i}"
        if f.type == "string":
            ch_type = "String"
            text = _string_value_text(flt.value)
            if flt.op == "contains":
                # Escape %, _, and \ so they match literally rather than acting
                # as ILIKE wildcards or escape characters in the user's value.
                param_value = f"%{escape_ilike(text)}%"
            else:
                param_value = text
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

    base = f"({_base_relation(view, keyed_exprs)})"

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

    if is_timeseries and spec.metric.agg in _NON_ADDITIVE_AGGS:
        # For count/sum an empty bucket genuinely is zero, but for averages
        # and percentiles it has NO value — a filled 0 would render as a false
        # collapse (a p95 latency line dipping to nothing). Nullable makes the
        # WITH FILL rows below carry NULL, which the chart draws as a gap.
        metric_sql = f"toNullable({metric_sql})"
    # Bound unconditionally: both the bucketing branch and the row-cap branch
    # below key off is_timeseries, and an implicit binding would let them drift.
    bucket_of, step, granule_seconds = _time_bucket(start_time, end_time, bucket_seconds)
    # Fill empty buckets across the whole window so the x-axis spans the
    # selected range even when stored data starts later: missing buckets come
    # back as zero rows instead of the chart starting at first data. WITH FILL
    # TO is exclusive, so the bound is one step past the bucket of the last
    # in-window instant (end_time - 1ms) — that covers the trailing straddle
    # bucket of a misaligned window and stays exact for aligned ones.
    fill = (
        f" WITH FILL FROM {bucket_of('{start_time:DateTime64(3)}')}"
        f" TO {bucket_of('{end_time:DateTime64(3)} - INTERVAL 1 MILLISECOND')}"
        f" + {step} STEP {step}"
    )
    if is_timeseries:
        # 'UTC' aligns bucket boundaries with the UTC time-range params,
        # regardless of the ClickHouse server's local timezone.
        select_cols.append(f"{bucket_of('event_time')} AS bucket")
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
    if include_row_count:
        # Only reachable on a number display (guarded above), where there is no
        # GROUP BY: count() is the whole filtered population, the same number
        # the count(*) sentinel field measures.
        select_cols.append("count() AS row_count")
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
    spec: WidgetSpec,
    project_id: str,
    start_time: datetime,
    end_time: datetime,
    bucket_seconds: int | None = None,
    include_row_count: bool = False,
) -> dict[str, Any]:
    """Compile and execute, returning the response contract dict."""
    # Normalized once here; compile_widget_query re-normalizing is idempotent
    # and keeps it safe for direct callers.
    start_time = to_utc_naive(start_time)
    end_time = to_utc_naive(end_time)
    sql, params = compile_widget_query(
        spec, project_id, start_time, end_time, bucket_seconds, include_row_count
    )
    client = get_clickhouse_client()
    # Execution bounds (readonly, timeout, GROUP BY spill ceiling) are the shared read
    # settings: a dashboard tile is the same interactive, time-windowed GROUP BY as the
    # trace list and the filter-option scans, so it gets the same ceilings.
    result = client.query(sql, parameters=params, settings=READ_QUERY_SETTINGS)
    meta: dict[str, Any] = {}
    if spec.display.type in ("line", "area"):
        # An explicit bucket has no name in the hour/day vocabulary, so it
        # reports its width in milliseconds instead.
        meta["granularity"] = (
            bucket_seconds * 1000
            if bucket_seconds is not None
            else _pick_granularity(start_time, end_time)
        )
    return {
        "columns": list(result.column_names),
        "rows": [list(r) for r in result.result_rows],
        "meta": meta,
    }
