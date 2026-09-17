"""Live security and correctness tests for the SQL gateway, at the database.

Unit tests prove the validator and rewriter in isolation. These prove that what the
rewriter renders is accepted by a real ClickHouse, and that the guarantees hold where
they have to hold: every gateway query below runs as the read-only account, against
migrations 001 to 012 applied as written and accounts provisioned from the repository's
own bootstrap SQL. See ``conftest.py`` for the environment the suite needs; without it
every test here skips.

Out of scope until the service and endpoint exist: reserved request parameters, the
``max_rows + 1`` truncation boundary, and error sanitisation at the service and HTTP
layers.
"""

from __future__ import annotations

import re
from collections.abc import Callable

import pytest
from clickhouse_connect.driver.exceptions import DatabaseError

from rest.services.sql import rewriter
from rest.services.sql.errors import SqlValidationError
from rest.services.sql.schema import PUBLIC_TABLES, TABLE_VIEW_MAP

from .conftest import (
    DATABASE,
    EVAL_PARTITION,
    PROFILE_MAX_RESULT_ROWS,
    PROJECT_A,
    PROJECT_B,
    PROJECT_CAP,
    PROJECT_SEM,
    PROJECTS_WIDE,
    WIDE_TRACES_PER_PROJECT,
    Gateway,
    Seeded,
)

pytestmark = pytest.mark.integration

OPEN_BOUNDS = (
    "start_time = toDateTime64('1900-01-01 00:00:00.000', 3), "
    "end_time = toDateTime64('2299-12-31 23:59:59.999', 3)"
)


def _render(sql: str, project: str, *, open_bounds: bool = False) -> tuple[str, dict]:
    """Render as the gateway would. ``open_bounds`` renders the same query without the
    time window, which is the reference a bounded query must agree with."""
    if not open_bounds:
        return rewriter.scope_and_render(sql, project)
    with pytest.MonkeyPatch.context() as mp:
        mp.setattr(rewriter, "_bounds_by_table", lambda tree: {})
        return rewriter.scope_and_render(sql, project)


def _rows(gw: Gateway, sql: str, project: str, *, open_bounds: bool = False) -> list[tuple]:
    rendered, binds = _render(sql, project, open_bounds=open_bounds)
    return gw.ro.query(rendered, parameters=binds or None).result_rows


def _values(rows: list[tuple]) -> set:
    return {row[0] for row in rows}


def _code(exc: BaseException) -> int | None:
    match = re.search(r"Code: (\d+)", str(exc))
    return int(match.group(1)) if match else None


@pytest.fixture(params=["bound", "literal"])
def scoping_mode(request, monkeypatch):
    """Both ways the rewriter can scope a query: a server-side bound parameter, or a
    validated literal. Which one ships is the question this suite answers."""
    monkeypatch.setattr(rewriter, "USE_BOUND_PARAM", request.param == "bound")
    return request.param


# ---------------------------------------------------------------------------
# 1. The rendered SQL is accepted by ClickHouse
# ---------------------------------------------------------------------------


def test_the_server_recorded_the_definer_the_migration_names(gateway):
    """What the migration declares and what the server stored are different facts.

    The isolation rests on the view body running under the writer's grants. A view
    created without the clause, or with another account, reads under the caller's
    own privileges instead, and every other check here still passes: the read-only
    user is still refused the physical tables, and the views still return rows.

    Asserted against the live server rather than the migration text, which a
    separate unit test already covers, and in CI rather than only in the chart's
    verification hook, which is off by default.
    """
    for view in ("spans_public_v1", "traces_public_v1"):
        ddl = gateway.admin.query(f"SHOW CREATE VIEW {view}").result_rows[0][0]
        header = ddl.split("\\nAS ", 1)[0]
        assert "DEFINER = sql_gateway_writer SQL SECURITY DEFINER" in header, (
            f"{view} was created as {header!r}, which does not name the writer as its definer"
        )


def test_rendered_sql_executes_in_both_scoping_modes(gateway, scoping_mode):
    rendered, binds = rewriter.scope_and_render("SELECT count() FROM spans", PROJECT_A)
    if scoping_mode == "bound":
        assert binds == {"scope_project_id": PROJECT_A}
        assert PROJECT_A not in rendered, "bound mode must keep the project out of the SQL"
    else:
        assert binds == {}
        assert f"'{PROJECT_A}'" in rendered
    rows = gateway.ro.query(rendered, parameters=binds or None).result_rows
    assert rows == [(len(gateway.seeded.spans[PROJECT_A]),)]


