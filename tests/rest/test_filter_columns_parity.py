"""Parity snapshot for the trace-filter field registry.

Pins the exact filterable-column set, their tiers, and per-field semantics so the
registry can't silently drift. The ``skipif`` cross-check against the SQL Gateway's
``PUBLIC_TABLES`` activates automatically once that module merges, so the vendored
snapshot stays in sync with the curated-column contract it mirrors.
"""

import dataclasses
from dataclasses import FrozenInstanceError

import pytest

from rest.services.filters import columns as reg

MEMBERSHIP_FIELDS = {"model_name", "environment"}
# Keyed map: its own tier, because the predicate carries a map key as well as a value and
# lowers to a shape no membership field lowers to. One parameterized field over a Map
# column, never one registry row per key.
KEYED_MAP_FIELDS = {"metadata"}
AGGREGATE_FIELDS = {"cost", "total_tokens", "duration_ms", "errors"}
TRACE_FIELDS = {"trace_id"}


def test_registry_column_set_is_exactly_the_declared_tiers():
    """The registry holds precisely the membership + aggregate + trace fields."""
    assert {c.name for c in reg.FILTER_COLUMNS} == (
        MEMBERSHIP_FIELDS | KEYED_MAP_FIELDS | AGGREGATE_FIELDS | TRACE_FIELDS
    )


def test_membership_fields_are_span_membership_categorical_in():
    """Membership fields lower to a span semi-join and take a multi-select ``in``."""
    for name in MEMBERSHIP_FIELDS:
        col = reg.get_column(name)
        assert col.level is reg.FilterLevel.SPAN_MEMBERSHIP
        assert col.type is reg.FilterType.CATEGORICAL
        assert col.operators == (reg.FilterOperator.IN,)
        assert col.aggregate_expr is None


def test_aggregate_fields_are_span_aggregate_numeric_comparisons():
    """Aggregate fields lower to a HAVING semi-join and take the numeric comparison ops."""
    for name in AGGREGATE_FIELDS:
        col = reg.get_column(name)
        assert col.level is reg.FilterLevel.SPAN_AGGREGATE
        assert col.type is reg.FilterType.NUMERIC
        assert col.operators == (
            reg.FilterOperator.EQ,
            reg.FilterOperator.GT,
            reg.FilterOperator.GTE,
            reg.FilterOperator.LT,
            reg.FilterOperator.LTE,
        )
        assert col.value_source is reg.ValueSource.RANGE


def test_trace_id_is_a_text_trace_level_field():
    """trace_id filters the traces row inline (TRACE level) and takes text = / contains."""
    col = reg.get_column("trace_id")
    assert col.level is reg.FilterLevel.TRACE
    assert col.type is reg.FilterType.TEXT
    assert col.operators == (reg.FilterOperator.EQ, reg.FilterOperator.CONTAINS)
    assert col.ch_type == "String"
    assert col.aggregate_expr is None
    assert col.source_columns == ()


def test_metadata_is_a_keyed_map_text_field_on_its_own_level():
    """Metadata declares the keyed-map level rather than borrowing the membership one:
    it lowers to an inline traces-row map match ORed onto a span semi-join, which no
    membership field lowers to. It takes a key alongside its value and matches text with
    the string operators only."""
    col = reg.get_column("metadata")
    assert col.level is reg.FilterLevel.KEYED_MAP
    assert col.level is not reg.FilterLevel.SPAN_MEMBERSHIP
    assert col.type is reg.FilterType.TEXT
    assert col.operators == (reg.FilterOperator.EQ, reg.FilterOperator.CONTAINS)
    assert col.requires_key is True
    assert col.ch_type == "String"
    assert col.aggregate_expr is None
    assert col.source_columns == ()


def test_requires_key_is_declared_per_field_and_agrees_with_the_level():
    """``requires_key`` is a declared field, not a property derived from ``level``, because
    keyed-ness and lowering scope are independent axes: a key slot says the predicate names
    a map entry, the level says which relation the predicate lowers against, and a keyed
    field could sit at any level. Deriving one from the other collapses the two into a
    flattened matrix the moment a second keyed field appears at a different scope, while
    the wire contract was already two-axis.

    Their agreement therefore used to hold by construction and is now a checked invariant,
    which is what this test is: a registry entry could otherwise claim a key the
    translator's lowering never reads (or the reverse) and the two would disagree silently.
    Adding a keyed field at a new scope fails here, which is the signal to keep the two
    axes in step deliberately rather than by accident."""
    declared = {f.name: f for f in dataclasses.fields(reg.FilterColumn)}
    assert "requires_key" in declared
    # Unkeyed is the default, so every entry but the keyed one omits the kwarg entirely.
    assert declared["requires_key"].default is False
    for col in reg.FILTER_COLUMNS:
        assert col.requires_key is (col.level is reg.FilterLevel.KEYED_MAP)
    # Every other field's predicate is {field, op, value}, so the UI renders the extra key
    # control for exactly one field.
    assert {c.name for c in reg.FILTER_COLUMNS if c.requires_key} == KEYED_MAP_FIELDS


