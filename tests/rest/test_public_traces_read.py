"""Unit tests for the public API-key-authenticated trace read endpoints.

GET /api/v1/public/traces and GET /api/v1/public/traces/{trace_id}. Reads are
scoped to the API key's project; the client never supplies a project id.
"""

from datetime import UTC, datetime
from unittest.mock import MagicMock

import pytest
import respx
from fastapi.testclient import TestClient
from httpx import Response

from rest.main import app
from rest.routers.public.deps import AuthResult, authenticate_api_key

BASE_URL = "http://localhost:3000"

TRACE_LIST_ITEM = {
    "trace_id": "abc123",
    "project_id": "proj-A",
    "name": "test-trace",
    "trace_start_time": datetime(2024, 1, 15, 12, 0, 0),
    "user_id": "user-1",
    "session_id": None,
    "span_count": 3,
    "duration_ms": 1500.0,
    "error_count": 0,
    "input": "hello",
    "output": "world",
}

TRACE_DETAIL = {
    "trace_id": "abc123",
    "project_id": "proj-A",
    "name": "test-trace",
    "trace_start_time": datetime(2024, 1, 15, 12, 0, 0),
    "user_id": None,
    "session_id": None,
    "git_ref": "main",
    "git_repo": "org/repo",
    "input": "in",
    "output": "out",
    "metadata": "{}",
    "spans": [
        {
            "span_id": "span-1",
            "trace_id": "abc123",
            "parent_span_id": None,
            "name": "root-span",
            "span_kind": "SPAN",
            "span_start_time": datetime(2024, 1, 15, 12, 0, 0),
            "span_end_time": datetime(2024, 1, 15, 12, 0, 1),
            "status": "OK",
            "status_message": None,
            "model_name": None,
            "cost": None,
            "input_tokens": None,
            "output_tokens": None,
            "total_tokens": None,
            "input": None,
            "output": None,
            "metadata": None,
            "ids_path": [],
            "path": [],
        }
    ],
}


def make_auth(project_id: str = "proj-A") -> AuthResult:
    return AuthResult(
        project_id=project_id,
        workspace_id="ws-1",
        billing_plan="pro",
        ingestion_blocked=False,
    )


@pytest.fixture()
def mock_reader():
    return MagicMock()


@pytest.fixture()
def client(mock_reader):
    """TestClient with mocked API-key auth and trace reader."""
    app.dependency_overrides[authenticate_api_key] = lambda: make_auth()

    import rest.routers.public.traces_read as mod

    original = mod.get_trace_reader_service
    mod.get_trace_reader_service = lambda: mock_reader
    yield TestClient(app)
    mod.get_trace_reader_service = original


AUTH_HEADER = {"Authorization": "Bearer tr_sometoken"}


