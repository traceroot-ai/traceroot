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

    def test_a_query_past_the_length_cap_is_refused_before_the_service(
        self, stub: StubService, client: TestClient
    ) -> None:
        # Parsing runs before any database cap, and its cost grows with the query.
        from rest.schemas.public import SQL_QUERY_MAX_CHARS

        base = "SELECT 1 FROM spans WHERE name = '"
        at_cap = base + "x" * (SQL_QUERY_MAX_CHARS - len(base) - 1) + "'"
        assert len(at_cap) == SQL_QUERY_MAX_CHARS

        too_long = client.post(
            "/api/v1/public/sql", json={"query": at_cap + " "}, headers=AUTH_HEADER
        )
        assert too_long.status_code == 422
        assert not stub.calls

        accepted = client.post("/api/v1/public/sql", json={"query": at_cap}, headers=AUTH_HEADER)
        assert accepted.status_code == 200
        assert stub.calls

    def test_more_parameters_than_the_cap_are_refused(
        self, stub: StubService, client: TestClient
    ) -> None:
        from rest.schemas.public import SQL_MAX_PARAMETERS

        def post(count: int):
            params = {f"p{i}": i for i in range(count)}
            return client.post(
                "/api/v1/public/sql",
                json={"query": "SELECT 1 FROM spans", "parameters": params},
                headers=AUTH_HEADER,
            )

        assert post(SQL_MAX_PARAMETERS + 1).status_code == 422
        assert not stub.calls
        assert post(SQL_MAX_PARAMETERS).status_code == 200

    def test_an_oversized_parameter_payload_is_refused(
        self, stub: StubService, client: TestClient
    ) -> None:
        # One key is enough to carry a payload nothing else bounds.
        from rest.schemas.public import SQL_PARAMETERS_MAX_CHARS

        big = client.post(
            "/api/v1/public/sql",
            json={
                "query": "SELECT 1 FROM spans",
                "parameters": {"p": "x" * SQL_PARAMETERS_MAX_CHARS},
            },
            headers=AUTH_HEADER,
        )
        assert big.status_code == 422
        assert not stub.calls

        nested = client.post(
            "/api/v1/public/sql",
            json={
                "query": "SELECT 1 FROM spans",
                "parameters": {"p": [["y" * 512] * 8] * 8},
            },
            headers=AUTH_HEADER,
        )
        assert nested.status_code == 422
        assert not stub.calls

        ok = client.post(
            "/api/v1/public/sql",
            json={"query": "SELECT 1 FROM spans", "parameters": {"ids": ["a", "b"], "n": 5}},
            headers=AUTH_HEADER,
        )
        assert ok.status_code == 200
        assert stub.calls[-1]["parameters"] == {"ids": ["a", "b"], "n": 5}

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


# ---------------------------------------------------------------------------
# Findings from review: the third refusal end to end, strict row cap, no blocking
# ---------------------------------------------------------------------------
class RecordingClient:
    """A fake database client, so the real service runs behind the real router."""

    def __init__(self) -> None:
        self.calls: list[Any] = []

    def query(self, query, parameters=None, settings=None):  # pragma: no cover - must not run
        self.calls.append(parameters)
        raise AssertionError("the database must not be reached")


@pytest.fixture()
def real_service_client():
    """TestClient wired to the real SqlQueryService over a fake database client."""
    from rest.services.sql.service import SqlQueryService as RealService

    fake_db = RecordingClient()
    app.dependency_overrides[authenticate_public_caller] = lambda: make_auth()
    original = sql_router.SqlQueryService
    sql_router.SqlQueryService = lambda *a, **kw: RealService(fake_db, max_rows_ceiling=100)
    yield TestClient(app), fake_db
    sql_router.SqlQueryService = original
    app.dependency_overrides.clear()


