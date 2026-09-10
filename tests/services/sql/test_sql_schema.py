"""Tests for the curated public SQL schema contract.

The public schema is the single source of truth for the SQL Gateway: it defines
the logical tables (``spans``, ``traces``) exposed to users, the curated
analytical columns + ClickHouse-facing types, and the logical-table -> curated-
view mapping. These tests pin the contract so downstream consumers (validator,
rewriter, view migration, schema endpoint, CLI) derive from a stable surface.
"""

import pytest

from rest.services.sql.schema import (
    PUBLIC_TABLES,
    TABLE_VIEW_MAP,
    VIEW_EVALUATION_EXCLUSION,
    VIEW_ROW_FILTERS,
    PublicColumn,
    PublicTable,
    column_names,
)

# Tenant/internal/blob columns that must never appear in any curated table.
# `source` and `is_evaluation` are platform control flags added to the physical tables
# after this contract was written; neither is user-facing data. `metadata_map` is
# absent under that name because the curated tables surface it as `metadata` -- the
# raw JSON blob of the same name is what stays out, pinned by type below.
FORBIDDEN_COLUMNS = frozenset(
    {
        "project_id",
        "ch_create_time",
        "ch_update_time",
        "input",
        "output",
        "metadata_map",
        "source",
        "is_evaluation",
    }
)

EXPECTED_SPANS_COLUMNS = {
    "span_id",
    "trace_id",
    "parent_span_id",
    "span_start_time",
    "span_end_time",
    "duration_ms",
    "name",
    "span_kind",
    "status",
    "status_message",
    "model_name",
    "cost",
    "input_tokens",
    "output_tokens",
    "total_tokens",
    "environment",
    "metadata",
    "git_source_file",
    "git_source_line",
    "git_source_function",
}

EXPECTED_TRACES_COLUMNS = {
    "trace_id",
    "trace_start_time",
    "name",
    "user_id",
    "session_id",
    "git_ref",
    "git_repo",
    "environment",
    "metadata",
}


def test_public_tables_are_exactly_spans_and_traces():
    assert set(PUBLIC_TABLES) == {"spans", "traces"}


def test_public_tables_are_public_table_instances():
    for name, table in PUBLIC_TABLES.items():
        assert isinstance(table, PublicTable)
        # the dict key matches the table's own name
        assert table.name == name
        assert table.columns, f"{name} must declare columns"
        for col in table.columns:
            assert isinstance(col, PublicColumn)
            assert col.name and col.type


def test_table_view_map_is_versioned_public_views():
    assert TABLE_VIEW_MAP == {
        "spans": "spans_public_v1",
        "traces": "traces_public_v1",
    }


def test_spans_has_key_analytical_columns():
    cols = column_names("spans")
    for expected in ("duration_ms", "model_name", "cost", "span_start_time"):
        assert expected in cols


def test_traces_has_key_columns():
    cols = column_names("traces")
    assert "trace_id" in cols
    assert "trace_start_time" in cols


def test_no_table_exposes_tenant_internal_or_blob_columns():
    for table in PUBLIC_TABLES:
        leaked = column_names(table) & FORBIDDEN_COLUMNS
        assert not leaked, f"{table} leaks forbidden columns: {sorted(leaked)}"


def test_column_names_spans_exact_set():
    # SELECT * over the public `spans` view must yield exactly the curated
    # analytical columns -- never the underlying physical-table columns.
    assert column_names("spans") == EXPECTED_SPANS_COLUMNS


def test_column_names_traces_exact_set():
    # SELECT * over the public `traces` view yields only curated columns.
    assert column_names("traces") == EXPECTED_TRACES_COLUMNS


def test_canonical_time_filter_columns_present():
    # span_start_time / trace_start_time are the canonical time-filter columns.
    assert "span_start_time" in column_names("spans")
    assert "trace_start_time" in column_names("traces")


