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
* the large blob columns ``input`` / ``output`` and the raw ``metadata`` JSON
  document (raw blob export is a future opt-in, out of scope here). Metadata
  itself is not lost: the curated ``metadata`` column is the physical
  ``metadata_map`` -- the materialized one-level map of that same document --
  which is what the trace filters query and what the product calls "metadata"
  everywhere a user sees it;
* the internal classification columns ``source`` and ``is_evaluation``, which
  are platform control flags rather than user data (see the row scope below).

Because ``SELECT *`` resolves against these curated views, it returns exactly the
analytical columns defined here -- never the underlying physical-table columns.

Beyond the columns, the views also curate **rows**: on top of the per-project
scope the rewriter binds, they apply ``VIEW_ROW_FILTERS`` and
``VIEW_EVALUATION_EXCLUSION`` so a caller sees only their own customer traffic.
A row the product hides on every other read path must not reappear through the
SQL gateway.

``span_start_time`` and ``trace_start_time`` are the canonical time-filter
columns. ``duration_ms`` is not a physical column; the ``spans_public_v1`` view
computes it as ``dateDiff('millisecond', span_start_time, span_end_time)``.
``metadata`` is the physical ``metadata_map`` column surfaced under the name the
rest of the product uses; the views rename it. Keying it (``metadata['user_id']``)
is the supported access -- the raw JSON document behind it stays unexposed.

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
    columns: tuple[PublicColumn, ...]


_SPANS = PublicTable(
    name="spans",
    columns=(
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
        PublicColumn("metadata", "Map(LowCardinality(String), String)"),
        PublicColumn("git_source_file", "Nullable(String)"),
        PublicColumn("git_source_line", "Nullable(Int32)"),
        PublicColumn("git_source_function", "Nullable(String)"),
    ),
)

_TRACES = PublicTable(
    name="traces",
    columns=(
        PublicColumn("trace_id", "String"),
        PublicColumn("trace_start_time", "DateTime64(3)"),
        PublicColumn("name", "String"),
        PublicColumn("user_id", "Nullable(String)"),
        PublicColumn("session_id", "Nullable(String)"),
        PublicColumn("git_ref", "Nullable(String)"),
        PublicColumn("git_repo", "Nullable(String)"),
        PublicColumn("environment", "Nullable(String)"),
        PublicColumn("metadata", "Map(LowCardinality(String), String)"),
    ),
)

#: Curated logical tables exposed by the SQL Gateway, keyed by logical name.
PUBLIC_TABLES: dict[str, PublicTable] = {_SPANS.name: _SPANS, _TRACES.name: _TRACES}

#: Logical table -> curated, project-scoped ClickHouse view it rewrites to.
TABLE_VIEW_MAP: dict[str, str] = {
    "spans": "spans_public_v1",
    "traces": "traces_public_v1",
}

#: Per-row predicates the curated views MUST apply to the physical tables, in
#: addition to the bound project scope.
#:
#: ``source = 'user'`` names the one value that IS customer traffic instead of
#: excluding the internal markers known today, so a marker added tomorrow is
#: excluded the day it appears -- the reasoning behind
#: ``rest.services.trace_reader.customer_traffic_only``, which spells the same
#: rule for the internal read paths.
VIEW_ROW_FILTERS: tuple[str, ...] = ("source = 'user'",)

#: Offline-evaluation exclusion the curated views MUST apply. Deliberately NOT a
#: per-row ``is_evaluation = 0``, which would leak evaluation data two ways:
#:
#: * Ingest makes the flag monotonic only WITHIN a batch. A later batch carrying
#:   just the non-eval spans of an evaluation trace rewrites the trace row with
#:   ``is_evaluation = 0`` and a newer ``ch_update_time``, so a predicate read off
#:   the deduped latest row un-hides the trace -- the common case, not a race.
#: * Ordinary child spans of an evaluation trace are themselves stored as ``0``,
#:   so a span-level flag check never hid them in the first place.
#:
#: Set membership on ``trace_id`` is dedup-independent: any row anywhere flagged
#: ``1`` hides the trace permanently, whatever order the writes arrived in. The
#: sub-select repeats the project scope so it prunes the same partitions as the
#: view body and can never read another tenant's rows. This mirrors
#: ``rest.services.trace_reader._evaluation_exclusion``, which is the same rule
#: for the internal read paths; both ``spans`` and ``traces`` carry ``trace_id``,
#: so one predicate serves both views.
VIEW_EVALUATION_EXCLUSION: str = (
    "trace_id NOT IN (SELECT trace_id FROM traces "
    "WHERE project_id = {project_id:String} AND is_evaluation = 1)"
)


def column_names(table: str) -> set[str]:
    """Return the set of curated column names for a logical ``table``.

    Raises ``KeyError`` if ``table`` is not a public logical table.
    """

    return {column.name for column in PUBLIC_TABLES[table].columns}
