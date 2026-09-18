"""The SQL gateway's execution service and HTTP route, against a live ClickHouse.

The companion suite in ``test_sql_gateway_clickhouse.py`` proves what the database
enforces once the rewriter has rendered a query. This one proves the layer above it,
end to end: ``SqlQueryService`` executing as the read-only account, and
``POST /api/v1/public/sql`` driving that same service. Only authentication is stubbed,
to pick which project the credential resolves to; the service, the rewriter, the
views and the account are all real.

Every client the service uses is wrapped in a spy, so a test that expects a request to
be refused can also prove it never reached ClickHouse.

What this does not exercise: the execution-time and memory caps. They are CONST on the
read-only profile at 30 s and 4 GiB, which is checked here against the application's
settings, but tripping either for real costs more than a CI run should. The result-row
cap is exercised, through the service, and so is the way every cap error is reported.
"""

from __future__ import annotations

from typing import Any

import pytest
from fastapi.testclient import TestClient

import rest.routers.public.sql as sql_router
from rest.main import app
from rest.routers.public.deps import AuthResult, authenticate_public_caller
from rest.services.sql.errors import SqlExecutionError
from rest.services.sql.schema import PUBLIC_TABLES
from rest.services.sql.service import SqlQueryService
from shared.config import settings

from .conftest import (
    DATABASE,
    PROFILE_MAX_RESULT_ROWS,
    PROJECT_A,
    PROJECT_B,
    PROJECT_CAP,
    Gateway,
    Seeded,
)

pytestmark = pytest.mark.integration

SQL_URL = "/api/v1/public/sql"
AUTH_HEADER = {"Authorization": "Bearer tr_integration"}
OPEN_BOUNDS = (
    "start_time = toDateTime64('1970-01-01 00:00:00.000', 3), "
    "end_time = toDateTime64('2149-06-06 23:59:59.999', 3)"
)

#: Nothing a caller receives may contain these. The raw ClickHouse errors do, which is
#: the point of checking: see test_a_real_database_error_is_reported_without_its_text.
LEAK_MARKERS = (
    "spans_public_v1",
    "traces_public_v1",
    "scope_project_id",
    PROJECT_A,
    PROJECT_B,
    "DB::Exception",
    "Code:",
)


class SpyClient:
    """Delegates to the read-only client and records every statement sent."""

    def __init__(self, inner: Any) -> None:
        self.inner = inner
        self.calls: list[str] = []

    def query(self, sql: str, parameters: dict | None = None, settings: dict | None = None):
        self.calls.append(sql)
        return self.inner.query(sql, parameters=parameters, settings=settings)


@pytest.fixture()
def spy(gateway: Gateway) -> SpyClient:
    return SpyClient(gateway.ro)


@pytest.fixture()
def service(spy: SpyClient) -> SqlQueryService:
    return SqlQueryService(client=spy)


@pytest.fixture()
def http(spy: SpyClient, monkeypatch):
    """A TestClient per project. The route builds its service with no arguments, so the
    class is swapped for one bound to the spied read-only client."""
    monkeypatch.setattr(sql_router, "SqlQueryService", lambda: SqlQueryService(client=spy))

    def as_project(project: str) -> TestClient:
        app.dependency_overrides[authenticate_public_caller] = lambda: AuthResult(
            project_id=project,
            workspace_id="ws-integration",
            billing_plan="enterprise",
            ingestion_blocked=False,
        )
        return TestClient(app)

    yield as_project
    app.dependency_overrides.clear()


def _assert_no_leak(text: str) -> None:
    for marker in LEAK_MARKERS:
        assert marker not in text, f"{marker!r} reached the caller: {text}"


def _spans_in_trace(gateway: Gateway, project: str, trace_id: str) -> int:
    return gateway.admin.query(
        "SELECT count() FROM spans WHERE project_id = {p:String} AND trace_id = {t:String}",
        parameters={"p": project, "t": trace_id},
    ).result_rows[0][0]


# ---------------------------------------------------------------------------
# 1. The service and the route answer correctly
# ---------------------------------------------------------------------------


def test_the_service_reports_columns_as_the_view_defines_them(gateway, service):
    """Names in contract order, types exactly as ClickHouse describes the view. The type
    is the server's name for it, never the driver's object representation."""
    result = service.run("SELECT * FROM spans LIMIT 1", PROJECT_A)
    described = gateway.admin.query(
        f"DESCRIBE (SELECT * FROM {DATABASE}.spans_public_v1(project_id = '{PROJECT_A}', "
        f"{OPEN_BOUNDS}))"
    ).result_rows
    assert [(c.name, c.type) for c in result.columns] == [(n, t) for n, t, *_ in described]
    assert [c.name for c in result.columns] == [c.name for c in PUBLIC_TABLES["spans"].columns]