def test_column_types_match_clickhouse_contract():
    spans_types = {c.name: c.type for c in PUBLIC_TABLES["spans"].columns}
    assert spans_types["span_id"] == "String"
    assert spans_types["parent_span_id"] == "Nullable(String)"
    assert spans_types["span_start_time"] == "DateTime64(3)"
    assert spans_types["duration_ms"] == "Nullable(Int64)"
    assert spans_types["cost"] == "Nullable(Decimal64(9))"
    assert spans_types["git_source_line"] == "Nullable(Int32)"

    traces_types = {c.name: c.type for c in PUBLIC_TABLES["traces"].columns}
    assert traces_types["trace_id"] == "String"
    assert traces_types["trace_start_time"] == "DateTime64(3)"
    assert traces_types["user_id"] == "Nullable(String)"


def test_view_row_filters_restrict_rows_to_customer_traffic():
    # The curated views curate rows as well as columns: internal self-traces are
    # hidden on every other read path and must not reappear through the gateway.
    assert VIEW_ROW_FILTERS == ("source = 'user'",)


def test_view_row_filters_key_on_columns_the_views_do_not_expose():
    # A filter column is an internal flag; exposing it as a curated column would
    # invite a user predicate that contradicts the view's own row scope.
    filtered = {predicate.split()[0] for predicate in VIEW_ROW_FILTERS}
    for table in PUBLIC_TABLES:
        assert not (column_names(table) & filtered)


def test_evaluation_exclusion_is_set_membership_not_a_per_row_flag():
    # A per-row `is_evaluation = 0` is not equivalent: the deduped latest trace row
    # can carry 0 after a later non-eval batch, and child spans of an evaluation
    # trace are stored as 0 regardless. Membership on trace_id is dedup-independent.
    assert "trace_id NOT IN" in VIEW_EVALUATION_EXCLUSION
    assert "is_evaluation = 1" in VIEW_EVALUATION_EXCLUSION
    assert "is_evaluation = 0" not in VIEW_EVALUATION_EXCLUSION


def test_evaluation_exclusion_subselects_carry_the_project_scope():
    # The sub-selects read the physical tables directly, so each must repeat the
    # view's own project parameter -- an unscoped one would read every tenant.
    assert VIEW_EVALUATION_EXCLUSION.count("project_id = {project_id:String}") == 2


def test_evaluation_exclusion_reads_both_physical_tables():
    # The spans half is not redundant: ingest drops the trace record of a batch that
    # carries no root span for an existing trace, while still inserting that batch's
    # spans -- so an eval-kind span can land with no traces row ever flagged.
    assert "FROM traces" in VIEW_EVALUATION_EXCLUSION
    assert "FROM spans" in VIEW_EVALUATION_EXCLUSION


def test_evaluation_exclusion_keys_on_a_column_both_tables_carry():
    # One predicate serves both views only because spans and traces both expose
    # trace_id in the curated set.
    for table in PUBLIC_TABLES:
        assert "trace_id" in column_names(table)


def test_metadata_is_the_queryable_map_not_the_raw_blob():
    # `metadata` is the one curated column whose physical counterpart shares its name
    # with an excluded blob, so the guard is the type: a Map can only be the
    # materialized one-level projection, never the raw JSON document.
    for table in PUBLIC_TABLES:
        metadata = next(c for c in PUBLIC_TABLES[table].columns if c.name == "metadata")
        assert metadata.type.startswith("Map("), (
            f"{table}.metadata must be the queryable map, got {metadata.type}"
        )


def test_exported_mappings_reject_mutation():
    # The frozen dataclasses only protect a table once you hold it. The mappings
    # are what every consumer reaches through, so they are read-only too.
    with pytest.raises(TypeError):
        PUBLIC_TABLES["spans"] = PUBLIC_TABLES["traces"]  # type: ignore[index]
    with pytest.raises(TypeError):
        TABLE_VIEW_MAP["spans"] = "somewhere_else"  # type: ignore[index]
