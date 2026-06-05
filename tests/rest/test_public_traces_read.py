"""Unit tests for the public API-key-authenticated trace read endpoints.

GET /api/v1/public/traces and GET /api/v1/public/traces/{trace_id}. Reads are
scoped to the API key's project; the client never supplies a project id.
"""

from datetime import datetime
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

    def test_limit_over_200_rejected(self, client, mock_reader):
        resp = client.get("/api/v1/public/traces?limit=500", headers=AUTH_HEADER)
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
        assert data["trace_url"] == "http://localhost:3000/projects/proj-A/traces?traceId=abc123"

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
