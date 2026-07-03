"""Predicate -> parameterized WHERE translator for the trace list.

Turns filter predicates into SQL condition strings that the caller appends to the
shared ``conditions`` list in ``TraceReaderService.list_traces`` — the list that feeds
BOTH the page CTE and the separate count query. Every condition is keyed on
``t.trace_id`` and bound through query parameters (never string-interpolated), so a
filter narrows the page and the total identically and safely.

Structured as a per-field lowering plus a small assembler that groups predicates by
registry level. Each membership predicate becomes its own span semi-join (independent
existence); the safety boundary is the per-field operator whitelist validated against the
registry here, not downstream.
"""

import json
import math
from typing import Any

from pydantic import BaseModel, ValidationError

from rest.services.filters.columns import (
    FilterColumn,
    FilterLevel,
    FilterOperator,
    FilterType,
    get_column,
)
from rest.sql_utils import escape_ilike


class Predicate(BaseModel):
    """A single filter clause from the ``?filters=`` array.

    Attributes:
        field (str): The registry column name to filter on.
        op (str): The operator (validated against the field's whitelist).
        value (Any): The operand, shaped by the field's type — a list of strings for
            ``in``, a single number for a numeric comparison (``eq``/``gt``/``gte``/
            ``lt``/``lte``), or a string for a text match (``eq``/``contains``).
    """

    field: str
    op: str
    value: Any


def parse_filters_param(raw: str | None) -> list[Predicate]:
    """Parse the URL-encoded ``?filters=`` JSON array into validated predicates.

    Args:
        raw (str | None): The raw query-param value — a JSON array of
            ``{field, op, value}`` objects, or ``None``/empty for no filters.

    Returns:
        list[Predicate]: The parsed, registry-validated predicates.

    Raises:
        ValueError: If the value is not a JSON array of valid predicate objects, or
            names an unknown field or a non-whitelisted operator.
    """
    if not raw:
        return []
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as e:
        raise ValueError(f"filters is not valid JSON: {e}") from e
    if not isinstance(data, list):
        raise ValueError("filters must be a JSON array of predicate objects")
    predicates: list[Predicate] = []
    for item in data:
        if not isinstance(item, dict):
            raise ValueError(f"each filter must be an object, got: {item!r}")
        try:
            pred = Predicate(**item)
        except ValidationError as e:
            raise ValueError(f"invalid filter predicate: {e}") from e
        validate_predicate(pred)  # registry field/op whitelist
        predicates.append(pred)
    return predicates


def validate_predicate(pred: Predicate) -> FilterColumn:
    """Resolve a predicate's field to a registry column and check its operator.

    Args:
        pred (Predicate): The predicate to validate.

    Returns:
        FilterColumn: The matching registry entry.

    Raises:
        ValueError: If the field is not filterable or the operator is not whitelisted
            for that field.
    """
    col = get_column(pred.field)
    if col is None:
        raise ValueError(f"unknown filter field: {pred.field!r}")
    if pred.op not in col.operators:
        raise ValueError(f"operator {pred.op!r} not allowed for field {pred.field!r}")
    _validate_value(pred, col)
    return col


def _is_number(x: object) -> bool:
    # bool is a subclass of int; a JSON boolean is not a valid numeric bound.
    return isinstance(x, (int, float)) and not isinstance(x, bool)


# Inclusive max of each numeric column type used by filterable fields. A bound larger
# than this can't bind to the parameter and would be a BAD_QUERY_PARAMETER in ClickHouse.
# Decimal64(9) is Decimal(18, 9) — 9 integer digits — so its largest value is < 10**9; the
# whole-number cap is deliberately conservative (rejects the absurd top fractional cent
# too) to guarantee no overflow rather than track the exact per-scale maximum.
_NUMERIC_TYPE_MAX = {"Int64": 2**63 - 1, "UInt64": 2**64 - 1, "Decimal64(9)": 10**9 - 1}


def _validate_value(pred: Predicate, col: FilterColumn) -> None:
    """Check the value matches the field's type, so a malformed (but typed) filter is a
    422 at the edge rather than a 500 from deep in query building. The value's shape is
    keyed off the field type; the operator whitelist (checked in ``validate_predicate``)
    already guaranteed the op is valid for the field.

    Raises:
        ValueError: If a categorical ``in`` isn't a non-empty list of strings; if a text
            value isn't a non-empty string; or if a numeric value can't bind to the
            column's ClickHouse type (see ``_validate_numeric``).
    """
    if col.type == FilterType.CATEGORICAL:
        if (
            not isinstance(pred.value, list)
            or not pred.value  # an empty IN list matches nothing — reject it
            or not all(isinstance(v, str) for v in pred.value)
        ):
            raise ValueError(f"'in' filter on {pred.field!r} requires a non-empty list of strings")
    elif col.type == FilterType.TEXT:
        # bool is not a str, so a JSON boolean is correctly rejected here.
        if not isinstance(pred.value, str) or pred.value == "":
            raise ValueError(f"{pred.op!r} filter on {pred.field!r} requires a non-empty string")
    elif col.type == FilterType.NUMERIC:
        _validate_numeric(pred.value, pred, col)


