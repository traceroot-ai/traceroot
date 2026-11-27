"""Sorting for the Traces, Users and Sessions lists.

The ClickHouse client is stubbed, so these assert the queries the reader issues and how
it assembles their rows, and that the routes accept only known sort keys.
"""

from datetime import datetime
from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient

from rest.main import app
from rest.routers.deps import ProjectAccessInfo, get_project_access
from rest.services.trace_reader import TraceReaderService

EMPTY_PAGE = {"data": [], "meta": {"page": 0, "limit": 50, "total": 0}}


class _Result:
    def __init__(self, rows):
        self.result_rows = rows


class _Client:
    """Records every query and answers the ranking, page and count queries."""

    def __init__(self, ranked_ids=(), page_rows=()):
        self.ranked_ids = list(ranked_ids)
        self.page_rows = list(page_rows)
        self.calls = []

    def query(self, query, parameters=None, settings=None):
        sql = " ".join(query.split())
        self.calls.append((sql, dict(parameters or {})))
        if "SELECT m.trace_id" in sql:
            return _Result([[trace_id] for trace_id in self.ranked_ids])
        if sql.startswith("SELECT count(DISTINCT"):
            return _Result([[len(self.ranked_ids) or len(self.page_rows)]])
        return _Result(self.page_rows)


def _service(monkeypatch, client):
    monkeypatch.setattr("rest.services.trace_reader.get_clickhouse_client", lambda: client)
    return TraceReaderService()


def _trace_row(trace_id):
    start = datetime(2026, 1, 1)
    return [trace_id, "p1", trace_id, start, None, None, 1, 5, 0, None, None, 0, 0, 0.0, {}]


class TestTraceSorting:
    def test_default_is_newest_first(self, monkeypatch):
        client = _Client()
        _service(monkeypatch, client).list_traces("p1")

        page_sql = client.calls[0][0]
        assert "ORDER BY trace_start_time DESC, trace_id DESC" in page_sql
        assert "SELECT m.trace_id" not in page_sql

    def test_timestamp_ascending_reorders_the_page_query(self, monkeypatch):
        client = _Client()
        _service(monkeypatch, client).list_traces("p1", sort="timestamp", order="asc")

        page_sql, params = client.calls[0]
        assert "ORDER BY trace_start_time ASC, trace_id ASC" in page_sql
        assert "ORDER BY p.trace_start_time ASC, p.trace_id ASC" in page_sql
        assert "start_after" not in params

    @pytest.mark.parametrize(
        "sort,metric",
        [
            ("latency", "dateDiff('millisecond'"),
            ("spans", "count(span_id) AS sort_value"),
            ("errors", "countIf(status = 'ERROR') AS sort_value"),
        ],
    )
    def test_span_sort_ranks_every_match_then_reads_that_page(self, monkeypatch, sort, metric):
        # The page query returns rows in its own order; the ranked order must win.
        client = _Client(ranked_ids=["b", "a"], page_rows=[_trace_row("a"), _trace_row("b")])
        result = _service(monkeypatch, client).list_traces(
            "p1", page=2, limit=2, sort=sort, order="asc"
        )

        (rank_sql, rank_params), (page_sql, page_params) = client.calls[:2]
        assert metric in rank_sql
        assert "ORDER BY sm.sort_value ASC NULLS LAST" in rank_sql
        assert rank_params["offset"] == 4
        # The ids are already the requested page, so the page query skips nothing.
        assert page_params["page_ids"] == ["b", "a"]
        assert page_params["offset"] == 0
        assert "t.trace_id IN {page_ids:Array(String)}" in page_sql
        assert [row["trace_id"] for row in result["data"]] == ["b", "a"]

    def test_span_sort_without_a_start_takes_the_default_lookback(self, monkeypatch):
        client = _Client()
        _service(monkeypatch, client).list_traces("p1", sort="latency")

        for sql, params in client.calls:
            assert "start_after" in params
            assert "t.trace_start_time >= {start_after:DateTime64(3)}" in sql

    def test_page_past_the_end_reads_no_rows_but_keeps_the_total(self, monkeypatch):
        client = _Client(ranked_ids=[])
        result = _service(monkeypatch, client).list_traces("p1", page=9, sort="spans")

        assert result["data"] == []
        # Ranking and count only.
        assert len(client.calls) == 2
        assert "count(DISTINCT" in client.calls[1][0]