# ---------------------------------------------------------------------------
# 2. Cross-project isolation, in every structural position
# ---------------------------------------------------------------------------


def _non_root(seeded: Seeded, project: str) -> set[str]:
    return {s for s in seeded.spans[project] if not s.endswith("-s0")}


ISOLATION: list[tuple[str, str, Callable[[Seeded, str], set]]] = [
    ("flat", "SELECT span_id FROM spans", lambda s, p: s.spans[p]),
    (
        "filtered",
        "SELECT span_id FROM spans WHERE span_kind = 'LLM'",
        lambda s, p: {x for x in s.spans[p] if x.endswith("-s1")},
    ),
    (
        "derived table",
        "SELECT span_id FROM (SELECT span_id FROM spans) AS d",
        lambda s, p: s.spans[p],
    ),
    (
        "IN subquery",
        "SELECT trace_id FROM traces WHERE trace_id IN (SELECT trace_id FROM spans)",
        lambda s, p: s.traces[p],
    ),
    (
        "EXISTS",
        "SELECT trace_id FROM traces WHERE EXISTS (SELECT 1 FROM spans WHERE span_kind = 'LLM')",
        lambda s, p: s.traces[p],
    ),
    ("CTE", "WITH x AS (SELECT span_id FROM spans) SELECT span_id FROM x", lambda s, p: s.spans[p]),
    (
        "UNION ALL",
        "SELECT trace_id AS id FROM traces UNION ALL SELECT span_id AS id FROM spans",
        lambda s, p: s.traces[p] | s.spans[p],
    ),
    (
        "UNION DISTINCT",
        "SELECT trace_id AS id FROM traces UNION DISTINCT SELECT trace_id AS id FROM spans",
        lambda s, p: s.traces[p],
    ),
    (
        "JOIN",
        "SELECT s.span_id FROM spans AS s INNER JOIN traces AS t ON s.trace_id = t.trace_id",
        lambda s, p: s.spans[p],
    ),
    (
        "LEFT JOIN",
        "SELECT t.trace_id FROM traces AS t LEFT JOIN spans AS s ON s.trace_id = t.trace_id",
        lambda s, p: s.traces[p],
    ),
    (
        "self join",
        "SELECT c.span_id FROM spans AS c INNER JOIN spans AS p ON c.parent_span_id = p.span_id",
        _non_root,
    ),
    (
        "nested window",
        "SELECT span_id FROM spans WHERE span_start_time >= '2026-09-01' "
        "AND trace_id IN (SELECT trace_id FROM traces WHERE trace_start_time >= '1999-01-01')",
        lambda s, p: s.spans[p],
    ),
    ("scalar subquery", "SELECT (SELECT count() FROM spans) AS n", lambda s, p: {len(s.spans[p])}),
    ("aggregate", "SELECT uniqExact(trace_id) FROM spans", lambda s, p: {len(s.traces[p])}),
    (
        "cross join",
        "SELECT count() FROM spans CROSS JOIN traces",
        lambda s, p: {len(s.spans[p]) * len(s.traces[p])},
    ),
]


@pytest.mark.parametrize("project", [PROJECT_A, PROJECT_B])
@pytest.mark.parametrize("label,sql,expected", ISOLATION, ids=[case[0] for case in ISOLATION])
def test_a_project_sees_exactly_its_own_rows(gateway, scoping_mode, project, label, sql, expected):
    """Exact set equality, not "no foreign id": the two tenants differ in size, so a query
    that leaked, or one that dropped rows, fails either way."""
    got = _values(_rows(gateway, sql, project))
    assert got == expected(gateway.seeded, project), f"{label} as {project} in {scoping_mode} mode"


# ---------------------------------------------------------------------------
# 3. What the read-only account can and cannot do, asked of the database directly
# ---------------------------------------------------------------------------


def _ro_error(gateway: Gateway, sql: str, **kw) -> int | None:
    with pytest.raises(DatabaseError) as exc:
        gateway.ro.query(sql, **kw)
    return _code(exc.value)


@pytest.mark.parametrize("table", ["spans", "traces"])
def test_readonly_account_is_denied_the_physical_tables(gateway, table):
    assert _ro_error(gateway, f"SELECT count() FROM {table}") == 497


