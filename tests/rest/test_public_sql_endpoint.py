"""Tests for the public SQL endpoints.

The service is stubbed, because what these tests are for is the HTTP contract:
which status code each failure becomes, what the body is allowed to say, and
that the project a query runs against comes from the credential rather than from
anything the caller sent.
"""

from __future__ import annotations

from typing import Any

import pytest
from fastapi.testclient import TestClient

import rest.routers.public.sql as sql_router
from rest.main import app
from rest.routers.public.deps import AuthResult, authenticate_public_caller
from rest.services.sql.errors import SqlExecutionError, SqlValidationError
from rest.services.sql.service import SqlColumn, SqlResult

AUTH_HEADER = {"Authorization": "Bearer tr_sometoken"}
CALLER_PROJECT = "proj-A"


def make_auth(project_id: str = CALLER_PROJECT, billing_plan: str = "enterprise") -> AuthResult:
    return AuthResult(
        project_id=project_id,
        workspace_id="ws-1",
        billing_plan=billing_plan,
        ingestion_blocked=False,
    )


class StubService:
    """Stands in for SqlQueryService, recording how the router called it."""

    def __init__(self, result: Any = None, raises: Exception | None = None) -> None:
        self.result = result
        self.raises = raises
        self.calls: list[dict[str, Any]] = []

    def run(self, query, project_id, *, parameters=None, max_rows=None):
        self.calls.append(
            {
                "query": query,
                "project_id": project_id,
                "parameters": parameters,
                "max_rows": max_rows,
            }
        )
        if self.raises is not None:
            raise self.raises
        return self.result


def _ok_result(truncated: bool = False) -> SqlResult:
    return SqlResult(
        columns=[SqlColumn(name="span_id", type="String")],
        rows=[["s1"]],
        row_count=1,
        truncated=truncated,
        elapsed_ms=7,
        statistics={"rows_read": 42},
    )


@pytest.fixture()
def stub() -> StubService:
    return StubService(result=_ok_result())


@pytest.fixture()
def client(stub: StubService):
    app.dependency_overrides[authenticate_public_caller] = lambda: make_auth()
    original = sql_router.SqlQueryService
    sql_router.SqlQueryService = lambda *a, **kw: stub
    yield TestClient(app)
    sql_router.SqlQueryService = original
    app.dependency_overrides.clear()


