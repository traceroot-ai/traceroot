"""Predicate -> parameterized WHERE translator for the trace list.

Turns filter predicates into SQL condition strings that the caller appends to the
shared ``conditions`` list in ``TraceReaderService.list_traces`` — the list that feeds
BOTH the page CTE and the separate count query. Every condition is keyed on
``t.trace_id`` and bound through query parameters (never string-interpolated), so a
filter narrows the page and the total identically and safely.

Structured as a per-field lowering, dispatched by the predicate's registry level, plus a
small assembler; aggregate predicates are the one level that merges rather than lowering
one at a time. Each membership predicate becomes its own span semi-join (independent
existence) — a keyed one ORs an inline traces-row arm onto that semi-join, because the same
map key may have been attached at either scope. Every span-level lowering goes through the
one ``_span_semijoin`` builder, so the scan's safety properties are asserted in one place.
The safety boundary is the per-field operator whitelist validated against the registry here,
not downstream.
"""

import json
import math
from collections.abc import Callable, Sequence
from typing import Any, NoReturn

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
        key (str | None): The map key for a keyed field (``requires_key``), e.g. which
            metadata key the value is compared against. ``None`` for every other field,
            which is the vast majority — only a keyed field may carry one.
    """

    field: str
    op: str
    value: Any
    key: str | None = None


# Inclusive cap on how many predicates one request may carry. Each span-level predicate
# lowers to its own base-table scan emitted into BOTH the page query and the count query, so
# the request's scan count grows at twice the array length — the one input on this endpoint
# whose cost is unbounded by ``limit`` (itself capped at 200 in the router). The builder UI
# adds one row at a time against a registry of a handful of fields, so a request past this
# is not something the product can produce.
MAX_FILTERS = 20


def parse_filters_param(raw: str | None) -> list[Predicate]:
    """Parse the URL-encoded ``?filters=`` JSON array into validated predicates.

    Args:
        raw (str | None): The raw query-param value — a JSON array of
            ``{field, op, value}`` objects, or ``None``/empty for no filters.

    Returns:
        list[Predicate]: The parsed, registry-validated predicates.

    Raises:
        ValueError: If the value is not a JSON array of valid predicate objects,
            carries more than ``MAX_FILTERS`` of them, names an unknown field or
            a non-whitelisted operator, or is nested too deeply to parse.
    """
    if not raw:
        return []
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as e:
        raise ValueError(f"filters is not valid JSON: {e}") from e
    except RecursionError as e:
        # Past the parser's depth limit json.loads raises RecursionError
        # rather than JSONDecodeError; normalize it so callers keep their
        # 400-on-malformed-input contract instead of a 500.
        raise ValueError("filters is nested too deeply") from e
    if not isinstance(data, list):
        raise ValueError("filters must be a JSON array of predicate objects")
    # Bound the array before validating a single item, so an oversized one costs one
    # length check rather than a parse per element.
    if len(data) > MAX_FILTERS:
        raise ValueError(f"filters carries more than the maximum of {MAX_FILTERS} predicates")
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
        ValueError: If the field is not filterable, the operator is not whitelisted for
            that field, or the key/value doesn't match the field's shape.
    """
    col = get_column(pred.field)
    if col is None:
        raise ValueError(f"unknown filter field: {pred.field!r}")
    if pred.op not in col.operators:
        raise ValueError(f"operator {pred.op!r} not allowed for field {pred.field!r}")
    _validate_key(pred, col)
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
NUMERIC_TYPE_MAX = {"Int64": 2**63 - 1, "UInt64": 2**64 - 1, "Decimal64(9)": 10**9 - 1}


# Inclusive cap on a keyed field's key length. The key is free text the user may type
# rather than something the registry vouches for, and it binds as a parameter on both the
# page and the count query, so bound it at the edge instead of shipping an arbitrarily large
# one to ClickHouse. Real attribute names ("session_id", "tenant_id") are an order of
# magnitude shorter, so this only rejects input no ingestion path could have produced.
MAX_KEY_LENGTH = 256


# Inclusive cap on a text value's length, and on each element of a categorical ``in`` list —
# both are free text the caller types, and both bind as parameters on the page query and the
# count query alike. Larger than the key cap on purpose: a value is compared rather than
# looked up, so a legitimate one can be a whole prompt fragment or a URL, where a key is an
# attribute name. It is still bounded, because a ``contains`` value becomes an ILIKE pattern
# matched against every row the span scan surfaces, which makes an outsized pattern the more
# expensive of the two inputs. A kilobyte is orders of magnitude past anything a filter box
# produces, so this only rejects input no legitimate path could have sent.
MAX_VALUE_LENGTH = 1024