class TestPublicListTraces:
    def test_scopes_to_auth_project_id(self, client, mock_reader):
        mock_reader.list_traces.return_value = {
            "data": [],
            "meta": {"page": 0, "limit": 50, "total": 0},
        }
        resp = client.get("/api/v1/public/traces", headers=AUTH_HEADER)
        assert resp.status_code == 200
        assert mock_reader.list_traces.call_args.kwargs["project_id"] == "proj-A"

    def test_client_cannot_override_project_id(self, client, mock_reader):
        mock_reader.list_traces.return_value = {
            "data": [],
            "meta": {"page": 0, "limit": 50, "total": 0},
        }
        resp = client.get("/api/v1/public/traces?project_id=evil-project", headers=AUTH_HEADER)
        assert resp.status_code == 200
        # The client-supplied project_id is ignored; scope stays the key's project.
        assert mock_reader.list_traces.call_args.kwargs["project_id"] == "proj-A"

    def test_supports_limit(self, client, mock_reader):
        mock_reader.list_traces.return_value = {
            "data": [],
            "meta": {"page": 0, "limit": 5, "total": 0},
        }
        resp = client.get("/api/v1/public/traces?limit=5", headers=AUTH_HEADER)
        assert resp.status_code == 200
        assert mock_reader.list_traces.call_args.kwargs["limit"] == 5

    def test_no_status_filter_accepted_or_forwarded(self, client, mock_reader):
        mock_reader.list_traces.return_value = {
            "data": [],
            "meta": {"page": 0, "limit": 50, "total": 0},
        }
        resp = client.get("/api/v1/public/traces?status=error", headers=AUTH_HEADER)
        assert resp.status_code == 200
        # No status filter exists in V1: it is neither a parameter nor forwarded.
        assert "status" not in mock_reader.list_traces.call_args.kwargs

    def test_items_include_backend_built_trace_url(self, client, mock_reader):
        mock_reader.list_traces.return_value = {
            "data": [dict(TRACE_LIST_ITEM)],
            "meta": {"page": 0, "limit": 50, "total": 1},
        }
        resp = client.get("/api/v1/public/traces", headers=AUTH_HEADER)
        assert resp.status_code == 200
        item = resp.json()["data"][0]
        assert item["trace_url"] == "http://localhost:3000/projects/proj-A/traces?traceId=abc123"
        assert "status" not in item

    def test_trace_url_uses_public_ui_url_not_internal(self, client, mock_reader, monkeypatch):
        """List trace_url must use the host-usable public UI URL, never the
        internal backend-to-web URL (which can be a Docker service host)."""
        from shared.config import settings

        monkeypatch.setattr(settings, "traceroot_ui_url", "http://web:3000")
        monkeypatch.setattr(settings, "traceroot_public_ui_url", "http://localhost:3000")
        mock_reader.list_traces.return_value = {
            "data": [dict(TRACE_LIST_ITEM)],
            "meta": {"page": 0, "limit": 50, "total": 1},
        }
        resp = client.get("/api/v1/public/traces", headers=AUTH_HEADER)
        assert resp.status_code == 200
        url = resp.json()["data"][0]["trace_url"]
        assert url == "http://localhost:3000/projects/proj-A/traces?traceId=abc123"
        assert "web:3000" not in url

    def test_limit_over_200_rejected(self, client, mock_reader):
        resp = client.get("/api/v1/public/traces?limit=500", headers=AUTH_HEADER)
        assert resp.status_code == 422

    def test_forwards_start_after_and_end_before(self, client, mock_reader):
        mock_reader.list_traces.return_value = {
            "data": [],
            "meta": {"page": 0, "limit": 50, "total": 0},
        }
        resp = client.get(
            "/api/v1/public/traces"
            "?start_after=2024-01-01T00:00:00Z&end_before=2024-01-31T23:59:59Z",
            headers=AUTH_HEADER,
        )
        assert resp.status_code == 200
        kwargs = mock_reader.list_traces.call_args.kwargs
        assert kwargs["start_after"] == datetime(2024, 1, 1, 0, 0, 0, tzinfo=UTC)
        assert kwargs["end_before"] == datetime(2024, 1, 31, 23, 59, 59, tzinfo=UTC)

    def test_time_range_defaults_to_none_when_absent(self, client, mock_reader):
        mock_reader.list_traces.return_value = {
            "data": [],
            "meta": {"page": 0, "limit": 50, "total": 0},
        }
        resp = client.get("/api/v1/public/traces", headers=AUTH_HEADER)
        assert resp.status_code == 200
        kwargs = mock_reader.list_traces.call_args.kwargs
        assert kwargs["start_after"] is None
        assert kwargs["end_before"] is None

    def test_invalid_start_after_rejected(self, client, mock_reader):
        resp = client.get("/api/v1/public/traces?start_after=not-a-date", headers=AUTH_HEADER)
        assert resp.status_code == 422

    def test_reader_error_returns_generic_500(self, client, mock_reader):
        """A reader failure surfaces as a controlled 500 with no internal detail."""
        mock_reader.list_traces.side_effect = Exception("ClickHouse down")
        resp = client.get("/api/v1/public/traces", headers=AUTH_HEADER)
        assert resp.status_code == 500
        assert resp.json()["detail"] == "Failed to list traces"


class TestPublicGetTrace:
    def test_scopes_to_auth_project_id(self, client, mock_reader):
        mock_reader.get_trace.return_value = dict(TRACE_DETAIL)
        resp = client.get("/api/v1/public/traces/abc123", headers=AUTH_HEADER)
        assert resp.status_code == 200
        kw = mock_reader.get_trace.call_args.kwargs
        assert kw["project_id"] == "proj-A"
        assert kw["trace_id"] == "abc123"

    def test_returns_full_payload_with_trace_url(self, client, mock_reader):
        mock_reader.get_trace.return_value = dict(TRACE_DETAIL)
        resp = client.get("/api/v1/public/traces/abc123", headers=AUTH_HEADER)
        assert resp.status_code == 200
        data = resp.json()
        assert data["trace_id"] == "abc123"
        assert data["git_ref"] == "main"
        assert data["metadata"] == "{}"
        assert len(data["spans"]) == 1
        assert data["spans"][0]["span_id"] == "span-1"
        # ids_path/path (#1498): always present on the public span payload,
        # defaulting to [] for a root span with no ancestors.
        assert data["spans"][0]["ids_path"] == []
        assert data["spans"][0]["path"] == []
        assert data["trace_url"] == "http://localhost:3000/projects/proj-A/traces?traceId=abc123"

    def test_trace_url_uses_public_ui_url_not_internal(self, client, mock_reader, monkeypatch):
        """Get trace_url must use the host-usable public UI URL, never the
        internal backend-to-web URL (which can be a Docker service host)."""
        from shared.config import settings

        monkeypatch.setattr(settings, "traceroot_ui_url", "http://web:3000")
        monkeypatch.setattr(settings, "traceroot_public_ui_url", "http://localhost:3000")
        mock_reader.get_trace.return_value = dict(TRACE_DETAIL)
        url = client.get("/api/v1/public/traces/abc123", headers=AUTH_HEADER).json()["trace_url"]
        assert url == "http://localhost:3000/projects/proj-A/traces?traceId=abc123"
        assert "web:3000" not in url

    def test_default_is_skeleton_with_null_io_and_no_bulk_query(self, client, mock_reader):
        """Public get defaults to skeleton: spans carry null I/O and the bulk
        span-I/O query is never issued (no dashboard-class read)."""
        mock_reader.get_trace.return_value = dict(TRACE_DETAIL)
        resp = client.get("/api/v1/public/traces/abc123", headers=AUTH_HEADER)
        assert resp.status_code == 200
        span = resp.json()["spans"][0]
        assert span["input"] is None
        assert span["output"] is None
        assert span["metadata"] is None
        mock_reader.get_trace_spans_io.assert_not_called()

    def test_fields_full_includes_span_io(self, client, mock_reader):
        mock_reader.get_trace.return_value = dict(TRACE_DETAIL)
        mock_reader.get_trace_spans_io.return_value = {
            "span-1": {"input": "the-in", "output": "the-out", "metadata": "the-meta"}
        }
        resp = client.get("/api/v1/public/traces/abc123?fields=full", headers=AUTH_HEADER)
        assert resp.status_code == 200
        span = resp.json()["spans"][0]
        assert span["input"] == "the-in"
        assert span["output"] == "the-out"
        assert span["metadata"] == "the-meta"
        mock_reader.get_trace_spans_io.assert_called_once()

    def test_unknown_fields_returns_400(self, client, mock_reader):
        mock_reader.get_trace.return_value = dict(TRACE_DETAIL)
        resp = client.get("/api/v1/public/traces/abc123?fields=bogus", headers=AUTH_HEADER)
        assert resp.status_code == 400
        assert "bogus" in resp.json()["detail"]
        mock_reader.get_trace_spans_io.assert_not_called()

    def test_404_when_trace_missing(self, client, mock_reader):
        mock_reader.get_trace.return_value = None
        resp = client.get("/api/v1/public/traces/nonexistent", headers=AUTH_HEADER)
        assert resp.status_code == 404

    def test_reader_error_returns_generic_500(self, client, mock_reader):
        """A reader failure surfaces as a controlled 500, matching `list_traces`."""
        mock_reader.get_trace.side_effect = Exception("ClickHouse down")
        resp = client.get("/api/v1/public/traces/abc123", headers=AUTH_HEADER)
        assert resp.status_code == 500
        assert resp.json()["detail"] == "Failed to get trace"


