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
    KEYED_MAP = "KEYED_MAP"  # inline traces-row Map match OR the span semi-join, by key


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
        name (str): The predicate ``field`` key — what a filter names, and what
            ``get_column`` resolves. For every level except ``KEYED_MAP`` it is also the
            ClickHouse column read. A ``KEYED_MAP`` field is queried through the Map
            column DERIVED from it rather than the column of this name: ``metadata`` is
            filtered as ``metadata_map[key]``, the materialized one-level map of the
            ``metadata`` JSON blob (migration 009). The translator owns that derivation,
            so the physical column for a keyed-map field is not declared here.
        label (str): Human-readable label for the filter pill.
        ch_type (str): ClickHouse type, used to bind query parameters.
        level (str): One of ``FilterLevel`` — how the predicate lowers to SQL.
        type (str): One of ``FilterType`` — the UI input kind.
        operators (tuple[str, ...]): Allowed ``FilterOperator`` values (whitelist).
        value_source (str): One of ``ValueSource`` — where options come from.
        requires_key (bool): Whether a predicate on the field carries a ``key`` slot in
            addition to op/value (``{field, key, op, value}``) — e.g. which metadata key
            the value is compared against. Declared per field rather than derived from
            the level, because keyed-ness and lowering scope are independent axes: a key
            slot says the predicate names a map entry, the level says which relation the
            predicate lowers against, and a future keyed field could sit at any level.
            This is also what ``/filter-fields`` serializes — the UI needs one boolean
            ("render an extra key control"), and typing the level string on the client
            would push a backend enum into UI branching. Nothing enforces agreement
            between this and ``level`` by construction; a registry parity test pins which
            fields declare it.
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
    requires_key: bool = False
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
    # Keyed-map tier — "the trace carries <key> <op> <value>, at either scope".
    # ONE parameterized field with a key slot, never one row per key: metadata keys are the
    # user's own data, discovered per window at runtime, while this tuple is a fixed contract.
    # That works because the key reaches SQL as a bound parameter rather than an identifier,
    # so any key the user types is safe to query — an unsuggested key simply matches nothing.
    # The SDK may attach metadata at trace scope (traces.metadata_map, surfaced in the list
    # as the single default-off Metadata blob cell) or at span scope (spans.metadata_map), and
    # the two key spaces are disjoint, so the level lowers to an inline traces-row match OR the
    # span semi-join.
    # A user filtering by a tag they can see therefore need not know which scope set it;
    # matching only spans would have dropped every trace-level key. The trace-row arm rides
    # the scan the list already does, so only the span arm costs a scan. Last in the tuple
    # because this is also the field dropdown's render order, and metadata is the one field
    # that renders an extra control.
    FilterColumn(
        name="metadata",
        label="Metadata",
        ch_type="String",
        level=FilterLevel.KEYED_MAP,
        type=FilterType.TEXT,
        operators=(FilterOperator.EQ, FilterOperator.CONTAINS),
        value_source=ValueSource.FREE_TEXT,
        requires_key=True,
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