def _validate_numeric(x: object, pred: Predicate, col: FilterColumn) -> None:
    """Validate a single numeric comparison operand can bind to the column's type.

    A value that can't bind is a BAD_QUERY_PARAMETER 500 in ClickHouse, so reject it at
    the edge (422): not a number, non-finite (NaN/inf), negative (the metrics are all
    non-negative; a negative can't bind to a ``UInt64``), fractional on an integer field,
    or beyond the column type's range. Guards the float coercions — ``math.isfinite()`` /
    ``is_integer()`` OverflowError on an arbitrary-size JSON int, so only NaN/inf-check
    floats and compare ranges directly (int / Decimal alike; an oversized cost overflows
    Decimal64 too).
    """
    if not _is_number(x):
        raise ValueError(f"{pred.op!r} filter on {pred.field!r} requires a number (got {x!r})")
    if isinstance(x, float) and not math.isfinite(x):
        raise ValueError(f"{pred.op!r} filter on {pred.field!r} value must be finite")
    if x < 0:
        raise ValueError(
            f"{pred.op!r} filter on {pred.field!r} takes non-negative numbers (got {x!r})"
        )
    if col.is_integer and isinstance(x, float) and not x.is_integer():
        raise ValueError(
            f"{pred.op!r} filter on {pred.field!r} takes whole numbers only (got {x!r})"
        )
    max_val = _NUMERIC_TYPE_MAX.get(col.ch_type)
    if max_val is not None and x > max_val:
        raise ValueError(f"{pred.op!r} filter on {pred.field!r} exceeds its maximum value")


# Back off the span-scan lower bound from ``start_after`` by this much. ``start_after``
# bounds the TRACE query exactly, but a span can start slightly before its trace's stored
# ``trace_start_time`` (clock skew / trace_start_time isn't always the true earliest span —
# the same drift ``TRACE_SPAN_LOOKBACK_HOURS`` allows for in the trace-detail read). Without
# this, a matching span of an in-window trace that started just before the window boundary
# would be dropped — a silent false negative. Well under a month, so partition pruning holds.
SPAN_TIME_BOUND_LOOKBACK_HOURS = 1


def _span_time_bound(params: dict) -> str:
    """The active-window lower bound on span scans, when the list has a start date.

    Bounds ``span_start_time`` at ``start_after`` minus a small lookback so a span that
    started just before the window boundary (clock skew vs. the stored ``trace_start_time``)
    isn't dropped, which would false-negative an otherwise-matching in-window trace. Still
    prunes monthly partitions. Emitted only when the caller has bound ``start_after``.
    """
    if "start_after" in params:
        return (
            " AND span_start_time >= "
            f"{{start_after:DateTime64(3)}} - INTERVAL {SPAN_TIME_BOUND_LOOKBACK_HOURS} HOUR"
        )
    return ""


def _membership_semijoin(idx: int, col: FilterColumn, pred: Predicate, params: dict) -> str:
    """One project-scoped span semi-join for a single membership predicate.

    Independent-existence semantics: each membership predicate becomes its OWN semi-join,
    AND-combined by the caller, so a trace matches if it has >=1 span for EACH predicate
    independently (NOT one span satisfying all). Cross-attribute membership thus reads as
    "has an X span AND has an error span", not "has one span that is both". A multi-value
    predicate on a single field stays one ``IN (...)`` (OR within the field).

    Dedups ReplacingMergeTree spans to the latest ``ch_update_time`` version per span
    BEFORE applying the categorical predicate (like the aggregate/distinct paths), so a
    stale row can't match a value the latest version no longer has. Scoped to the same
    ``project_id`` as the outer query (tenant isolation) and keyed on ``t.trace_id`` so it
    filters the page and the count alike. The param name carries the predicate's index so
    two predicates on the same field don't collide.
    """
    pname = f"f_{col.name}_{idx}"
    params[pname] = pred.value
    inner = (
        f"SELECT project_id, trace_id, span_id, {col.name} "
        "FROM spans "
        "WHERE project_id = {project_id:String}" + _span_time_bound(params) + " "
        "ORDER BY ch_update_time DESC "
        "LIMIT 1 BY project_id, trace_id, span_id"
    )
    where = f"{col.name} IN {{{pname}:Array({col.ch_type})}}"
    return f"t.trace_id IN (SELECT trace_id FROM ({inner}) WHERE {where})"


# Numeric comparison operators -> their literal SQL. The operand always binds as a param.
_COMPARISON_SQL = {
    FilterOperator.EQ: "=",
    FilterOperator.GT: ">",
    FilterOperator.GTE: ">=",
    FilterOperator.LT: "<",
    FilterOperator.LTE: "<=",
}


