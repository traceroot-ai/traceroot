"""Parity snapshot for the trace-filter field registry.

Pins the exact filterable-column set, their tiers, and per-field semantics so the
registry can't silently drift. The ``skipif`` cross-check against the SQL Gateway's
``PUBLIC_TABLES`` activates automatically once that module merges, so the vendored
snapshot stays in sync with the curated-column contract it mirrors.
"""

from dataclasses import FrozenInstanceError

import pytest

from rest.services.filters import columns as reg

MEMBERSHIP_FIELDS = {"model_name", "environment"}
AGGREGATE_FIELDS = {"cost", "total_tokens", "duration_ms", "errors"}


def test_registry_column_set_is_exactly_the_two_tiers():
    """The registry holds precisely the membership + aggregate fields — nothing else."""
    assert {c.name for c in reg.FILTER_COLUMNS} == MEMBERSHIP_FIELDS | AGGREGATE_FIELDS


def test_membership_fields_are_span_membership_categorical_in():
    """Membership fields lower to a span semi-join and take a multi-select ``in``."""
    for name in MEMBERSHIP_FIELDS:
        col = reg.get_column(name)
        assert col.level is reg.FilterLevel.SPAN_MEMBERSHIP
        assert col.type is reg.FilterType.CATEGORICAL
        assert col.operators == (reg.FilterOperator.IN,)
        assert col.aggregate_expr is None


def test_aggregate_fields_are_span_aggregate_numeric_between():
    """Aggregate fields lower to a HAVING semi-join and take a numeric ``between``."""
    for name in AGGREGATE_FIELDS:
        col = reg.get_column(name)
        assert col.level is reg.FilterLevel.SPAN_AGGREGATE
        assert col.type is reg.FilterType.NUMERIC
        assert col.operators == (reg.FilterOperator.BETWEEN,)
        assert col.value_source is reg.ValueSource.RANGE


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
    for name in MEMBERSHIP_FIELDS:
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