@pytest.mark.parametrize("project", [PROJECT_A, PROJECT_B])
def test_the_route_answers_only_for_the_credential_s_project(http, gateway, project):
    seeded: Seeded = gateway.seeded
    client = http(project)
    traces = client.post(
        SQL_URL, json={"query": "SELECT DISTINCT trace_id FROM spans"}, headers=AUTH_HEADER
    )
    count = client.post(SQL_URL, json={"query": "SELECT count() FROM spans"}, headers=AUTH_HEADER)
    assert traces.status_code == 200 and count.status_code == 200
    assert {row[0] for row in traces.json()["rows"]} == seeded.traces[project]
    assert count.json()["rows"] == [[len(seeded.spans[project])]]


# ---------------------------------------------------------------------------
# 2. Caller parameters: bound as values, never allowed to name the scope
# ---------------------------------------------------------------------------

BOUND_QUERY = "SELECT count() FROM spans WHERE trace_id = {t:String}"


@pytest.mark.parametrize(
    "name", ["scope_project_id", "SCOPE_PROJECT_ID", "scope_start_time", "project_id", "Project_Id"]
)
def test_a_reserved_parameter_is_refused_before_execution(service, spy, name):
    with pytest.raises(SqlExecutionError) as exc:
        service.run(BOUND_QUERY, PROJECT_A, parameters={name: PROJECT_B, "t": "a-t0"})
    assert exc.value.is_client_error
    _assert_no_leak(str(exc.value))
    assert spy.calls == [], "a reserved parameter reached ClickHouse"


@pytest.mark.parametrize("name", ["scope_project_id", "project_id"])
def test_the_route_refuses_a_reserved_parameter(http, spy, name):
    resp = http(PROJECT_A).post(
        SQL_URL,
        json={"query": BOUND_QUERY, "parameters": {name: PROJECT_B, "t": "a-t0"}},
        headers=AUTH_HEADER,
    )
    assert resp.status_code == 400
    _assert_no_leak(resp.text)
    assert spy.calls == []


@pytest.mark.parametrize("key", ["project_id", "scope_project_id"])
def test_a_body_that_names_a_project_is_refused(http, spy, key):
    resp = http(PROJECT_A).post(
        SQL_URL, json={"query": "SELECT count() FROM spans", key: PROJECT_B}, headers=AUTH_HEADER
    )
    assert resp.status_code == 422
    # The caller's own key may be echoed back; what must not appear is anything internal.
    assert "spans_public_v1" not in resp.text and "traces_public_v1" not in resp.text
    assert spy.calls == []


def test_the_scope_bind_still_wins_if_the_name_check_were_bypassed(gateway, service, monkeypatch):
    """The reserved-name check is the first of two independent guards. The second is that
    the scope bind is merged last, so a caller value for `scope_project_id` that somehow got
    past the check is overwritten before the query is sent. Proved with the check removed:
    project A's credential still counts project A's spans, not project B's."""
    import rest.services.sql.service as service_module

    monkeypatch.setattr(service_module, "_scrubbed", lambda parameters: dict(parameters or {}))
    result = service.run(
        "SELECT count() FROM spans", PROJECT_A, parameters={"scope_project_id": PROJECT_B}
    )
    assert result.rows == [[len(gateway.seeded.spans[PROJECT_A])]]


def test_a_caller_parameter_binds_as_a_value_inside_the_caller_s_scope(gateway, service):
    """A foreign trace id is a value like any other: it matches nothing, because the
    scope bind still decides which project's rows exist to be matched."""
    own, foreign = (
        sorted(gateway.seeded.traces[PROJECT_A])[0],
        sorted(gateway.seeded.traces[PROJECT_B])[0],
    )
    expected = _spans_in_trace(gateway, PROJECT_A, own)
    assert expected > 0

    def count(trace_id: str) -> int:
        return service.run(BOUND_QUERY, PROJECT_A, parameters={"t": trace_id}).rows[0][0]

    assert count(own) == expected
    assert count(foreign) == 0
    assert count(f"{own}' OR 1 = 1 OR trace_id = '") == 0, "the value was interpolated"


