"""Static contract tests for the public SQL gateway views migration.

These assert the *text* of migration 012 — they do not run against a live
ClickHouse (the full live security matrix lives in a separate integration suite).
They guard the curated
projection, the parameterized + DEFINER + dedup shape, and that no forbidden
column is projected.

The projection and the row scope are also compared against the public schema
contract in ``rest.services.sql.schema``, which the validator and rewriter are built
from. Those comparisons parse the view bodies with sqlglot rather than matching
strings, so reflowing the DDL cannot break them and a comment quoting a predicate
cannot satisfy them. Without them the views and the contract agree only because both
were written to the same spec, and a change to either side drifts silently.
"""

import re
from pathlib import Path

import pytest
import sqlglot
import sqlglot.expressions as exp

from rest.services.sql.schema import (
    PUBLIC_TABLES,
    TABLE_VIEW_MAP,
    VIEW_EVALUATION_EXCLUSION,
    VIEW_ROW_FILTERS,
)

MIGRATION = (
    Path(__file__).resolve().parents[2]
    / "backend/db/clickhouse/migrations/012_create_public_sql_views.sql"
)

# Every contract table paired with the view it rewrites to, for per-view parametrizing.
VIEWS = sorted(TABLE_VIEW_MAP.items())

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
    """Return the outer SELECT projection (between `AS SELECT` and the `FROM (` wrapper)."""
    block = re.search(
        rf"CREATE (?:OR REPLACE )?VIEW[^\n]*\b{view}\b.*?\bAS\s+SELECT(?P<proj>.*?)\bFROM\s*\(",
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


def _view_select(text: str, view: str) -> exp.Select:
    """The body of one view, parsed.

    Comments are dropped before parsing, since the header quotes predicates to explain
    them. Nothing in this migration puts ``--`` inside a string literal.
    """
    up = re.sub(r"--[^\n]*", "", text.split("-- +goose Down")[0])
    match = re.search(
        rf"CREATE OR REPLACE VIEW {view}\s+DEFINER\s*=\s*\w+\s+SQL SECURITY DEFINER\s+AS\b"
        r"(?P<body>.*?);",
        up,
        re.DOTALL,
    )
    assert match, f"migration 012 does not create {view}"
    tree = sqlglot.parse_one(match.group("body"), read="clickhouse")
    assert isinstance(tree, exp.Select), f"{view} body is not a single SELECT"
    return tree


def _conjuncts(select: exp.Select) -> list[exp.Expression]:
    where = select.args.get("where")
    if where is None:
        return []
    return list(where.this.flatten()) if isinstance(where.this, exp.And) else [where.this]


def _predicate(text: str) -> exp.Expression:
    return sqlglot.parse_one(f"SELECT 1 WHERE {text}", read="clickhouse").args["where"].this


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


def test_dedup_is_by_logical_id_and_runs_before_the_row_filters(sql):
    """Dedup must resolve the row by its logical id, and must precede the filters.

    FINAL alone is not enough: ReplacingMergeTree collapses only rows sharing the
    whole sort key, and `traces` is keyed on toDate(trace_start_time), so a later
    update landing on another date survives OPTIMIZE FINAL. Verified on 25.2.1,
    where FINAL returned both rows and LIMIT 1 BY trace_id returned the newest.

    Filtering before the dedup is the other half: it lets a row whose newest version
    left customer traffic stay visible through its stale `source = 'user'` version.
    """
    # A span id is unique within its trace, not across a project, so the spans view
    # must dedup on both or it drops one of two traces that reuse a span id.
    assert "LIMIT 1 BY trace_id, span_id" in sql
    assert re.search(r"LIMIT 1 BY trace_id\s*\n", sql), "traces view dedups by trace_id"
    assert sql.count("ORDER BY ch_update_time DESC") == 2
    assert "FINAL" not in sql, "FINAL cannot dedup across the sort key here"

    # The filters live OUTSIDE the dedup subquery, so the dedup sees every version.
    for view, key in (
        ("spans_public_v1", "LIMIT 1 BY trace_id, span_id"),
        ("traces_public_v1", "LIMIT 1 BY trace_id"),
    ):
        block = _view_block(sql, view)
        dedup = block.index(key)
        filt = block.index("WHERE source = 'user'")
        assert dedup < filt, f"{view} filters before it deduplicates"


def test_materialized_columns_are_selected_directly(sql):
    """`metadata_map` is MATERIALIZED, and `SELECT *` omits materialized columns.

    Selecting it through a `SELECT *` subquery makes every query against the view
    fail with UNKNOWN_IDENTIFIER, which is not visible at CREATE time because
    ClickHouse defers body validation for parameterized views.
    """
    assert "SELECT *" not in sql, "a SELECT * wrapper cannot resolve metadata_map"
    assert sql.count("metadata_map AS metadata") == 2
    # named in the inner SELECT too, or the outer reference cannot resolve
    assert sql.count("metadata_map,") == 2


def test_inner_select_provides_every_projected_column(sql):
    """Every column the outer projection names must be produced by the inner SELECT.

    This is the failure that shipped: `metadata_map` is MATERIALIZED so a `SELECT *`
    wrapper omitted it, and naming columns explicitly then dropped the git_source_*
    trio. Both created cleanly and failed on every read with UNKNOWN_IDENTIFIER,
    because ClickHouse defers body validation for parameterized views.
    """
    for view in ("spans_public_v1", "traces_public_v1"):
        block = _view_block(sql, view)
        inner = block[block.index("FROM\n(") : block.index("    FROM ")]
        provided = {c.strip() for c in inner.split("SELECT", 1)[1].replace("\n", " ").split(",")}
        for projected in _outer_projection(sql, view).replace("\n", " ").split(","):
            projected = projected.strip()
            if not projected or " AS " in projected or "(" in projected:
                continue  # computed or renamed, checked by its own test
            assert projected in provided, (
                f"{view} projects {projected!r} but the inner SELECT does not provide it"
            )


# The range a ClickHouse Date can hold. Bounds outside it wrap during primary-key analysis
# on `toDate(trace_start_time)` and prune parts that match, so both views clamp to it.
DATE_MIN = "toDateTime64('1970-01-01 00:00:00.000', 3)"
# The last millisecond of the last representable day. The next midnight is out of range too,
# and clamping to the day's start would drop that whole day.
DATE_MAX = "toDateTime64('2149-06-06 23:59:59.999', 3)"


def test_time_bounds_are_clamped_to_what_a_date_key_can_hold(sql):
    """An open bound is 1900-01-01, which is outside the Date range. On `traces`, whose
    sort key is `toDate(trace_start_time)`, ClickHouse converted it with wraparound to
    2079-06-07 and pruned every part it could date, so an unbounded query returned 11,968
    of a project's 40,000 rows. Clamping in the view protects every caller, including a
    user who writes a bound before 1970."""
    for view, column in (
        ("spans_public_v1", "span_start_time"),
        ("traces_public_v1", "trace_start_time"),
    ):
        block = _view_block(sql, view)
        assert f"greatest({{start_time:DateTime64(3)}}, {DATE_MIN})" in block, (
            f"{view} passes the lower bound to {column} unclamped"
        )
        assert (
            f"least({{end_time:DateTime64(3)}} - toIntervalMillisecond(1), {DATE_MAX})" in block
        ), f"{view} passes the upper bound to {column} unclamped"


def test_views_take_a_time_range_on_their_own_time_column(sql):
    """The caller's window has to reach the view body or it cannot prune.

    LIMIT BY blocks predicate pushdown and a parameterized view cannot see the
    caller's WHERE, so without bounds of its own the view reads the whole project
    history whatever window was asked for. The bound sits beside project_id in the
    inner scan, where the sort-key prefix can use it.
    """
    for view, column in (
        ("spans_public_v1", "span_start_time"),
        ("traces_public_v1", "trace_start_time"),
    ):
        block = _view_block(sql, view)
        assert f"{column} >= greatest({{start_time:DateTime64(3)}}, {DATE_MIN})" in block, view
        assert (
            f"{column} <= least({{end_time:DateTime64(3)}} - toIntervalMillisecond(1), {DATE_MAX})"
            in block
        ), view
        bound = block.index("start_time:DateTime64(3)")
        dedup = block.index("LIMIT 1 BY")
        assert bound < dedup, f"{view} applies the bound after deduplicating"


def test_time_range_is_half_open(sql):
    """`>= start_time` and `< end_time`, matching the exclusive `end_before` upper bound.

    The upper side is written `<= end_time - 1 ms`, which is exactly `< end_time` for a
    DateTime64(3) value. The rewrite exists for the open bound: it lets the clamp itself
    be reached, so a row at the last representable millisecond is not dropped.

    The caller has to emit the identical bound. A wider one is not safe either: a row on
    the boundary would enter the deduplication, win it as the newest version, and then be
    removed by the caller's own filter, hiding an older version that was in the window.
    """
    for column in ("span_start_time", "trace_start_time"):
        assert f"{column} >= greatest({{start_time:DateTime64(3)}}, {DATE_MIN})" in sql, column
        assert (
            f"{column} <= least({{end_time:DateTime64(3)}} - toIntervalMillisecond(1), {DATE_MAX})"
            in sql
        ), column
        assert f"{column} <= least({{end_time:DateTime64(3)}}," not in sql, (
            f"{column} uses an inclusive upper bound; the read services treat it as exclusive"
        )


def test_every_direct_view_caller_passes_the_bounds(sql):
    """A declared parameter the caller omits is a hard error, not an unbounded query.

    Adding these placeholders breaks every existing direct call with
    `Code: 456 ... Substitution 'start_time' is not set`, so the checked-in probes have
    to pass explicit open bounds.
    """
    root = MIGRATION.parents[4]
    scripts = root / "scripts"
    assert scripts.is_dir(), f"expected {scripts} to exist; this check scans nothing otherwise"
    offenders = []
    for path in scripts.rglob("*.sh"):
        for num, line in enumerate(path.read_text().splitlines(), 1):
            # Match the call shape, not the view name: one probe builds the name from a
            # shell variable, and keying on `_public_v1(` missed it entirely.
            if "(project_id=" in line.replace(" ", "") and "start_time" not in line:
                offenders.append(f"{path.name}:{num}")
    assert not offenders, (
        "these call the views without the required bounds and would fail with Code 456: "
        + ", ".join(offenders)
    )


def test_evaluation_subselects_are_never_time_bounded(sql):
    """Bounding the exclusion sub-selects puts evaluation rows in the public view.

    The exclusion tests trace membership over every version. A trace whose flagged
    span falls outside the caller's window would stop being found, so its in-window
    spans would stop being excluded. Reproduced: with the bound copied into the
    sub-selects, a span whose sibling was flagged eight months earlier is returned.
    """
    for view in ("spans_public_v1", "traces_public_v1"):
        block = _view_block(sql, view)
        exclusion = block[block.index("trace_id NOT IN (") :]
        for bound in ("start_time", "end_time"):
            assert bound not in exclusion, (
                f"{view} bounds its evaluation sub-select by {bound}, which lets an "
                "evaluation trace flagged outside the window through"
            )


def test_duration_ms_is_computed(text):
    assert "dateDiff('millisecond', span_start_time, span_end_time) AS duration_ms" in text


def test_goose_up_and_down(text):
    assert "-- +goose Up" in text
    assert "-- +goose Down" in text
    assert "DROP VIEW IF EXISTS spans_public_v1" in text
    assert "DROP VIEW IF EXISTS traces_public_v1" in text


@pytest.mark.parametrize("table,view", VIEWS)
def test_view_projects_exactly_the_contract_columns(text, table, view):
    """Exact and in contract order. A curated column added to the contract or to the
    view alone fails here, which a presence check per listed column cannot see."""
    projected = [e.alias_or_name for e in _view_select(text, view).expressions]
    assert projected == [c.name for c in PUBLIC_TABLES[table].columns]


@pytest.mark.parametrize("table,view", VIEWS)
def test_view_projection_reads_no_forbidden_column(text, table, view):
    """Checked on what the projection reads, not on its output names, so aliasing a
    forbidden column to a curated name does not get it through."""
    read = {c.name for e in _view_select(text, view).expressions for c in e.find_all(exp.Column)}
    assert not read & set(FORBIDDEN_PROJECTED), f"{view} projects {read & set(FORBIDDEN_PROJECTED)}"


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


@pytest.mark.parametrize("table,view", VIEWS)
def test_view_applies_the_contract_row_filters_to_the_deduped_row(text, table, view):
    """Each contract row filter is a conjunct of the OUTER WHERE, and never of the inner
    scan. A per-row predicate is a statement about current state, so applying it to raw
    versions lets a stale version answer for a row that no longer qualifies."""
    select = _view_select(text, view)
    inner = select.args["from"].this
    assert isinstance(inner, exp.Subquery), f"{view} no longer deduplicates in a subquery"
    for rule in VIEW_ROW_FILTERS:
        predicate = _predicate(rule)
        assert predicate in _conjuncts(select), f"{view} does not apply {rule!r}"
        assert predicate not in _conjuncts(inner.this), f"{view} applies {rule!r} before the dedup"


@pytest.mark.parametrize("table,view", VIEWS)
def test_view_applies_the_contract_evaluation_exclusion(text, table, view):
    """The exclusion is compared as a whole expression, so both halves of the union, the
    project scope inside each, and the membership shape all have to match the contract."""
    exclusion = _predicate(VIEW_EVALUATION_EXCLUSION)
    assert exclusion in _conjuncts(_view_select(text, view)), (
        f"{view} does not apply the contract's evaluation exclusion"
    )