def test_metadata_options_are_suggestions_not_an_enumerated_value_set():
    """The value is free text — a metadata value is never enumerated into a dropdown, so
    an unsuggested value stays typable. (Key discovery has its own endpoint.)"""
    col = reg.get_column("metadata")
    assert col.value_source is reg.ValueSource.FREE_TEXT
    assert col.enum_values == ()


def test_errors_is_a_numeric_count_of_error_spans():
    """`errors` is a derived per-trace count, filtered like the other numeric aggregates."""
    col = reg.get_column("errors")
    assert col.level is reg.FilterLevel.SPAN_AGGREGATE
    assert col.type is reg.FilterType.NUMERIC
    assert col.aggregate_expr == "countIf(status = 'ERROR')"


def test_open_ended_categoricals_use_a_distinct_query_with_no_static_values():
    """model_name/environment are unbounded — options come from a distinct-values query."""
    for name in ("model_name", "environment"):
        col = reg.get_column(name)
        assert col.value_source is reg.ValueSource.DISTINCT_QUERY
        assert col.enum_values == ()


def test_duration_aggregates_via_min_max_while_cost_and_tokens_sum():
    """duration is max(end)-min(start), NOT a sum — the lowering must differ."""
    assert reg.get_column("cost").aggregate_expr == "sum(cost)"
    assert reg.get_column("total_tokens").aggregate_expr == "sum(total_tokens)"
    dur = reg.get_column("duration_ms").aggregate_expr
    assert "min(span_start_time)" in dur and "max(span_end_time)" in dur
    assert "sum(" not in dur


def test_aggregate_source_columns_name_the_referenced_spans_columns():
    """Each aggregate field declares the spans columns its aggregate_expr references, so
    the semi-join's inner projection is registry-driven. Membership fields declare none."""
    assert reg.get_column("cost").source_columns == ("cost",)
    assert reg.get_column("total_tokens").source_columns == ("total_tokens",)
    assert reg.get_column("duration_ms").source_columns == ("span_start_time", "span_end_time")
    assert reg.get_column("errors").source_columns == ("status",)
    for name in MEMBERSHIP_FIELDS | KEYED_MAP_FIELDS | TRACE_FIELDS:
        assert reg.get_column(name).source_columns == ()


def test_get_column_returns_none_for_unknown_field():
    assert reg.get_column("not_a_field") is None


def test_filter_columns_are_immutable():
    """Frozen entries — the registry is a constant, not mutable state."""
    with pytest.raises(FrozenInstanceError):
        reg.FILTER_COLUMNS[0].name = "mutated"


# Derived fields with no stored-column equivalent (computed aggregates) are exempt
# from the curated-column cross-check — they reference real columns via aggregate_expr.
_DERIVED_FIELDS = {"errors"}

# --- Cross-check against the SQL Gateway curated columns (lights up on merge) ---

try:
    from rest.services.sql import schema as gateway_schema

    _HAS_GATEWAY = hasattr(gateway_schema, "PUBLIC_TABLES")
except ImportError:
    gateway_schema = None
    _HAS_GATEWAY = False


@pytest.mark.skipif(
    not _HAS_GATEWAY,
    reason="SQL Gateway PUBLIC_TABLES not merged on this branch; vendored snapshot in use",
)
def test_registry_columns_exist_in_gateway_public_tables():
    """Every filter column must be a real curated column once the Gateway merges."""
    tables = gateway_schema.PUBLIC_TABLES
    iterable = tables.values() if isinstance(tables, dict) else tables
    gateway_cols = {getattr(c, "name", c) for tbl in iterable for c in getattr(tbl, "columns", [])}
    missing = {c.name for c in reg.FILTER_COLUMNS} - gateway_cols - _DERIVED_FIELDS
    assert not missing, f"registry columns absent from Gateway curated schema: {missing}"