def test_a_referenced_parameter_the_caller_did_not_send_is_a_client_error(http):
    resp = http(PROJECT_A).post(SQL_URL, json={"query": BOUND_QUERY}, headers=AUTH_HEADER)
    assert resp.status_code == 400
    assert resp.json()["detail"] == "Query uses a parameter that was not supplied."


#: A value the declared type cannot hold. ClickHouse raises a different code per
#: type family, and the wording is what the service reads, so these have to run
#: against a real server: a fake would only prove the code matches itself. The
#: trailing Z is the spelling every ISO-8601 formatter emits.
UNPARSEABLE = [
    (
        "an ISO timestamp with a zone",
        "SELECT count() FROM spans WHERE span_start_time > {p:DateTime64(3)}",
        "2026-01-01T00:00:00Z",
    ),
    (
        "a number that is not one",
        "SELECT count() FROM spans WHERE duration_ms > {p:Int64}",
        "not-a-number",
    ),
    (
        "a date that is not one",
        "SELECT count() FROM spans WHERE toDate(span_start_time) > {p:Date}",
        "nope",
    ),
]


#: A literal the caller wrote, refused by the type it is converted to. Run live
#: because the codes differ per conversion (6, 38, 41 on 25.2) and a fake would
#: only prove the table matches itself.
BAD_LITERALS = [
    # The shape that found this: toDateTime parses seconds, not fractions.
    (
        "a timestamp with fractional seconds",
        "SELECT count() FROM spans WHERE "
        "toDateTime(span_start_time) >= toDateTime('2026-09-01 00:00:00.000')",
    ),
    (
        "a date that is not one",
        "SELECT count() FROM spans WHERE toDate(span_start_time) >= toDate('nonsense')",
    ),
    ("a number that is not one", "SELECT count() FROM spans WHERE duration_ms > toInt64('abc')"),
]


@pytest.mark.parametrize("label,sql", BAD_LITERALS, ids=[b[0] for b in BAD_LITERALS])
def test_a_literal_the_type_cannot_hold_is_a_client_error(http, label, sql):
    resp = http(PROJECT_A).post(SQL_URL, json={"query": sql}, headers=AUTH_HEADER)
    assert resp.status_code == 400, f"{label}: {resp.status_code} {resp.text}"
    assert resp.json()["detail"] == (
        "Query contains a value that cannot be parsed as the type it is used as."
    )
    _assert_no_leak(resp.text)


@pytest.mark.parametrize("label,sql,value", UNPARSEABLE, ids=[u[0] for u in UNPARSEABLE])
def test_a_value_the_declared_type_cannot_hold_is_a_client_error(http, label, sql, value):
    # A 500 would send the caller to read a status page about a value only they
    # can fix, and would page whoever owns the gateway for it.
    resp = http(PROJECT_A).post(
        SQL_URL, json={"query": sql, "parameters": {"p": value}}, headers=AUTH_HEADER
    )
    assert resp.status_code == 400, f"{label}: {resp.text}"
    assert resp.json()["detail"] == (
        "Query supplied a parameter value that its declared type cannot hold."
    )
    _assert_no_leak(resp.text)
    assert value not in resp.text, f"{label}: the refused value came back"


# ---------------------------------------------------------------------------
# 3. The row cap and its truncation sentinel
# ---------------------------------------------------------------------------

ORDERED = "SELECT span_id FROM spans ORDER BY span_id"


def test_exactly_max_rows_is_not_truncated(gateway, service):
    total = len(gateway.seeded.spans[PROJECT_A])
    result = service.run(ORDERED, PROJECT_A, max_rows=total)
    assert (result.row_count, result.truncated) == (total, False)


def test_one_more_row_than_max_rows_is_truncated_to_max_rows(gateway, service):
    ids = sorted(gateway.seeded.spans[PROJECT_A])
    result = service.run(ORDERED, PROJECT_A, max_rows=len(ids) - 1)
    assert (result.row_count, result.truncated) == (len(ids) - 1, True)
    assert [row[0] for row in result.rows] == ids[:-1], (
        "expected the first max_rows ids in order, with the sentinel row dropped"
    )


def test_a_larger_caller_limit_does_not_lift_the_cap(service):
    result = service.run(f"{ORDERED} LIMIT 1000", PROJECT_A, max_rows=10)
    assert (result.row_count, result.truncated) == (10, True)


def test_a_smaller_caller_limit_is_honoured(service):
    result = service.run(f"{ORDERED} LIMIT 5", PROJECT_A, max_rows=10)
    assert (result.row_count, result.truncated) == (5, False)