# Tables that always exist. `system.query_log` is created on the first log flush, so on a
# fresh server it answers "unknown table" rather than proving a denial.
@pytest.mark.parametrize(
    "table", ["system.users", "system.grants", "system.settings_profiles", "system.processes"]
)
def test_readonly_account_is_denied_sensitive_system_tables(gateway, table):
    assert _ro_error(gateway, f"SELECT count() FROM {table}") == 497


def test_readonly_account_can_see_only_the_views(gateway):
    rows = gateway.ro.query(
        f"SELECT name FROM system.tables WHERE database = '{DATABASE}' ORDER BY name"
    ).result_rows
    assert rows == [("spans_public_v1",), ("traces_public_v1",)]


@pytest.mark.parametrize(
    "statement",
    [
        "INSERT INTO spans (span_id, trace_id, project_id, span_start_time, name, span_kind) "
        "VALUES ('x', 'x', 'proj_a', now64(3), 'x', 'x')",
        "CREATE TABLE sneaky (a UInt8) ENGINE = Memory",
        "ALTER TABLE spans DELETE WHERE 1",
        "TRUNCATE TABLE traces",
        "DROP VIEW spans_public_v1",
    ],
)
def test_readonly_account_cannot_write_or_change_schema(gateway, statement):
    assert _ro_error(gateway, statement) in {164, 497}


def test_readonly_account_cannot_override_its_caps(gateway):
    """`readonly = 1` refuses any per-query setting, a looser cap included."""
    sql = f"SELECT 1 SETTINGS max_result_rows = {PROFILE_MAX_RESULT_ROWS * 100}"
    assert _ro_error(gateway, sql) == 164


def test_the_database_does_not_choose_the_tenant(gateway):
    """No database-level backstop: the read-only account calling a view directly gets
    whichever project it names. Isolation rests entirely on the rewriter binding the
    authenticated project, which is why the isolation tests above are the gate, and why
    user SQL may never name a view itself."""
    rows = gateway.ro.query(
        f"SELECT count() FROM spans_public_v1(project_id = '{PROJECT_B}', {OPEN_BOUNDS})"
    ).result_rows
    assert rows == [(len(gateway.seeded.spans[PROJECT_B]),)]

    with pytest.raises(SqlValidationError):
        rewriter.scope_and_render(
            f"SELECT span_id FROM spans_public_v1(project_id = '{PROJECT_B}', {OPEN_BOUNDS})",
            PROJECT_A,
        )


# ---------------------------------------------------------------------------
# 4. Dangerous query classes never reach the database
# ---------------------------------------------------------------------------

REJECTED = [
    ("DDL", "CREATE TABLE t (a UInt8) ENGINE = Memory"),
    ("DROP", "DROP TABLE spans"),
    ("mutation", "ALTER TABLE spans DELETE WHERE 1"),
    ("TRUNCATE", "TRUNCATE TABLE spans"),
    ("INSERT", "INSERT INTO spans (span_id) VALUES ('x')"),
    ("SYSTEM", "SYSTEM FLUSH LOGS"),
    ("SET", "SET max_result_rows = 1"),
    ("GRANT", "GRANT SELECT ON spans TO someone"),
    ("multi-statement", "SELECT span_id FROM spans; DROP TABLE spans"),
    ("system table", "SELECT name FROM system.tables"),
    (
        "system table in a subquery",
        "SELECT span_id FROM spans WHERE trace_id IN (SELECT name FROM system.tables)",
    ),
    (
        "system table in a union arm",
        "SELECT span_id FROM spans UNION ALL SELECT name FROM system.databases",
    ),
    ("qualified table", f"SELECT span_id FROM {DATABASE}.spans"),
    ("table function url", "SELECT * FROM url('http://example.com/x', CSV, 'a String')"),
    ("table function remote", "SELECT * FROM remote('localhost', default.spans)"),
    ("table function file", "SELECT * FROM file('/etc/passwd', 'LineAsString')"),
    ("table function numbers", "SELECT * FROM numbers(10)"),
    ("blocked function", "SELECT dictGet('d', 'x', toUInt64(1))"),
    ("blocked function sleep", "SELECT sleep(3)"),
    ("non-allowlisted function", "SELECT currentUser()"),
    ("project_id column", "SELECT project_id FROM spans"),
    ("project_id predicate", f"SELECT span_id FROM spans WHERE project_id = '{PROJECT_B}'"),
    ("project_id alias", "SELECT span_id AS project_id FROM spans"),
    ("FINAL", "SELECT span_id FROM spans FINAL"),
    ("SETTINGS", "SELECT span_id FROM spans SETTINGS max_result_rows = 1000000"),
    ("FORMAT", "SELECT span_id FROM spans FORMAT JSON"),
    # Caller placeholders such as {t:String} are deliberately not listed: whether one is
    # refused depends on whether the query service binds caller parameters, so this list
    # keeps only the placeholders that stay refused either way.
    (
        "reserved placeholder",
        "SELECT span_id FROM spans WHERE trace_id = {scope_project_id:String}",
    ),
    ("identifier placeholder column", "SELECT {c:Identifier} FROM spans"),
    ("identifier placeholder table", "SELECT * FROM {t:Identifier}"),
    ("internal view name", "SELECT span_id FROM spans_public_v1"),
    (
        "internal view call",
        f"SELECT span_id FROM spans_public_v1(project_id = '{PROJECT_B}', {OPEN_BOUNDS})",
    ),
    ("CTE shadowing a public table", "WITH spans AS (SELECT * FROM traces) SELECT * FROM spans"),
]


