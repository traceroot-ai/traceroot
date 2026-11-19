"""The plan's retention window, enforced on the public SQL route against a live ClickHouse.

Each plan gets its own cutoff: free 15 days, starter 30, pro 90, enterprise unlimited, and
an unknown plan fails closed to 15. The project seeds one trace and one span per age (1, 20,
60 and 200 days old), so every plan sees a different, known number of rows. The route tests
authenticate as that project with each plan and prove that a count, a join, or an explicit
bound written by the caller cannot reach past the floor. Only authentication is stubbed, to
pick the plan; the service, the rewriter, the views and the read-only account are all real.

The service-level test calls ``SqlQueryService.run`` with a ``retention_floor`` directly,
which is the seam the route uses.
"""

from __future__ import annotations

from collections.abc import Callable, Iterator
from datetime import UTC, datetime, timedelta

import pytest
from fastapi.testclient import TestClient

import rest.routers.public.sql as sql_router
from rest.main import app
from rest.routers.public.deps import AuthResult, authenticate_public_caller
from rest.services.sql.service import SqlQueryService

from .conftest import Gateway, _insert, _span, _trace

pytestmark = pytest.mark.integration

PROJECT = "proj_sql_retention"
SQL_URL = "/api/v1/public/sql"
AUTH_HEADER = {"Authorization": "Bearer tr_integration"}

#: Trace age in days, keyed by a short name used in the trace id.
AGES = {"day1": 1, "day20": 20, "day60": 60, "day200": 200}

LEAK_MARKERS = (
    "spans_public_v1",
    "traces_public_v1",
    "scope_project_id",
    PROJECT,
    "DB::Exception",
    "Code:",
)

JOIN_COUNT = "SELECT count() FROM spans s JOIN traces t ON s.trace_id = t.trace_id"


def _assert_no_leak(text: str) -> None:
    for marker in LEAK_MARKERS:
        assert marker not in text, f"{marker!r} reached the caller: {text}"


@pytest.fixture(scope="module")
def seeded_project(gateway: Gateway) -> str:
    """One trace and one span per age, in both tables, with the same id and start time.

    Ages are relative to now, unlike the fixed dates the other suites seed, because the
    retention cutoff is. The session's ``gateway`` recreates the database, so the project
    starts empty.
    """
    admin = gateway.admin
    now = datetime.now(UTC)
    trace_rows, span_rows = [], []
    for name, days in AGES.items():
        trace_id = f"ret-{name}"
        start = now - timedelta(days=days)
        trace_rows.append(_trace(PROJECT, trace_id, start))
        span_rows.append(_span(PROJECT, f"{trace_id}-s0", trace_id, start))
    _insert(admin, "traces", trace_rows)
    _insert(admin, "spans", span_rows)
    return PROJECT


@pytest.fixture()
def as_plan(gateway: Gateway, seeded_project: str, monkeypatch) -> Iterator[Callable]:
    """A TestClient authenticated as the seeded project on the given billing plan.

    The route builds its service with no arguments, so the class is swapped for one bound
    to the real read-only client, as the service suite does.
    """
    monkeypatch.setattr(sql_router, "SqlQueryService", lambda: SqlQueryService(client=gateway.ro))

    def for_plan(plan: str) -> TestClient:
        app.dependency_overrides[authenticate_public_caller] = lambda: AuthResult(
            project_id=seeded_project,
            workspace_id="ws-integration",
            billing_plan=plan,
            ingestion_blocked=False,
        )
        return TestClient(app)

    yield for_plan
    app.dependency_overrides.clear()


def _count(client: TestClient, sql: str) -> int:
    resp = client.post(SQL_URL, json={"query": sql}, headers=AUTH_HEADER)
    assert resp.status_code == 200, resp.text
    _assert_no_leak(resp.text)
    return resp.json()["rows"][0][0]


# ---------------------------------------------------------------------------
# 1. Each plan sees its own window, through the route
# ---------------------------------------------------------------------------

PLAN_EXPECTATIONS = [
    ("free", 1),
    ("starter", 2),
    ("pro", 3),
    ("enterprise", 4),
]


@pytest.mark.parametrize(("plan", "expected"), PLAN_EXPECTATIONS)
def test_a_trace_count_stops_at_the_plan_window(as_plan, plan, expected):
    assert _count(as_plan(plan), "SELECT count() FROM traces") == expected


@pytest.mark.parametrize(("plan", "expected"), PLAN_EXPECTATIONS)
def test_a_span_count_stops_at_the_plan_window(as_plan, plan, expected):
    assert _count(as_plan(plan), "SELECT count() FROM spans") == expected


@pytest.mark.parametrize(("plan", "expected"), PLAN_EXPECTATIONS)
def test_a_join_of_spans_and_traces_stops_at_the_plan_window(as_plan, plan, expected):
    assert _count(as_plan(plan), JOIN_COUNT) == expected


# ---------------------------------------------------------------------------
# 2. A caller's own bound cannot reach past the floor
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("plan", "expected"),
    [("free", 0), ("starter", 0), ("pro", 0), ("enterprise", 1)],
)
def test_an_explicit_old_window_cannot_reach_past_the_plan_window(as_plan, plan, expected):
    sql = "SELECT count() FROM traces WHERE trace_start_time < now() - INTERVAL 100 DAY"
    assert _count(as_plan(plan), sql) == expected


# ---------------------------------------------------------------------------
# 3. An unrecognised plan fails closed to the shortest window
# ---------------------------------------------------------------------------


def test_an_unknown_plan_is_held_to_the_free_window(as_plan):
    assert _count(as_plan("legacy"), "SELECT count() FROM traces") == 1


# ---------------------------------------------------------------------------
# 4. The service applies a floor passed to it directly
# ---------------------------------------------------------------------------


def test_the_service_counts_only_traces_after_a_fifteen_day_floor(gateway, seeded_project):
    floor = datetime.now(UTC).replace(tzinfo=None) - timedelta(days=15)
    result = SqlQueryService(client=gateway.ro).run(
        "SELECT count() FROM traces", seeded_project, retention_floor=floor
    )
    assert result.rows == [[1]]