def _reject_long_value(pred: Predicate) -> NoReturn:
    """Raise the over-length value error, worded once for both value shapes."""
    raise ValueError(
        f"value on {pred.field!r} exceeds the maximum length of {MAX_VALUE_LENGTH} characters"
    )


def _validate_key(pred: Predicate, col: FilterColumn) -> None:
    """Check the predicate's key slot against whether the field's level takes a key.

    A keyed field cannot be lowered without a key — there is no default map key to fall
    back on — and a key on an unkeyed field means the caller has the field's shape wrong,
    so reject it rather than silently drop it and answer a different question than asked.
    The key is only ever a bound parameter, so length is the only bound worth enforcing:
    an unrecognized key is a legitimate query that matches nothing, never an error.

    Raises:
        ValueError: If a keyed field's key is missing, not a string, empty, or longer than
            ``MAX_KEY_LENGTH``; or if a key is supplied for a field that takes none.
    """
    if not col.requires_key:
        if pred.key is not None:
            raise ValueError(f"field {pred.field!r} does not take a key")
        return
    # Catches missing (None) and non-string alike — a JSON number or object is not a key.
    if not isinstance(pred.key, str) or pred.key == "":
        raise ValueError(f"filter on {pred.field!r} requires a non-empty string key")
    if len(pred.key) > MAX_KEY_LENGTH:
        raise ValueError(
            f"key on {pred.field!r} exceeds the maximum length of {MAX_KEY_LENGTH} characters"
        )


def _validate_value(pred: Predicate, col: FilterColumn) -> None:
    """Check the value matches the field's type, so a malformed (but typed) filter is a
    422 at the edge rather than a 500 from deep in query building. The value's shape is
    keyed off the field type; the operator whitelist (checked in ``validate_predicate``)
    already guaranteed the op is valid for the field.

    Raises:
        ValueError: If a categorical ``in`` isn't a non-empty list of strings; if a text
            value isn't a non-empty string; if a text value or a categorical list element is
            longer than ``MAX_VALUE_LENGTH``; or if a numeric value can't bind to the
            column's ClickHouse type (see ``_validate_numeric``).
    """
    if col.type == FilterType.CATEGORICAL:
        if (
            not isinstance(pred.value, list)
            or not pred.value  # an empty IN list matches nothing — reject it
            or not all(isinstance(v, str) for v in pred.value)
        ):
            raise ValueError(f"'in' filter on {pred.field!r} requires a non-empty list of strings")
        # Each element binds into the same Array parameter, so cap them like a text value.
        if any(len(v) > MAX_VALUE_LENGTH for v in pred.value):
            _reject_long_value(pred)
    elif col.type == FilterType.TEXT:
        # bool is not a str, so a JSON boolean is correctly rejected here.
        if not isinstance(pred.value, str) or pred.value == "":
            raise ValueError(f"{pred.op!r} filter on {pred.field!r} requires a non-empty string")
        if len(pred.value) > MAX_VALUE_LENGTH:
            _reject_long_value(pred)
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
    max_val = NUMERIC_TYPE_MAX.get(col.ch_type)
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


def _span_semijoin(value_columns: Sequence[str], tail: str, params: dict) -> str:
    """The one deduped span scan every span-level predicate filters through.

    Written once so the safety properties are a single-site question. The inner relation
    dedups ReplacingMergeTree spans to the latest ``ch_update_time`` version per span BEFORE
    ``tail`` applies (like the aggregate/distinct paths), so a stale row can't match a value
    the latest version no longer has; it is scoped to the same ``project_id`` as the outer
    query (tenant isolation); and it carries ``_span_time_bound``'s lower bound with
    deliberately NO upper bound (see that helper). The result keys on ``t.trace_id``, so it
    filters the page query and the count query alike.

    Args:
        value_columns (Sequence[str]): The spans columns ``tail`` reads, projected alongside
            the structural dedup keys. Order within the projection is not meaningful —
            ``tail`` names columns, never positions — and duplicates are dropped.
        tail (str): What the outer SELECT does with the deduped rows: a ``WHERE <predicate>``
            for an existence check, or a ``GROUP BY ... HAVING ...`` for the aggregate path.
        params (dict): The query parameter map, read (not bound here) to decide whether the
            active window contributes a lower bound. Callers bind whatever ``tail`` references.

    Returns:
        str: A ``t.trace_id IN (...)`` condition for the shared conditions list.
    """
    # dict.fromkeys dedups with stable order: a caller's value column may repeat the
    # structural keys or another predicate's column.
    projection = dict.fromkeys(("project_id", "trace_id", "span_id", *value_columns))
    inner = (
        f"SELECT {', '.join(projection)} "
        "FROM spans "
        "WHERE project_id = {project_id:String}" + _span_time_bound(params) + " "
        "ORDER BY ch_update_time DESC "
        "LIMIT 1 BY project_id, trace_id, span_id"
    )
    return f"t.trace_id IN (SELECT trace_id FROM ({inner}) {tail})"