@pytest.mark.parametrize("label,sql", REJECTED, ids=[case[0] for case in REJECTED])
def test_dangerous_queries_are_rejected_before_execution(gateway, label, sql, monkeypatch):
    """Rejected while rendering, so no statement is ever sent. The spy makes that explicit
    rather than inferred from the exception."""
    sent = []
    monkeypatch.setattr(gateway.ro, "query", lambda *a, **kw: sent.append(a))
    with pytest.raises(SqlValidationError):
        rendered, binds = rewriter.scope_and_render(sql, PROJECT_A)
        gateway.ro.query(rendered, parameters=binds or None)
    assert sent == [], f"{label} reached the database"


# ---------------------------------------------------------------------------
# 5. The profile's caps fire
# ---------------------------------------------------------------------------


def test_result_row_cap_fires_for_the_readonly_account(gateway):
    rendered, binds = rewriter.scope_and_render("SELECT span_id FROM spans", PROJECT_CAP)
    assert _ro_error(gateway, rendered, parameters=binds or None) == 396


def test_aggregates_over_capped_data_still_answer(gateway):
    """The cap is on result rows, not rows read, so the same data summarised is fine."""
    assert _rows(gateway, "SELECT count() FROM spans", PROJECT_CAP) == [
        (PROFILE_MAX_RESULT_ROWS + 50,)
    ]


# ---------------------------------------------------------------------------
# 6. View semantics the security story relies on
# ---------------------------------------------------------------------------

IN_WINDOW = {"sem-b0901", "sem-b0901h", "sem-b0904", "sem-dedup"}


def test_internal_traffic_is_not_visible(gateway):
    spans = _values(_rows(gateway, "SELECT span_id FROM spans", PROJECT_SEM))
    traces = _values(_rows(gateway, "SELECT trace_id FROM traces", PROJECT_SEM))
    assert "sem-internal-s0" not in spans and "sem-internal" not in traces
    # A span whose newest version was retracted to internal traffic: the filter applies to
    # the deduplicated row, so the older customer version cannot answer for it.
    assert "sem-retract" not in spans


def test_dedup_returns_the_newest_version_of_a_corrected_span(gateway):
    physical = gateway.admin.query(
        "SELECT count() FROM spans WHERE span_id = 'sem-dedup'"
    ).result_rows
    assert physical == [(2,)], "the fixture needs two physical versions to mean anything"
    rows = _rows(
        gateway, "SELECT span_id, name FROM spans WHERE span_id = 'sem-dedup'", PROJECT_SEM
    )
    assert rows == [("sem-dedup", "v2")]


def test_evaluation_trace_stays_hidden_after_a_merge(gateway):
    def visible():
        traces = _values(_rows(gateway, "SELECT trace_id FROM traces", PROJECT_SEM))
        spans = _values(_rows(gateway, "SELECT span_id FROM spans", PROJECT_SEM))
        return "sem-eval" in traces, {"sem-eval-scorer", "sem-eval-child"} & spans

    assert visible() == (False, set())
    versions = gateway.admin.query(
        "SELECT count() FROM traces WHERE trace_id = 'sem-eval'"
    ).result_rows
    assert versions == [(2,)], "both trace versions must exist before this test merges them"

    # Only this case's partition, so no other test's seeded versions are merged away.
    gateway.admin.command(f"OPTIMIZE TABLE traces PARTITION {EVAL_PARTITION} FINAL")
    gateway.admin.command(f"OPTIMIZE TABLE spans PARTITION {EVAL_PARTITION} FINAL")
    flags = gateway.admin.query(
        "SELECT groupArray(is_evaluation) FROM traces WHERE trace_id = 'sem-eval'"
    ).result_rows
    assert flags == [([0],)], "the merge should have deleted the flagged trace version"

    assert visible() == (False, set()), "the flagged span must keep the trace excluded"


