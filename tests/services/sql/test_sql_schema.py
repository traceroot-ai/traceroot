"""Tests for the curated public SQL schema contract.

The public schema is the single source of truth for the SQL Gateway: it defines
the logical tables (``spans``, ``traces``) exposed to users, the curated
analytical columns + ClickHouse-facing types, and the logical-table -> curated-
view mapping. These tests pin the contract so downstream consumers (validator,
rewriter, view migration, schema endpoint, CLI) derive from a stable surface.
"""

from rest.services.sql.schema import (
    PUBLIC_TABLES,
    TABLE_VIEW_MAP,
    PublicColumn,
    PublicTable,
    column_names,
)

# Tenant/internal/blob columns that must never appear in any curated table.
FORBIDDEN_COLUMNS = frozenset(
    {"project_id", "ch_create_time", "ch_update_time", "input", "output", "metadata"}
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
