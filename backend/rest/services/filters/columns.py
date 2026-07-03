"""Field registry for trace-list filtering — the single source of truth.

Every filterable column is declared once here: its ClickHouse type, which tier it
lowers to, the input type the UI renders, the operators the translator will accept,
and where its categorical options come from. The predicate translator
(``translate.py``) and the meta endpoints (``/filter-fields``, ``/filter-values``)
both read this registry, so adding a filter is one entry here.

This is a vendored snapshot of the SQL Gateway's curated-column contract
(``rest.services.sql.schema.PUBLIC_TABLES``), which is not yet on this branch. A
parity test cross-checks the two once the Gateway merges.
"""

from dataclasses import dataclass
from enum import StrEnum


class FilterLevel(StrEnum):
    """How a predicate on the field lowers into the trace-list WHERE clause."""

    TRACE = "TRACE"  # inline predicate on the traces row (t.*)
    SPAN_MEMBERSHIP = "SPAN_MEMBERSHIP"  # trace_id IN (SELECT … FROM spans WHERE …)
    SPAN_AGGREGATE = "SPAN_AGGREGATE"  # trace_id IN (SELECT … GROUP BY trace_id HAVING …)


class FilterType(StrEnum):
    """The kind of input the UI renders for the field."""

    CATEGORICAL = "categorical"  # single-select value dropdown
    NUMERIC = "numeric"  # number input
    TEXT = "text"  # free-text input (e.g. trace_id)


class FilterOperator(StrEnum):
    """Operators the translator whitelists per field (safety boundary).

    Explicit scalar operators: categorical membership (``in``, a list),
    numeric comparisons (``eq``/``gt``/``gte``/``lt``/``lte``, each a single number), and
    text match (``eq`` exact / ``contains`` case-insensitive substring). Each lowers to a
    literal SQL comparison in ``translate.py``; the value's shape is validated per field.
    """

    IN = "in"  # categorical membership — value is a list of strings
    EQ = "eq"  # =   (numeric equality, or text exact match)
    GT = "gt"  # >
    GTE = "gte"  # >=
    LT = "lt"  # <
    LTE = "lte"  # <=
    CONTAINS = "contains"  # case-insensitive substring (text)


class ValueSource(StrEnum):
    """Where the dropdown sources a categorical field's options."""

    STATIC_ENUM = "static_enum"  # a fixed shared StrEnum (no field uses this currently)
    DISTINCT_QUERY = "distinct_query"  # a distinct-values query (model_name, environment)
    RANGE = "range"  # numeric field — no enumerated options, a number input
    FREE_TEXT = "free_text"  # text field — a free-text input, no options (trace_id)


@dataclass(frozen=True)
class FilterColumn:
    """A single filterable column.

    Attributes:
        name (str): The ClickHouse column name, also the predicate ``field`` key.
        label (str): Human-readable label for the filter pill.
        ch_type (str): ClickHouse type, used to bind query parameters.
        level (str): One of ``FilterLevel`` — how the predicate lowers to SQL.
        type (str): One of ``FilterType`` — the UI input kind.
        operators (tuple[str, ...]): Allowed ``FilterOperator`` values (whitelist).
        value_source (str): One of ``ValueSource`` — where options come from.
        enum_values (tuple[str, ...]): Static options for ``STATIC_ENUM`` fields.
        aggregate_expr (str | None): For ``SPAN_AGGREGATE`` fields, the per-trace
            aggregate the HAVING clause filters on (e.g. ``sum(cost)``). ``None`` for
            non-aggregate fields.
        source_columns (tuple[str, ...]): The spans columns ``aggregate_expr``
            references. The aggregate semi-join derives its inner projection from these
            (plus the structural columns), so adding an aggregate field needs no change
            to the translator. Empty for non-aggregate fields.
    """

    name: str
    label: str
    ch_type: str
    level: str
    type: str
    operators: tuple[str, ...]
    value_source: str
    enum_values: tuple[str, ...] = ()
    aggregate_expr: str | None = None
    source_columns: tuple[str, ...] = ()

    @property
    def is_integer(self) -> bool:
        """Whether the column binds whole-number parameters (Int*/UInt*). A fractional
        bound on such a field is a BAD_QUERY_PARAMETER at ClickHouse, so the translator
        rejects it and the UI restricts the input to integers."""
        return self.ch_type.startswith(("Int", "UInt"))