def _trace_condition(idx: int, col: FilterColumn, pred: Predicate, params: dict) -> str:
    """One inline predicate on the traces row for a TRACE-level (text) field.

    Filters ``t.<col>`` directly — no span scan — keyed on the outer query so it lands in
    both the page and count queries. ``eq`` is an exact match; ``contains`` is a
    case-insensitive ILIKE with the search value's wildcards escaped so a literal ``%``/
    ``_`` matches literally. The value binds as a parameter, never interpolated.
    """
    pname = f"f_{col.name}_{idx}"
    if pred.op == FilterOperator.CONTAINS:
        params[pname] = f"%{escape_ilike(pred.value)}%"
        return f"t.{col.name} ILIKE {{{pname}:String}}"
    params[pname] = pred.value  # EQ — exact match
    return f"t.{col.name} = {{{pname}:String}}"


def _having_clause(idx: int, col: FilterColumn, pred: Predicate, params: dict) -> str:
    """One per-trace aggregate HAVING comparison: ``<agg> <op> {param}``.

    The operand binds as a parameter (never interpolated). Multiple predicates on the same
    field are AND-combined by the caller, so a range is two one-sided comparisons (e.g.
    ``> 5`` and ``<= 10``). Param names carry ``idx`` so duplicate predicates on the same
    field don't collide.
    """
    val = pred.value
    if col.is_integer:
        # Bind a validated whole number as int so a JSON float like 5.0 doesn't reach
        # ClickHouse as "5.0" (unparseable as Int64/UInt64).
        val = int(val)
    pname = f"f_{col.name}_{idx}"
    params[pname] = val
    return f"{col.aggregate_expr} {_COMPARISON_SQL[pred.op]} {{{pname}:{col.ch_type}}}"


def _aggregate_semijoin(frags: list[tuple[int, FilterColumn, Predicate]], params: dict) -> str:
    """Merge aggregate predicates into one time-bounded GROUP BY ... HAVING semi-join.

    Dedups ReplacingMergeTree spans (latest ``ch_update_time`` per span) within the
    active window, rolls them up per trace, and keeps traces whose aggregates satisfy
    all HAVING comparisons. Keyed on ``t.trace_id`` so it filters page and count alike.
    """
    having = [_having_clause(i, col, pred, params) for i, col, pred in frags]
    # Project the dedup/group keys, UNIONED with the source_columns of the active aggregate
    # predicates. Registry-driven, so a new aggregate field is one registry entry (its
    # source_columns) with no change here. dict.fromkeys dedups with stable order.
    # (span_start_time is filtered in the inner WHERE by _span_time_bound but needn't be
    # projected; duration_ms's source_columns add it when that field is active.)
    structural = ("trace_id", "span_id", "project_id")
    select_cols = list(structural)
    for _, col, _pred in frags:
        select_cols.extend(col.source_columns)
    inner = (
        f"SELECT {', '.join(dict.fromkeys(select_cols))} "
        "FROM spans "
        "WHERE project_id = {project_id:String}" + _span_time_bound(params) + " "
        "ORDER BY ch_update_time DESC "
        "LIMIT 1 BY project_id, trace_id, span_id"
    )
    return (
        f"t.trace_id IN (SELECT trace_id FROM ({inner}) "
        f"GROUP BY trace_id HAVING {' AND '.join(having)})"
    )


def build_conditions(filters: list[Predicate], params: dict) -> list[str]:
    """Lower filter predicates to parameterized WHERE conditions.

    Args:
        filters (list[Predicate]): The predicates to apply (AND-combined).
        params (dict): The query parameter map, mutated in place with the bound values
            the returned conditions reference.

    Returns:
        list[str]: SQL condition strings to append to the shared ``conditions`` list
        (and thus AND-ed into both the page query and the count query).

    Raises:
        ValueError: On an unknown field or a non-whitelisted operator.
    """
    membership: list[tuple[int, FilterColumn, Predicate]] = []
    aggregate: list[tuple[int, FilterColumn, Predicate]] = []
    trace: list[tuple[int, FilterColumn, Predicate]] = []
    for i, pred in enumerate(filters):
        col = validate_predicate(pred)
        if col.level == FilterLevel.SPAN_MEMBERSHIP:
            membership.append((i, col, pred))
        elif col.level == FilterLevel.SPAN_AGGREGATE:
            aggregate.append((i, col, pred))
        elif col.level == FilterLevel.TRACE:
            trace.append((i, col, pred))
        else:
            raise NotImplementedError(f"level {col.level} not yet lowered: {col.name}")

    conditions: list[str] = []
    # Inline trace-row predicates (t.*), keyed on the outer query so they land in both the
    # page and count queries.
    for i, col, pred in trace:
        conditions.append(_trace_condition(i, col, pred, params))
    # One semi-join per membership predicate (independent existence), each AND-combined via
    # the shared conditions list so every one lands in both the page and count queries.
    for i, col, pred in membership:
        conditions.append(_membership_semijoin(i, col, pred, params))
    if aggregate:
        conditions.append(_aggregate_semijoin(aggregate, params))
    return conditions