# ---------------------------------------------------------------------------
# The happy path and the shape it returns
# ---------------------------------------------------------------------------
class TestSuccess:
    def test_a_query_returns_the_documented_shape(self, client: TestClient) -> None:
        resp = client.post(
            "/api/v1/public/sql", json={"query": "SELECT span_id FROM spans"}, headers=AUTH_HEADER
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["columns"] == [{"name": "span_id", "type": "String"}]
        assert body["rows"] == [["s1"]]
        assert body["row_count"] == 1
        assert body["truncated"] is False
        assert body["statistics"] == {"rows_read": 42}

    def test_truncation_reaches_the_caller(self, stub: StubService, client: TestClient) -> None:
        stub.result = _ok_result(truncated=True)
        resp = client.post(
            "/api/v1/public/sql", json={"query": "SELECT span_id FROM spans"}, headers=AUTH_HEADER
        )
        assert resp.json()["truncated"] is True

    def test_optional_fields_are_passed_through(
        self, stub: StubService, client: TestClient
    ) -> None:
        client.post(
            "/api/v1/public/sql",
            json={"query": "SELECT 1 FROM spans", "parameters": {"v": "x"}, "max_rows": 5},
            headers=AUTH_HEADER,
        )
        assert stub.calls[-1]["parameters"] == {"v": "x"}
        assert stub.calls[-1]["max_rows"] == 5


# ---------------------------------------------------------------------------
# The project comes from the credential, never from the request
# ---------------------------------------------------------------------------
class TestScopeIsServerSide:
    def test_the_credential_decides_the_project(
        self, stub: StubService, client: TestClient
    ) -> None:
        client.post(
            "/api/v1/public/sql", json={"query": "SELECT 1 FROM spans"}, headers=AUTH_HEADER
        )
        assert stub.calls[-1]["project_id"] == CALLER_PROJECT

    @pytest.mark.parametrize("key", ["project_id", "scope_project_id", "workspace_id"])
    def test_a_body_naming_a_project_is_refused(
        self, key: str, stub: StubService, client: TestClient
    ) -> None:
        # Forbidding unknown keys turns "choose my own tenant" into a 422 rather
        # than a field that is silently ignored.
        resp = client.post(
            "/api/v1/public/sql",
            json={"query": "SELECT 1 FROM spans", key: "somebody-else"},
            headers=AUTH_HEADER,
        )
        assert resp.status_code == 422
        assert not stub.calls

    def test_an_empty_query_is_refused_before_the_service(
        self, stub: StubService, client: TestClient
    ) -> None:
        resp = client.post("/api/v1/public/sql", json={"query": ""}, headers=AUTH_HEADER)
        assert resp.status_code == 422
        assert not stub.calls

    @pytest.mark.parametrize("max_rows", [0, -5, 2_000_000])
    def test_an_out_of_range_row_cap_is_refused(
        self, max_rows: int, stub: StubService, client: TestClient
    ) -> None:
        resp = client.post(
            "/api/v1/public/sql",
            json={"query": "SELECT 1 FROM spans", "max_rows": max_rows},
            headers=AUTH_HEADER,
        )
        assert resp.status_code == 422
        assert not stub.calls


# ---------------------------------------------------------------------------
# What each failure becomes, and what it is allowed to say
# ---------------------------------------------------------------------------
class TestErrorMapping:
    def test_a_rejected_query_is_a_client_error(
        self, stub: StubService, client: TestClient
    ) -> None:
        stub.raises = SqlValidationError("Table is not in the allowed public schema")
        resp = client.post(
            "/api/v1/public/sql", json={"query": "SELECT * FROM users"}, headers=AUTH_HEADER
        )
        assert resp.status_code == 400
        assert resp.json()["detail"] == "Table is not in the allowed public schema"

    def test_a_correctable_execution_failure_is_a_client_error(
        self, stub: StubService, client: TestClient
    ) -> None:
        stub.raises = SqlExecutionError(
            "Query exceeded the maximum execution time.", is_client_error=True
        )
        resp = client.post(
            "/api/v1/public/sql", json={"query": "SELECT 1 FROM spans"}, headers=AUTH_HEADER
        )
        assert resp.status_code == 400
        assert "execution time" in resp.json()["detail"]

    def test_an_uncorrectable_failure_is_a_server_error(
        self, stub: StubService, client: TestClient
    ) -> None:
        stub.raises = SqlExecutionError("Query execution failed.", is_client_error=False)
        resp = client.post(
            "/api/v1/public/sql", json={"query": "SELECT 1 FROM spans"}, headers=AUTH_HEADER
        )
        assert resp.status_code == 500
        assert resp.json()["detail"] == "Query execution failed."

    def test_an_unexpected_exception_tells_the_caller_nothing(
        self, stub: StubService, client: TestClient
    ) -> None:
        stub.raises = RuntimeError("connection to clickhouse-1.internal refused")
        resp = client.post(
            "/api/v1/public/sql", json={"query": "SELECT 1 FROM spans"}, headers=AUTH_HEADER
        )
        assert resp.status_code == 500
        assert resp.json()["detail"] == "Query execution failed."
        assert "clickhouse-1.internal" not in resp.text

    def test_no_failure_leaks_the_project_or_a_view_name(
        self, stub: StubService, client: TestClient
    ) -> None:
        stub.raises = RuntimeError(f"Code: 47 ... spans_public_v1(project_id = '{CALLER_PROJECT}')")
        resp = client.post(
            "/api/v1/public/sql", json={"query": "SELECT 1 FROM spans"}, headers=AUTH_HEADER
        )
        assert CALLER_PROJECT not in resp.text
        assert "spans_public_v1" not in resp.text


# ---------------------------------------------------------------------------
# The schema endpoint
# ---------------------------------------------------------------------------
class TestSchemaEndpoint:
    def test_it_lists_exactly_the_curated_tables(self, client: TestClient) -> None:
        resp = client.get("/api/v1/public/sql/schema", headers=AUTH_HEADER)
        assert resp.status_code == 200
        names = {t["name"] for t in resp.json()["tables"]}
        assert names == {"spans", "traces"}

    def test_it_never_advertises_the_tenant_column(self, client: TestClient) -> None:
        resp = client.get("/api/v1/public/sql/schema", headers=AUTH_HEADER)
        columns = {c["name"] for t in resp.json()["tables"] for c in t["columns"]}
        assert "project_id" not in columns
        assert {"span_id", "trace_id"} <= columns

    def test_it_reports_types(self, client: TestClient) -> None:
        resp = client.get("/api/v1/public/sql/schema", headers=AUTH_HEADER)
        spans = next(t for t in resp.json()["tables"] if t["name"] == "spans")
        assert any(c["name"] == "duration_ms" for c in spans["columns"])
        assert all(c["type"] for c in spans["columns"])


# ---------------------------------------------------------------------------
# Auth and the rate-limit bucket
# ---------------------------------------------------------------------------
class TestAuthAndRateLimiting:
    def test_an_unauthenticated_request_is_refused(self) -> None:
        # No dependency override here: the real auth dependency runs.
        app.dependency_overrides.clear()
        with TestClient(app) as anon:
            resp = anon.post("/api/v1/public/sql", json={"query": "SELECT 1 FROM spans"})
        assert resp.status_code in (401, 403)

    def test_sql_has_its_own_bucket(self) -> None:
        # Sharing the read bucket would let a handful of analytical queries drain
        # the quota that ordinary trace reads depend on.
        from unittest.mock import MagicMock

        from rest.rate_limit import BUCKET_SQL, key_sql

        request = MagicMock()
        request.state.rl_workspace_id = "ws-1"
        request.state.rl_billing_plan = "pro"
        request.state.rl_user_id = ""
        key = key_sql(request)
        assert key == "rl:sql:pro:ws-1"
        assert request.state.rl_bucket == BUCKET_SQL

    @pytest.mark.parametrize(
        ("plan", "expected"),
        [("free", "20/minute"), ("starter", "60/minute"), ("pro", "120/minute")],
    )
    def test_the_sql_bucket_is_tighter_than_reads(self, plan: str, expected: str) -> None:
        from rest.rate_limit import resolve_limit
        from shared.config import settings

        assert resolve_limit(f"rl:sql:{plan}:ws-1") == expected
        # And strictly tighter than the read budget for the same plan.
        read = settings.rate_limit.limit_for("read", plan)
        assert int(expected.split("/")[0]) < int(read.split("/")[0])