def test_the_route_reports_truncation(http, gateway):
    total = len(gateway.seeded.spans[PROJECT_A])
    resp = http(PROJECT_A).post(
        SQL_URL, json={"query": ORDERED, "max_rows": total - 1}, headers=AUTH_HEADER
    )
    body = resp.json()
    assert resp.status_code == 200
    assert (body["row_count"], body["truncated"], len(body["rows"])) == (total - 1, True, total - 1)


def test_the_default_ceiling_truncates_under_the_server_cap_instead_of_failing(service):
    """More rows exist than the profile allows in one result. The default ceiling sits one
    below that cap, so the sentinel row still fits and the query comes back truncated."""
    result = service.run("SELECT span_id FROM spans", PROJECT_CAP)
    assert result.truncated
    assert result.row_count == settings.clickhouse.sql_max_result_rows - 1


# ---------------------------------------------------------------------------
# 4. Resource caps
# ---------------------------------------------------------------------------


def test_the_profile_caps_are_the_ones_the_application_assumes(gateway):
    """The provisioning SQL and the application settings each carry the caps. The fallback
    client applies the settings' values, and the service's row ceiling is derived from
    them, so a drift between the two is a real defect on one path or the other."""
    elements = dict(
        (name, (value, writability))
        for name, value, writability in gateway.admin.query(
            "SELECT setting_name, value, writability FROM system.settings_profile_elements "
            "WHERE profile_name = 'sql_readonly_profile'"
        ).result_rows
    )
    ch = settings.clickhouse
    assert elements["readonly"][0] == "1"
    for name, expected in (
        ("max_execution_time", ch.sql_max_execution_time),
        ("max_result_rows", ch.sql_max_result_rows),
        ("max_result_bytes", ch.sql_max_result_bytes),
        ("max_memory_usage", ch.sql_max_memory_usage),
    ):
        assert elements[name] == (str(expected), "CONST"), name
    assert ch.sql_max_result_rows == PROFILE_MAX_RESULT_ROWS


def test_a_ceiling_at_the_cap_trips_the_server_limit_and_reports_it_safely(gateway, spy):
    """Why the default ceiling is one below the cap: at the cap, the sentinel row is the
    one that crosses it, and the whole query fails with Code 396."""
    at_cap = SqlQueryService(client=spy, max_rows_ceiling=PROFILE_MAX_RESULT_ROWS)
    with pytest.raises(SqlExecutionError) as exc:
        at_cap.run("SELECT span_id FROM spans", PROJECT_CAP)
    assert "396" in str(exc.value.__cause__), "the server cap did not fire"
    assert exc.value.is_client_error
    assert str(exc.value) == "Query result exceeded the maximum size allowed."
    _assert_no_leak(str(exc.value))


# ---------------------------------------------------------------------------
# 5. Real database errors never reach the caller as text
# ---------------------------------------------------------------------------

#: (label, query, whether ClickHouse's own message names the view or the bound project).
#: Most errors quote the rewritten scope, which is what makes them dangerous to return.
FAILING = [
    ("wrong argument type", "SELECT span_id + 1 FROM spans", True),
    ("unknown column", "SELECT no_such_column FROM spans", True),
    ("no common type", "SELECT if(1, span_id, 1) FROM spans", True),
    ("unparseable value", "SELECT toDate(span_id) FROM spans", False),
]


@pytest.mark.parametrize("label,sql,raw_is_internal", FAILING, ids=[f[0] for f in FAILING])
def test_a_real_database_error_is_reported_without_its_text(service, label, sql, raw_is_internal):
    with pytest.raises(SqlExecutionError) as exc:
        service.run(sql, PROJECT_A)
    raw = str(exc.value.__cause__)
    if raw_is_internal:
        # Prove the raw message really names the curated view or the bound project, so
        # the absence checked below is a scrub and not an error that had nothing in it.
        assert "spans_public_v1" in raw or PROJECT_A in raw, f"{label}: nothing to scrub in {raw}"
    _assert_no_leak(str(exc.value))
    assert sql not in str(exc.value)


@pytest.mark.parametrize("label,sql,raw_is_internal", FAILING, ids=[f[0] for f in FAILING])
def test_the_route_reports_a_real_database_error_without_its_text(
    http, label, sql, raw_is_internal
):
    resp = http(PROJECT_A).post(SQL_URL, json={"query": sql}, headers=AUTH_HEADER)
    assert resp.status_code in (400, 500), f"{label}: {resp.status_code}"
    _assert_no_leak(resp.text)
    assert sql not in resp.text
