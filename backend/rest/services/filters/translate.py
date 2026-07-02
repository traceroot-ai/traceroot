"""Predicate -> parameterized WHERE translator for the trace list.

Turns filter predicates into SQL condition strings that the caller appends to the
shared ``conditions`` list in ``TraceReaderService.list_traces`` — the list that feeds
BOTH the page CTE and the separate count query. Every condition is keyed on
``t.trace_id`` and bound through query parameters (never string-interpolated), so a
filter narrows the page and the total identically and safely.

Structured as a per-field lowering plus a small assembler that groups predicates by
registry level. Membership predicates merge into one span semi-join; the safety boundary
is the per-field operator whitelist validated against the registry here, not downstream.
"""

import json
import math
from typing import Any

from pydantic import BaseModel, ValidationError

from rest.services.filters.columns import (
    FilterColumn,
    FilterLevel,
    FilterOperator,
    get_column,
)


class Predicate(BaseModel):
    """A single filter clause from the ``?filters=`` array.

    Attributes:
        field (str): The registry column name to filter on.
        op (str): The operator (validated against the field's whitelist).
        value (Any): The operand — a list for ``in``, a ``[min, max]`` pair for
            ``between`` (either bound may be ``None`` for an open-ended range).
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
    """Check the value matches the operator's shape, so a malformed (but typed) filter
    is a 422 at the edge rather than a 500 from deep in query building.

    Raises:
        ValueError: If ``in`` lacks a list of strings; if ``between`` lacks a two-element
            ``[min, max]`` list of numbers (either bound may be ``null``); or if a bound
            can't safely bind to the column's ClickHouse type — non-finite (NaN/inf),
            negative (the metrics are all non-negative; a negative can't bind to a
            ``UInt64``), fractional on an integer field, or beyond the column type's
            range. Each of these would otherwise be a BAD_QUERY_PARAMETER 500.
    """
    if pred.op == FilterOperator.IN:
        if (
            not isinstance(pred.value, list)
            or not pred.value  # an empty IN list matches nothing — reject it
            or not all(isinstance(v, str) for v in pred.value)
        ):
            raise ValueError(f"'in' filter on {pred.field!r} requires a non-empty list of strings")
    elif pred.op == FilterOperator.BETWEEN:
        v = pred.value
        if not isinstance(v, list) or len(v) != 2 or not all(x is None or _is_number(x) for x in v):
            raise ValueError(
                f"'between' filter on {pred.field!r} requires [min, max] numbers "
                "(either bound may be null)"
            )
        max_val = _NUMERIC_TYPE_MAX.get(col.ch_type)
        for x in v:
            if x is None:
                continue
            # A bound must bind safely to the column's type or ClickHouse 500s. Guard the
            # float coercions: math.isfinite()/is_integer() OverflowError on an
            # arbitrary-size JSON int, so only NaN/inf-check floats and compare ranges
            # directly (int/Decimal alike — an oversized cost overflows Decimal64 too).
            if isinstance(x, float) and not math.isfinite(x):
                raise ValueError(f"'between' filter on {pred.field!r} bounds must be finite")
            if x < 0:
                raise ValueError(
                    f"'between' filter on {pred.field!r} takes non-negative numbers (got {x!r})"
                )
            if col.is_integer and isinstance(x, float) and not x.is_integer():
                raise ValueError(
                    f"'between' filter on {pred.field!r} takes whole numbers only (got {x!r})"
                )
            if max_val is not None and x > max_val:
                raise ValueError(f"'between' filter on {pred.field!r} exceeds its maximum value")


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


def _membership_semijoin(frags: list[tuple[int, FilterColumn, Predicate]], params: dict) -> str:
    """Merge membership predicates into one project-scoped span semi-join.

    Matches traces with >=1 span satisfying ALL membership predicates. Dedups
    ReplacingMergeTree spans to the latest ``ch_update_time`` version per span BEFORE
    applying the categorical predicates (like the aggregate/distinct paths), so a stale
    row can't match a value the latest version no longer has. Scoped to the same
    ``project_id`` as the outer query (tenant isolation) and keyed on ``t.trace_id`` so
    it filters the page and the count alike. Param names carry the predicate's index so
    two predicates on the same field don't collide.
    """
    member_conds: list[str] = []
    select_cols = ["project_id", "trace_id", "span_id"]
    for i, col, pred in frags:
        pname = f"f_{col.name}_{i}"
        params[pname] = pred.value
        member_conds.append(f"{col.name} IN {{{pname}:Array({col.ch_type})}}")
        select_cols.append(col.name)
    # dict.fromkeys dedups columns (two predicates on the same field select it once).
    inner = (
        f"SELECT {', '.join(dict.fromkeys(select_cols))} "
        "FROM spans "
        "WHERE project_id = {project_id:String}" + _span_time_bound(params) + " "
        "ORDER BY ch_update_time DESC "
        "LIMIT 1 BY project_id, trace_id, span_id"
    )
    where = " AND ".join(member_conds)
    return f"t.trace_id IN (SELECT trace_id FROM ({inner}) WHERE {where})"


def _having_clause(idx: int, col: FilterColumn, pred: Predicate, params: dict) -> str | None:
    """One per-trace aggregate HAVING comparison, with nullable open-ended bounds.

    Bound semantics — both bounds are INCLUSIVE, matching the UI's "greater than or equal
    to" / "less than or equal to" operators so the label never misrepresents the result:
    ``[lo, None]`` -> ``>=``, ``[None, hi]`` -> ``<=``, both bounds -> inclusive ``BETWEEN``.
    Returns ``None`` when both bounds are absent (a no-op filter). Param names carry
    ``idx`` so duplicate predicates on the same field don't collide.
    """
    lo, hi = pred.value[0], pred.value[1]
    agg, ch = col.aggregate_expr, col.ch_type
    if col.is_integer:
        # Bounds are validated whole numbers; bind them as int so a JSON float like 5.0
        # doesn't reach ClickHouse as "5.0" (unparseable as Int64/UInt64).
        lo = int(lo) if lo is not None else None
        hi = int(hi) if hi is not None else None
    lo_name, hi_name = f"f_{col.name}_{idx}_min", f"f_{col.name}_{idx}_max"
    if lo is not None and hi is not None:
        params[lo_name] = lo
        params[hi_name] = hi
        return f"{agg} BETWEEN {{{lo_name}:{ch}}} AND {{{hi_name}:{ch}}}"
    if lo is not None:
        params[lo_name] = lo
        return f"{agg} >= {{{lo_name}:{ch}}}"  # "greater than or equal to"
    if hi is not None:
        params[hi_name] = hi
        return f"{agg} <= {{{hi_name}:{ch}}}"  # "less than or equal to" (inclusive)
    return None


def _aggregate_semijoin(
    frags: list[tuple[int, FilterColumn, Predicate]], params: dict
) -> str | None:
    """Merge aggregate predicates into one time-bounded GROUP BY ... HAVING semi-join.

    Dedups ReplacingMergeTree spans (latest ``ch_update_time`` per span) within the
    active window, rolls them up per trace, and keeps traces whose aggregates satisfy
    all HAVING comparisons. Keyed on ``t.trace_id`` so it filters page and count alike.
    Returns ``None`` if every predicate was an empty (no-bound) range.
    """
    having = [c for c in (_having_clause(i, col, pred, params) for i, col, pred in frags) if c]
    if not having:
        return None
    inner = (
        "SELECT trace_id, span_id, project_id, status, cost, total_tokens, "
        "span_start_time, span_end_time "
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
    for i, pred in enumerate(filters):
        col = validate_predicate(pred)
        if col.level == FilterLevel.SPAN_MEMBERSHIP:
            membership.append((i, col, pred))
        elif col.level == FilterLevel.SPAN_AGGREGATE:
            aggregate.append((i, col, pred))
        else:
            raise NotImplementedError(f"level {col.level} not yet lowered: {col.name}")

    conditions: list[str] = []
    if membership:
        conditions.append(_membership_semijoin(membership, params))
    if aggregate:
        agg = _aggregate_semijoin(aggregate, params)
        if agg:
            conditions.append(agg)
    return conditions