class TestSessionSorting:
    @pytest.mark.parametrize(
        "kwargs,page_order,row_order",
        [
            (
                {},
                "ORDER BY max(t.trace_start_time) DESC, t.session_id DESC",
                "ORDER BY last_trace_time DESC, td.session_id DESC",
            ),
            (
                {"sort": "timestamp", "order": "asc"},
                "ORDER BY min(t.trace_start_time) ASC, t.session_id ASC",
                "ORDER BY first_trace_time ASC, td.session_id ASC",
            ),
            (
                {"sort": "traces", "order": "desc"},
                "ORDER BY count() DESC, max(t.trace_start_time) DESC",
                "ORDER BY trace_count DESC, last_trace_time DESC",
            ),
        ],
    )
    def test_order(self, monkeypatch, kwargs, page_order, row_order):
        client = _Client()
        _service(monkeypatch, client).list_sessions("p1", **kwargs)

        sql = client.calls[0][0]
        assert page_order in sql
        assert row_order in sql


class TestUserSorting:
    @pytest.mark.parametrize(
        "kwargs,page_order",
        [
            ({}, "ORDER BY last_trace_time DESC, user_id DESC"),
            # A direction without a sort key leaves the default order alone.
            ({"order": "asc"}, "ORDER BY last_trace_time DESC, user_id DESC"),
            (
                {"sort": "last_activity", "order": "asc"},
                "ORDER BY last_trace_time ASC, user_id ASC",
            ),
            ({"sort": "traces", "order": "asc"}, "ORDER BY trace_count ASC, last_trace_time DESC"),
        ],
    )
    def test_order(self, monkeypatch, kwargs, page_order):
        client = _Client()
        _service(monkeypatch, client).list_users("p1", **kwargs)

        assert page_order in client.calls[0][0]


@pytest.fixture()
def routes(monkeypatch):
    async def access(project_id: str, x_user_id=None):
        return ProjectAccessInfo(
            project_id=project_id,
            user_id="test-user",
            role="ADMIN",
            workspace_id="ws-test",
            billing_plan="enterprise",
        )

    app.dependency_overrides[get_project_access] = access
    reader = MagicMock()
    for method in ("list_traces", "list_sessions", "list_users"):
        getattr(reader, method).return_value = EMPTY_PAGE
    for module in ("traces", "sessions", "users"):
        monkeypatch.setattr(f"rest.routers.{module}.get_trace_reader_service", lambda: reader)
    yield TestClient(app), reader
    app.dependency_overrides.pop(get_project_access, None)


@pytest.mark.parametrize(
    "resource,sort",
    [("traces", "latency"), ("sessions", "traces"), ("users", "last_activity")],
)
def test_route_passes_the_sort_to_the_reader(routes, resource, sort):
    client, reader = routes
    response = client.get(f"/api/v1/projects/p1/{resource}", params={"sort": sort, "order": "asc"})

    assert response.status_code == 200
    kwargs = getattr(reader, f"list_{resource}").call_args.kwargs
    assert (kwargs["sort"], kwargs["order"]) == (sort, "asc")


@pytest.mark.parametrize("resource", ["traces", "sessions", "users"])
@pytest.mark.parametrize("params", [{"sort": "name; DROP TABLE traces"}, {"order": "sideways"}])
def test_route_rejects_unknown_sort_values(routes, resource, params):
    client, reader = routes
    response = client.get(f"/api/v1/projects/p1/{resource}", params=params)

    assert response.status_code == 422
    getattr(reader, f"list_{resource}").assert_not_called()