class TestPublicTraceReadAuth:
    def test_missing_api_key_returns_401(self):
        test_client = TestClient(app, raise_server_exceptions=False)
        resp = test_client.get("/api/v1/public/traces")
        assert resp.status_code == 401

    @respx.mock
    def test_invalid_api_key_returns_401(self):
        respx.post(f"{BASE_URL}/api/internal/validate-api-key").mock(
            return_value=Response(200, json={"valid": False, "error": "Invalid API key"})
        )
        test_client = TestClient(app, raise_server_exceptions=False)
        resp = test_client.get(
            "/api/v1/public/traces/abc123",
            headers={"Authorization": "Bearer bad-key"},
        )
        assert resp.status_code == 401


class TestPublicReadRateLimiting:
    """Every public read route must be wired into the shared rate limiter.

    Importing ``rest.main`` registers each decorated endpoint on the module-level
    limiter (registration happens regardless of whether enforcement is enabled in
    this env). Asserting on the registry guards against a route silently shipping
    undecorated — the exact gap this change closes. The per-bucket enforcement
    behavior itself is covered in ``test_rate_limit.py``.
    """

    def test_list_get_export_routes_are_registered_with_the_limiter(self):
        from rest.rate_limit import limiter

        registered = set(limiter._dynamic_route_limits)
        assert "rest.routers.public.traces_read.list_traces" in registered
        assert "rest.routers.public.traces_read.get_trace" in registered
        assert "rest.routers.public.traces_read.export_trace" in registered

    def test_success_path_returns_200_with_headers_when_limiter_enabled(
        self, client, mock_reader, monkeypatch
    ):
        """With the limiter enabled (cloud), every successful read must still 200
        and carry X-RateLimit-* headers.

        slowapi injects those headers after the body runs (headers_enabled=True),
        which requires each rate-limited route to declare a ``response: Response``
        param — without it the success path raises *outside* the fail-open guard
        and 500s every call. The default test env disables the limiter, so this
        drives the REAL routes through an enabled module limiter to catch it.
        """
        import rest.rate_limit as rate_limit

        monkeypatch.setattr(rate_limit.limiter, "enabled", True)
        mock_reader.list_traces.return_value = {
            "data": [],
            "meta": {"page": 0, "limit": 50, "total": 0},
        }
        mock_reader.get_trace.return_value = TRACE_DETAIL

        # list + get share the `read` bucket; export uses its own `.limit` bucket —
        # covers both decorator forms through the success/header-injection path.
        responses = {
            "list": client.get("/api/v1/public/traces", headers=AUTH_HEADER),
            "get": client.get("/api/v1/public/traces/abc123", headers=AUTH_HEADER),
            "export": client.get("/api/v1/public/traces/abc123/export", headers=AUTH_HEADER),
        }
        for name, resp in responses.items():
            assert resp.status_code == 200, f"{name}: {resp.text}"
            assert "X-RateLimit-Limit" in resp.headers, name