def _membership_semijoin(idx: int, col: FilterColumn, pred: Predicate, params: dict) -> str:
    """One span semi-join for a single membership predicate.

    Independent-existence semantics: each membership predicate becomes its OWN semi-join,
    AND-combined by the caller, so a trace matches if it has >=1 span for EACH predicate
    independently (NOT one span satisfying all). Cross-attribute membership thus reads as
    "has an X span AND has an error span", not "has one span that is both". A multi-value
    predicate on a single field stays one ``IN (...)`` (OR within the field).

    The param name carries the predicate's index so two predicates on the same field don't
    collide. Scan safety (dedup before predicate, project scoping, time bound) is
    ``_span_semijoin``'s.
    """
    pname = f"f_{col.name}_{idx}"
    params[pname] = pred.value
    where = f"WHERE {col.name} IN {{{pname}:Array({col.ch_type})}}"
    return _span_semijoin((col.name,), where, params)


# The Map column a keyed predicate reads. Both `traces` and `spans` carry a column of this
# name, which is what lets one predicate ask the same question of either row. Named separately
# from the registry field ("metadata"), which still refers to the original JSON blob column the
# map is derived from — the blob is what the detail panel renders, the map is what is filterable.
_METADATA_MAP_COLUMN = "metadata_map"


def keyed_map_match(map_ref: str, key_ref: str, value_ref: str, op: str) -> str:
    """The key/value comparison against one ``metadata_map`` column.

    Written once and applied to both the traces row and the spans row so the two halves of a
    metadata predicate cannot drift apart in operator handling. Public because the widget
    query engine lowers its keyed filter through it too, so both surfaces answer the same
    filter identically.

    ``mapContains`` is not redundant with the comparison: ClickHouse's map subscript returns
    the value type's default for an absent key, so without the guard a predicate looking for
    the empty string would match every row that lacks the key entirely.

    Args:
        map_ref (str): The map column to read, qualified if the query needs it (``t.<col>``).
        key_ref (str): The bound-parameter reference holding the map key.
        value_ref (str): The bound-parameter reference holding the compared value. For
            ``contains`` it is already wrapped in ``%`` wildcards by the caller.
        op (str): The predicate's ``FilterOperator`` — ``contains`` lowers to ``ILIKE``,
            anything else (only ``eq`` is whitelisted for this field) to ``=``.

    Returns:
        str: The guarded comparison, for use as a WHERE fragment.
    """
    comparison = "ILIKE" if op == FilterOperator.CONTAINS else "="
    return f"mapContains({map_ref}, {key_ref}) AND {map_ref}[{key_ref}] {comparison} {value_ref}"