# Latency is the trace's wall-clock span, not a sum: max end minus min start across
# the trace's spans — the same expression the list query's span_agg already uses.
_DURATION_EXPR = "dateDiff('millisecond', min(span_start_time), max(span_end_time))"

# The comparison operators every numeric field accepts.
_NUMERIC_OPS = (
    FilterOperator.EQ,
    FilterOperator.GT,
    FilterOperator.GTE,
    FilterOperator.LT,
    FilterOperator.LTE,
)

# A tuple, not a list/frozenset: an immutable constant whose order is the UI render
# / serialization order; keyed lookup is FILTER_COLUMNS_BY_NAME below.
FILTER_COLUMNS: tuple[FilterColumn, ...] = (
    # Trace-identifier tier — inline predicate on the traces row (t.trace_id), not a span
    # scan. Text match: exact `=` or case-insensitive `contains` (the search-by-id path).
    FilterColumn(
        name="trace_id",
        label="Trace ID",
        ch_type="String",
        level=FilterLevel.TRACE,
        type=FilterType.TEXT,
        operators=(FilterOperator.EQ, FilterOperator.CONTAINS),
        value_source=ValueSource.FREE_TEXT,
    ),
    # Membership tier — "trace has ≥1 span where …" (span semi-join).
    FilterColumn(
        name="model_name",
        label="Model",
        ch_type="String",
        level=FilterLevel.SPAN_MEMBERSHIP,
        type=FilterType.CATEGORICAL,
        operators=(FilterOperator.IN,),
        value_source=ValueSource.DISTINCT_QUERY,
    ),
    FilterColumn(
        name="environment",
        label="Environment",
        ch_type="String",
        level=FilterLevel.SPAN_MEMBERSHIP,
        type=FilterType.CATEGORICAL,
        operators=(FilterOperator.IN,),
        value_source=ValueSource.DISTINCT_QUERY,
    ),
    # Aggregate tier — time-bounded GROUP BY trace_id HAVING <agg> <op> <value>.
    FilterColumn(
        name="cost",
        label="Cost",
        ch_type="Decimal64(9)",
        level=FilterLevel.SPAN_AGGREGATE,
        type=FilterType.NUMERIC,
        operators=_NUMERIC_OPS,
        value_source=ValueSource.RANGE,
        aggregate_expr="sum(cost)",
        source_columns=("cost",),
    ),
    FilterColumn(
        name="total_tokens",
        label="Tokens",
        ch_type="Int64",
        level=FilterLevel.SPAN_AGGREGATE,
        type=FilterType.NUMERIC,
        operators=_NUMERIC_OPS,
        value_source=ValueSource.RANGE,
        aggregate_expr="sum(total_tokens)",
        source_columns=("total_tokens",),
    ),
    FilterColumn(
        name="duration_ms",
        label="Latency",
        ch_type="Int64",
        level=FilterLevel.SPAN_AGGREGATE,
        type=FilterType.NUMERIC,
        operators=_NUMERIC_OPS,
        value_source=ValueSource.RANGE,
        aggregate_expr=_DURATION_EXPR,
        source_columns=("span_start_time", "span_end_time"),
    ),
    # Per-trace error-span count, filtered like the other numeric aggregates
    # (e.g. "errors >= 3"). `errors` is derived, not a stored column —
    # the aggregate_expr counts spans whose status is ERROR.
    FilterColumn(
        name="errors",
        label="Errors",
        ch_type="UInt64",
        level=FilterLevel.SPAN_AGGREGATE,
        type=FilterType.NUMERIC,
        operators=_NUMERIC_OPS,
        value_source=ValueSource.RANGE,
        aggregate_expr="countIf(status = 'ERROR')",
        source_columns=("status",),
    ),
)

FILTER_COLUMNS_BY_NAME: dict[str, FilterColumn] = {c.name: c for c in FILTER_COLUMNS}


def get_column(name: str) -> FilterColumn | None:
    """Look up a filter column by field name.

    Args:
        name (str): The predicate ``field`` / ClickHouse column name.

    Returns:
        FilterColumn | None: The registry entry, or ``None`` if the field is not
        filterable (the translator rejects unknown fields on this signal).
    """
    return FILTER_COLUMNS_BY_NAME.get(name)
