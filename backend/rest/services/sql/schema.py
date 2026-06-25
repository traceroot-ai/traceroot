"""Single source of truth for the curated public SQL schema.

The SQL Gateway exposes two logical tables, ``spans`` and ``traces``, to users.
These are **curated analytical views** over the physical ClickHouse tables, not
the physical tables themselves. This module defines the columns and ClickHouse-
facing types each logical table exposes, plus the logical-table -> curated-view
mapping. Everything downstream (validator, rewriter, view migration, schema
endpoint, CLI ``sql schema``) derives from this contract.

This is **analytical export only**. The curated column set intentionally
excludes:

* the tenant column ``project_id``;
* the internal bookkeeping columns ``ch_create_time`` / ``ch_update_time``;
* the large blob columns ``input`` / ``output`` / ``metadata`` (raw blob export
  is a future opt-in, out of scope here).

Because ``SELECT *`` resolves against these curated views, it returns exactly the
analytical columns defined here -- never the underlying physical-table columns.

``span_start_time`` and ``trace_start_time`` are the canonical time-filter
columns. ``duration_ms`` is not a physical column; the ``spans_public_v1`` view
computes it as ``dateDiff('millisecond', span_start_time, span_end_time)``.

The module is pure data: no database/network access, no configuration
dependency, and no runtime side effects.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class PublicColumn:
    """A single curated column exposed to users.

    ``type`` is the ClickHouse-facing type as surfaced by the curated view.
    """

    name: str
    type: str


@dataclass(frozen=True)
class PublicTable:
    """A logical table in the public schema and its curated columns."""

    name: str
    columns: list[PublicColumn]


_SPANS = PublicTable(
    name="spans",
    columns=[
        PublicColumn("span_id", "String"),
        PublicColumn("trace_id", "String"),
        PublicColumn("parent_span_id", "Nullable(String)"),
        PublicColumn("span_start_time", "DateTime64(3)"),
        PublicColumn("span_end_time", "Nullable(DateTime64(3))"),
        PublicColumn("duration_ms", "Nullable(Int64)"),
        PublicColumn("name", "String"),
        PublicColumn("span_kind", "String"),
        PublicColumn("status", "String"),
        PublicColumn("status_message", "Nullable(String)"),
        PublicColumn("model_name", "Nullable(String)"),
        PublicColumn("cost", "Nullable(Decimal64(9))"),
        PublicColumn("input_tokens", "Nullable(Int64)"),
        PublicColumn("output_tokens", "Nullable(Int64)"),
        PublicColumn("total_tokens", "Nullable(Int64)"),
        PublicColumn("environment", "Nullable(String)"),
        PublicColumn("git_source_file", "Nullable(String)"),
        PublicColumn("git_source_line", "Nullable(Int32)"),
        PublicColumn("git_source_function", "Nullable(String)"),
    ],
)

_TRACES = PublicTable(
    name="traces",
    columns=[
        PublicColumn("trace_id", "String"),
        PublicColumn("trace_start_time", "DateTime64(3)"),
        PublicColumn("name", "String"),
        PublicColumn("user_id", "Nullable(String)"),
        PublicColumn("session_id", "Nullable(String)"),
        PublicColumn("git_ref", "Nullable(String)"),
        PublicColumn("git_repo", "Nullable(String)"),
        PublicColumn("environment", "Nullable(String)"),
    ],
)

#: Curated logical tables exposed by the SQL Gateway, keyed by logical name.
PUBLIC_TABLES: dict[str, PublicTable] = {_SPANS.name: _SPANS, _TRACES.name: _TRACES}

#: Logical table -> curated, project-scoped ClickHouse view it rewrites to.
TABLE_VIEW_MAP: dict[str, str] = {
    "spans": "spans_public_v1",
    "traces": "traces_public_v1",
}


def column_names(table: str) -> set[str]:
    """Return the set of curated column names for a logical ``table``.

    Raises ``KeyError`` if ``table`` is not a public logical table.
    """

    return {column.name for column in PUBLIC_TABLES[table].columns}