def _keyed_metadata_condition(idx: int, col: FilterColumn, pred: Predicate, params: dict) -> str:
    """One condition matching a keyed metadata pair at EITHER trace or span scope.

    The SDK may attach a tag at either scope and the two key spaces are disjoint, so a trace
    matches when the pair is on its ``traces`` row OR on at least one of its spans. The trace
    half is inline on the already-scanned ``t`` row; only the span half is a semi-join. Both
    the key and the value bind as parameters, which is what makes an arbitrary user-typed key
    safe without registry membership.

    Args:
        idx (int): The predicate's position in the request's filter array, used to keep this
            predicate's parameter names distinct from another predicate's on the same field.
        col (FilterColumn): The registry entry for the keyed field.
        pred (Predicate): The predicate being lowered (its ``key`` is already validated
            non-empty by ``validate_predicate``).
        params (dict): The query parameter map, mutated in place with the bound key and value.

    Returns:
        str: A single parenthesised condition for the shared conditions list.
    """
    kname = f"f_{col.name}_{idx}_key"
    vname = f"f_{col.name}_{idx}"
    params[kname] = pred.key
    key_ref = f"{{{kname}:String}}"
    value_ref = f"{{{vname}:{col.ch_type}}}"
    if pred.op == FilterOperator.CONTAINS:
        # Case-insensitive substring with the search value's wildcards escaped, so a literal
        # `%`/`_` in the value matches literally — the same treatment trace_id's contains gets.
        params[vname] = f"%{escape_ilike(pred.value)}%"
    else:
        params[vname] = pred.value  # EQ — exact match
    trace_half = keyed_map_match(f"t.{_METADATA_MAP_COLUMN}", key_ref, value_ref, pred.op)
    span_where = f"WHERE {keyed_map_match(_METADATA_MAP_COLUMN, key_ref, value_ref, pred.op)}"
    span_half = _span_semijoin((_METADATA_MAP_COLUMN,), span_where, params)
    # Parenthesise the OR as one unit before it joins the shared conditions list. That list is
    # AND-joined, and OR binds looser than AND: unparenthesised, this predicate's span half
    # would absorb every condition to its left into the left arm of the OR and every condition
    # to its right into the right arm, so any row matching the span half alone would satisfy the
    # whole WHERE clause — silently widening the date range and every other active filter. The
    # inner parentheses around the trace half are for the reader; AND already binds tighter.
    return f"(({trace_half}) OR {span_half})"


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
    """Merge aggregate predicates into ONE GROUP BY ... HAVING semi-join.

    Rolls the deduped spans up per trace and keeps traces whose aggregates satisfy all
    HAVING comparisons at once. The value columns are the ``source_columns`` of the active
    predicates, so a new aggregate field is one registry entry with no change here.
    """
    having = [_having_clause(i, col, pred, params) for i, col, pred in frags]
    value_columns = [c for _, col, _pred in frags for c in col.source_columns]
    tail = f"GROUP BY trace_id HAVING {' AND '.join(having)}"
    return _span_semijoin(value_columns, tail, params)


# How each filter level lowers: one predicate in, one condition out. SPAN_AGGREGATE is
# deliberately absent — it is the only level whose predicates do NOT lower independently,
# since they all merge into a single GROUP BY ... HAVING semi-join, so ``build_conditions``
# collects those and calls ``_aggregate_semijoin`` once. A level missing from this table is
# a level with no lowering at all, which is the NotImplementedError case.
_LEVEL_LOWERING: dict[FilterLevel, Callable[[int, FilterColumn, Predicate, dict], str]] = {
    # Inline trace-row predicates (t.*), keyed on the outer query so they land in both the
    # page and count queries.
    FilterLevel.TRACE: _trace_condition,
    # One semi-join per membership predicate (independent existence), each AND-combined via
    # the shared conditions list so every one lands in both the page and count queries.
    FilterLevel.SPAN_MEMBERSHIP: _membership_semijoin,
    # The same independent existence, widened by an inline trace-row arm because a keyed
    # predicate's key may have been attached at either scope.
    FilterLevel.KEYED_MAP: _keyed_metadata_condition,
    # SPAN_AGGREGATE is deliberately absent: its predicates merge into ONE semi-join rather
    # than lowering one at a time, so build_conditions handles it separately.
}


def build_conditions(filters: list[Predicate], params: dict) -> list[str]:
    """Lower filter predicates to parameterized WHERE conditions.

    Each predicate is validated against the registry and then lowered by its level's entry
    in ``_LEVEL_LOWERING``, in the order the caller sent them. Aggregate predicates are the
    one exception: they are collected and merged into a single semi-join appended last.
    Position in the returned list carries no meaning — the caller AND-joins the whole list
    into one WHERE clause.

    Args:
        filters (list[Predicate]): The predicates to apply (AND-combined).
        params (dict): The query parameter map, mutated in place with the bound values
            the returned conditions reference.

    Returns:
        list[str]: SQL condition strings to append to the shared ``conditions`` list
        (and thus AND-ed into both the page query and the count query).

    Raises:
        ValueError: On an unknown field, a non-whitelisted operator, or a key/value that
            doesn't match the field's shape.
        NotImplementedError: If a registry column's level has no lowering yet.
    """
    conditions: list[str] = []
    aggregate: list[tuple[int, FilterColumn, Predicate]] = []
    for i, pred in enumerate(filters):
        col = validate_predicate(pred)
        if col.level == FilterLevel.SPAN_AGGREGATE:
            aggregate.append((i, col, pred))
            continue
        lower = _LEVEL_LOWERING.get(col.level)
        if lower is None:
            raise NotImplementedError(f"level {col.level} not yet lowered: {col.name}")
        conditions.append(lower(i, col, pred, params))
    if aggregate:
        conditions.append(_aggregate_semijoin(aggregate, params))
    return conditions
