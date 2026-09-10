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
    """Return the outer SELECT projection (between `AS SELECT` and `FROM <table> FINAL`)."""
    block = re.search(
        rf"CREATE (?:OR REPLACE )?VIEW[^\n]*\b{view}\b.*?\bAS\s+SELECT(?P<proj>.*?)\bFROM\s+\w+\s+FINAL\b",
        text,
        re.DOTALL | re.IGNORECASE,
    )
    assert block, f"could not locate the projection for view {view}"
    return block.group("proj")


def _view_block(text: str, view: str) -> str:
    """The whole CREATE ... statement for one view, so assertions are per-view.
    File-wide counts cannot tell "both views have it" from "one view has it twice"."""
    start = text.index(f"CREATE OR REPLACE VIEW {view}")
    end = text.find("CREATE OR REPLACE VIEW", start + 1)
    return text[start:] if end == -1 else text[start:end]


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


def test_replacingmergetree_dedup_resolves_before_row_filters(sql):
    """Dedup must be FINAL on the outer read, never a LIMIT BY wrapper.

    A LIMIT BY wrapper applies `source = 'user'` before the dedup, so a row whose
    newest version is no longer customer traffic stays visible through its older
    version. It also blocks predicate pushdown, so the caller's time range cannot
    prune. Both were reproduced against the production schema.
    """
    assert "FROM spans FINAL" in sql
    assert "FROM traces FINAL" in sql
    assert "LIMIT 1 BY" not in sql, "LIMIT BY dedup filters before it resolves the row"

    # The evaluation sub-selects must NOT be FINAL: they have to see any version that
    # was ever flagged, not only the latest one.
    assert sql.count("FINAL") == 2, "FINAL belongs on the outer read only"


def test_materialized_columns_are_selected_directly(sql):
    """`metadata_map` is MATERIALIZED, and `SELECT *` omits materialized columns.

    Selecting it through a `SELECT *` subquery makes every query against the view
    fail with UNKNOWN_IDENTIFIER, which is not visible at CREATE time because
    ClickHouse defers body validation for parameterized views.
    """
    assert "SELECT *" not in sql, "a SELECT * wrapper cannot resolve metadata_map"
    assert sql.count("metadata_map AS metadata") == 2


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


def test_views_return_customer_traffic_only(text):
    """Names the value that IS customer traffic, so a marker added later is excluded
    the day it appears rather than needing this list updated. Asserted per view: a
    file-wide count passes when one view has both filters and the other has none."""
    for view in ("spans_public_v1", "traces_public_v1"):
        assert "source = 'user'" in _view_block(text, view), (
            f"{view} must filter to customer traffic"
        )


def test_views_exclude_evaluation_traces_by_trace_membership(text):
    """Not a per-row is_evaluation = 0: ingest makes the flag monotonic only within a
    batch, and child spans of an evaluation trace are stored as 0 regardless."""
    for view in ("spans_public_v1", "traces_public_v1"):
        block = _view_block(text, view)
        assert "trace_id NOT IN (" in block, f"{view} must exclude evaluation traces"
        # both physical tables are consulted -- a trace flagged only on spans still counts
        for table in ("traces", "spans"):
            assert re.search(
                rf"FROM {table}\s+WHERE project_id = \{{project_id:String\}} AND is_evaluation = 1",
                block,
            ), f"{view} must consult {table} for the evaluation set"
        assert "UNION DISTINCT" in block, f"{view} must union both evaluation sources"
        # scoped to the view bodies: the header comment names this form to explain
        # why it is NOT used, and matching that would be a false failure
        assert not re.search(r"is_evaluation\s*=\s*0", block), (
            f"{view} uses a per-row is_evaluation = 0, which leaks; use trace membership"
        )


def test_evaluation_subselect_repeats_the_project_scope(text):
    """A parameterized view cannot see the caller's WHERE, so the sub-select must
    bind the project itself or it would scan every tenant's traces."""
    for view in ("spans_public_v1", "traces_public_v1"):
        block = _view_block(text, view)
        excl = re.search(r"trace_id NOT IN \((.*?)\n\s*\)", block, re.DOTALL)
        assert excl, f"could not locate the evaluation exclusion in {view}"
        assert excl.group(1).count("project_id = {project_id:String}") == 2, (
            f"each evaluation sub-select in {view} must be project-scoped"
        )