def test_unbounded_traces_query_reads_every_row_of_a_wide_project(gateway):
    """A query with no time filter gets the open bounds, and on `traces` those used to be
    outside the range a Date can hold. The sort key is `toDate(trace_start_time)`, so the
    primary-key analysis wrapped the lower bound to 2079 and pruned every granule it could
    date: this project returned about a third of its rows. Seeded wide on purpose, since a
    single small granule cannot be pruned and hides the defect."""
    project = PROJECTS_WIDE[1]
    physical = gateway.admin.query(
        f"SELECT count() FROM traces WHERE project_id = '{project}'"
    ).result_rows
    assert physical == [(WIDE_TRACES_PER_PROJECT,)]
    for sql in (
        "SELECT count() FROM traces",
        "SELECT count() FROM traces WHERE trace_start_time >= '1960-01-01'",
    ):
        assert _rows(gateway, sql, project) == [(WIDE_TRACES_PER_PROJECT,)], sql


def test_half_open_window_includes_its_start_and_excludes_its_end(gateway):
    sql = (
        "SELECT span_id FROM spans "
        "WHERE span_start_time >= '2026-09-01 00:00:00' AND span_start_time < '2026-09-05 00:00:00'"
    )
    assert _values(_rows(gateway, sql, PROJECT_SEM)) == IN_WINDOW
    assert _values(_rows(gateway, sql, PROJECT_SEM, open_bounds=True)) == IN_WINDOW


@pytest.mark.parametrize(
    "label,sql",
    [
        (
            "timezone-carrying bounds",
            "SELECT span_id FROM spans WHERE span_start_time >= toDateTime('2026-09-01 09:00:00', 'Asia/Tokyo') "
            "AND span_start_time < toDateTime('2026-09-04 20:00:00', 'America/New_York')",
        ),
        (
            "bounds of mixed types",
            "SELECT span_id FROM spans WHERE span_start_time >= toDateTime('2026-08-01 00:00:00') "
            "AND span_start_time >= '2026-09-01' AND span_start_time < 1788566400",
        ),
    ],
)
def test_bounded_query_matches_its_unbounded_form(gateway, label, sql):
    """Both windows are 2026-09-01 00:00 to 2026-09-05 00:00 UTC, written differently."""
    assert _values(_rows(gateway, sql, PROJECT_SEM)) == IN_WINDOW, label
    assert _values(_rows(gateway, sql, PROJECT_SEM, open_bounds=True)) == IN_WINDOW, label


@pytest.mark.parametrize(
    "sql",
    [
        "SELECT s.span_id FROM spans AS s INNER JOIN traces AS t ON s.trace_id = t.trace_id "
        "WHERE s.span_start_time >= t.trace_start_time",
        "SELECT span_id FROM spans WHERE span_start_time >= (SELECT min(span_start_time) FROM spans)",
    ],
    ids=["column reference bound", "scalar subquery bound"],
)
def test_non_constant_bounds_still_run(gateway, sql):
    bounded = _values(_rows(gateway, sql, PROJECT_A))
    assert bounded and bounded == _values(_rows(gateway, sql, PROJECT_A, open_bounds=True))


# ---------------------------------------------------------------------------
# 7. What the views return is what the contract says
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("table,view", sorted(TABLE_VIEW_MAP.items()))
def test_view_columns_and_types_match_the_contract(gateway, table, view):
    """Types are canonicalised by the server on both sides, since `Decimal64(9)` and
    `Decimal(18, 9)` are one type spelled two ways."""

    def canonical(type_name: str) -> str:
        return gateway.admin.query(
            "SELECT toTypeName(defaultValueOfTypeName({t:String}))", parameters={"t": type_name}
        ).result_rows[0][0]

    described = gateway.ro.query(
        f"DESCRIBE (SELECT * FROM {view}(project_id = '{PROJECT_A}', {OPEN_BOUNDS}))"
    ).result_rows
    got = [(name, canonical(type_name)) for name, type_name, *_ in described]
    want = [(c.name, canonical(c.type)) for c in PUBLIC_TABLES[table].columns]
    assert got == want