class TestReviewFindings:
    @pytest.mark.parametrize("name", ["project_id", "scope_project_id", "SCOPE_anything"])
    def test_a_reserved_parameter_name_is_refused_through_http(
        self, name: str, real_service_client
    ) -> None:
        # The third of the three refusals, exercised end to end rather than with the
        # service stubbed out: the body model admits `parameters`, so only the
        # service stands between this payload and the scope bind.
        client, fake_db = real_service_client
        resp = client.post(
            "/api/v1/public/sql",
            json={"query": "SELECT span_id FROM spans", "parameters": {name: "other"}},
            headers=AUTH_HEADER,
        )
        assert resp.status_code == 400
        assert "reserved name" in resp.json()["detail"]
        assert not fake_db.calls

    @pytest.mark.parametrize("value", [True, False, 1.0, "5"])
    def test_a_non_integer_row_cap_is_refused(
        self, value: Any, stub: StubService, client: TestClient
    ) -> None:
        # Lax coercion would turn `true` into 1 and run the query.
        resp = client.post(
            "/api/v1/public/sql",
            json={"query": "SELECT 1 FROM spans", "max_rows": value},
            headers=AUTH_HEADER,
        )
        assert resp.status_code == 422
        assert not stub.calls

    def test_the_query_runs_off_the_event_loop(self, stub: StubService, client: TestClient) -> None:
        # A blocking driver call made inside an async handler stalls every request
        # on the worker. "Not the main thread" is not enough to prove otherwise:
        # TestClient already runs the handler on an asyncio portal thread, so a
        # direct call passes that check too. The worker pool's thread name is the
        # distinguishing signal.
        import threading

        seen: dict[str, Any] = {}
        original_run = stub.run

        def recording_run(*args, **kwargs):
            seen["thread"] = threading.current_thread()
            return original_run(*args, **kwargs)

        stub.run = recording_run
        client.post(
            "/api/v1/public/sql", json={"query": "SELECT 1 FROM spans"}, headers=AUTH_HEADER
        )
        assert seen["thread"].name.startswith("AnyIO worker thread"), seen["thread"].name

    def test_the_error_responses_are_documented(self) -> None:
        # The CLI generates its client from this spec.
        responses = app.openapi()["paths"]["/api/v1/public/sql"]["post"]["responses"]
        assert {"400", "401", "403", "422", "429", "500"} <= set(responses)

    def test_the_schema_errors_are_documented(self) -> None:
        responses = app.openapi()["paths"]["/api/v1/public/sql/schema"]["get"]["responses"]
        assert {"400", "401", "403", "422", "429"} <= set(responses)

    @pytest.mark.parametrize(
        ("path", "method"), [("/api/v1/public/sql", "post"), ("/api/v1/public/sql/schema", "get")]
    )
    def test_validation_errors_are_documented_as_the_string_envelope(
        self, path: str, method: str
    ) -> None:
        # Public routes answer 422 with {"detail": "<string>"}, not FastAPI's list.
        schema = app.openapi()["paths"][path][method]["responses"]["422"]
        ref = schema["content"]["application/json"]["schema"]["$ref"]
        assert ref.endswith("/ErrorResponse")


# ---------------------------------------------------------------------------
# Concurrency: a dedicated, bounded lane for queries
# ---------------------------------------------------------------------------
@pytest.fixture()
def gate(monkeypatch: pytest.MonkeyPatch) -> sql_router._QueryGate:
    fresh = sql_router._QueryGate(total=4, per_project=2)
    monkeypatch.setattr(sql_router, "_gate", fresh)
    return fresh


def test_the_gate_builds_no_limiter_until_a_query_needs_one(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Module import constructs the gate, so it must not need an event loop.
    def refuse(*_args: Any, **_kwargs: Any) -> None:
        raise AssertionError("limiter built at construction")

    monkeypatch.setattr(sql_router.anyio, "CapacityLimiter", refuse)
    sql_router._QueryGate(total=4, per_project=2)


def _post(client: TestClient):
    return client.post(
        "/api/v1/public/sql", json={"query": "SELECT 1 FROM spans"}, headers=AUTH_HEADER
    )


class TestQueryGate:
    def test_a_project_at_its_share_is_refused_while_others_still_run(
        self, gate: sql_router._QueryGate, stub: StubService, client: TestClient
    ) -> None:
        gate.in_flight[CALLER_PROJECT] = gate.per_project
        resp = _post(client)
        assert resp.status_code == 429
        assert resp.headers["Retry-After"] == "1"
        assert not stub.calls

        app.dependency_overrides[authenticate_public_caller] = lambda: make_auth("proj-B")
        assert _post(client).status_code == 200

    def test_a_full_process_refuses_every_project(
        self, gate: sql_router._QueryGate, stub: StubService, client: TestClient
    ) -> None:
        gate.in_flight.update({"proj-X": 2, "proj-Y": 2})
        assert _post(client).status_code == 429
        assert not stub.calls

    @pytest.mark.parametrize(
        "raises",
        [
            None,
            SqlValidationError("nope"),
            SqlExecutionError("bad column", is_client_error=True),
            SqlExecutionError("boom", is_client_error=False),
            RuntimeError("unexpected"),
        ],
    )
    def test_the_slot_is_released_however_the_query_ends(
        self,
        raises: Exception | None,
        gate: sql_router._QueryGate,
        stub: StubService,
        client: TestClient,
    ) -> None:
        stub.raises = raises
        _post(client)
        assert stub.calls
        assert not gate.in_flight

    def test_queries_do_not_draw_on_the_shared_worker_pool(
        self, gate: sql_router._QueryGate, stub: StubService, client: TestClient
    ) -> None:
        import anyio.from_thread
        import anyio.to_thread

        seen: dict[str, int] = {}
        original_run = stub.run

        def recording_run(*args, **kwargs):
            seen["shared"] = anyio.from_thread.run_sync(
                lambda: anyio.to_thread.current_default_thread_limiter().borrowed_tokens
            )
            seen["gate"] = anyio.from_thread.run_sync(lambda: gate.limiter.borrowed_tokens)
            return original_run(*args, **kwargs)

        stub.run = recording_run
        assert _post(client).status_code == 200
        assert seen == {"shared": 0, "gate": 1}
