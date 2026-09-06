"""Static contract tests for the public SQL gateway views migration.

These assert the *text* of migration 012 — they do not run against a live
ClickHouse (the full live security matrix lives in a separate integration suite).
They guard the curated
projection, the parameterized + DEFINER + dedup shape, and that no forbidden
column is projected.
"""

import re
from pathlib import Path

import pytest

MIGRATION = (
    Path(__file__).resolve().parents[2]
    / "backend/db/clickhouse/migrations/012_create_public_sql_views.sql"
)

# Curated public columns the views MUST project (the public schema contract).
SPANS_COLUMNS = [
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
]
TRACES_COLUMNS = [
    "trace_id",
    "trace_start_time",
    "name",
    "user_id",
    "session_id",
    "git_ref",
    "git_repo",
    "environment",
    "metadata",
]

# Columns that must NEVER appear in the curated projection. `metadata` is absent
# from this list on purpose: it IS curated, but only as the queryable one-level map
# renamed from `metadata_map`. The raw JSON blob behind the physical `metadata`
# column stays unexposed, which test_metadata_comes_from_the_map_not_the_blob checks.
FORBIDDEN_PROJECTED = [
    "project_id",
    "ch_create_time",
    "ch_update_time",
    "input",
    "output",
]


@pytest.fixture(scope="module")
def text() -> str:
    return MIGRATION.read_text(encoding="utf-8")


@pytest.fixture(scope="module")
def sql() -> str:
    """Migration text with ``--`` comment lines stripped (count assertions run on
    real SQL, not the explanatory header comment)."""
    lines = MIGRATION.read_text(encoding="utf-8").splitlines()
    return "\n".join(line for line in lines if not line.lstrip().startswith("--"))


def _outer_projection(text: str, view: str) -> str:
    """Return the outer SELECT projection (between `AS SELECT` and `FROM (`) for a view."""
    block = re.search(
        rf"CREATE (?:OR REPLACE )?VIEW[^\n]*\b{view}\b.*?\bAS\s+SELECT(?P<proj>.*?)\bFROM\s*\(",
        text,
        re.DOTALL | re.IGNORECASE,
    )
    assert block, f"could not locate the projection for view {view}"
    return block.group("proj")


def test_migration_exists(text):
    assert text.strip(), "migration 012 is empty or missing"


def test_both_views_created(text):
    assert "spans_public_v1" in text
    assert "traces_public_v1" in text


def test_views_are_parameterized_on_project_id(sql):
    """Six bindings, not two: each view scopes its own rows once, and each of the two
    evaluation sub-selects rebinds the scope because a parameterized view cannot see
    the caller's WHERE clause."""
    assert sql.count("{project_id:String}") == 6
    for view in ("spans", "traces"):
        assert re.search(rf"FROM {view}\s+WHERE project_id = \{{project_id:String\}}", sql), (
            f"{view} view must scope its own rows"
        )


def test_views_use_sql_security_definer(sql):
    assert len(re.findall(r"SQL SECURITY DEFINER", sql)) == 2


def test_views_set_explicit_scoped_writer_definer(sql):
    # both views must pin the definer to the dedicated scoped writer, not default
    # to whoever applies the migration
    assert len(re.findall(r"DEFINER = sql_gateway_writer SQL SECURITY DEFINER", sql)) == 2


def test_replacingmergetree_dedup_after_project_filter(text, sql):
    assert "LIMIT 1 BY span_id" in text
    assert "LIMIT 1 BY trace_id" in text
    # dedup must order by the version column, descending
    assert sql.count("ORDER BY ch_update_time DESC") == 2
    # the project filter precedes the dedup in both views
    for view in ("span_id", "trace_id"):
        assert re.search(
            r"WHERE project_id = \{project_id:String\}.*?ORDER BY ch_update_time DESC\s+LIMIT 1 BY "
            + view,
            text,
            re.DOTALL,
        ), f"project filter must precede dedup for {view}"


def test_duration_ms_is_computed(text):
    assert "dateDiff('millisecond', span_start_time, span_end_time) AS duration_ms" in text


def test_goose_up_and_down(text):
    assert "-- +goose Up" in text
    assert "-- +goose Down" in text
    assert "DROP VIEW IF EXISTS spans_public_v1" in text
    assert "DROP VIEW IF EXISTS traces_public_v1" in text


def test_spans_projection_is_exactly_curated(text):
    proj = _outer_projection(text, "spans_public_v1")
    for col in SPANS_COLUMNS:
        assert re.search(rf"\b{col}\b", proj), f"spans view must project {col}"
    for col in FORBIDDEN_PROJECTED:
        assert not re.search(rf"\b{col}\b", proj), f"spans view must NOT project {col}"


def test_traces_projection_is_exactly_curated(text):
    proj = _outer_projection(text, "traces_public_v1")
    for col in TRACES_COLUMNS:
        assert re.search(rf"\b{col}\b", proj), f"traces view must project {col}"
    for col in FORBIDDEN_PROJECTED:
        assert not re.search(rf"\b{col}\b", proj), f"traces view must NOT project {col}"


def test_metadata_comes_from_the_map_not_the_blob(text):
    """The curated column is the queryable map; the raw JSON document stays hidden."""
    for view in ("spans_public_v1", "traces_public_v1"):
        proj = _outer_projection(text, view)
        assert "metadata_map AS metadata" in proj, f"{view} must rename the map"
        # no bare `metadata` selection, which would be the physical JSON blob
        without_rename = proj.replace("metadata_map AS metadata", "")
        assert not re.search(r"\bmetadata\b", without_rename), (
            f"{view} projects the raw metadata blob"
        )


def test_views_return_customer_traffic_only(sql):
    """Names the value that IS customer traffic, so a marker added later is excluded
    the day it appears rather than needing this list updated."""
    assert sql.count("source = 'user'") == 2, "both views must filter to customer traffic"


def test_views_exclude_evaluation_traces_by_trace_membership(sql):
    """Not a per-row is_evaluation = 0: ingest makes the flag monotonic only within a
    batch, and child spans of an evaluation trace are stored as 0 regardless."""
    assert sql.count("trace_id NOT IN (") == 2, "both views must exclude evaluation traces"
    # both physical tables are consulted -- a trace flagged only on spans still counts
    assert (
        sql.count("FROM traces WHERE project_id = {project_id:String} AND is_evaluation = 1") == 2
    )
    assert (
        sql.count("FROM spans  WHERE project_id = {project_id:String} AND is_evaluation = 1") == 2
    )
    assert sql.count("UNION DISTINCT") == 2
    assert not re.search(r"is_evaluation\s*=\s*0", sql), (
        "per-row is_evaluation = 0 leaks evaluation data; use trace membership"
    )


def test_evaluation_subselect_repeats_the_project_scope(sql):
    """A parameterized view cannot see the caller's WHERE, so the sub-select must
    bind the project itself or it would scan every tenant's traces."""
    for block in re.findall(r"trace_id NOT IN \((.*?)\)", sql, re.DOTALL):
        assert block.count("project_id = {project_id:String}") == 2, (
            "each evaluation sub-select must be project-scoped"
        )
