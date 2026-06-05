"""Unit tests for the public trace export endpoint.

GET /api/v1/public/traces/{trace_id}/export. V1 bundle = trace + spans +
git_context + manifest (no logs/metrics/related). Scoped to the API key's
project. `bundle.trace` must equal the public `traces get` payload.
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
            "status": "ERROR",
            "status_message": "boom",
            "model_name": None,
            "cost": None,
            "input_tokens": None,
            "output_tokens": None,
            "total_tokens": None,
            "input": None,
            "output": None,
            "metadata": None,
            "git_source_file": "app/main.py",
            "git_source_line": 42,
            "git_source_function": "handler",
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
    app.dependency_overrides[authenticate_api_key] = lambda: make_auth()

    import rest.routers.public.traces_read as mod

    original = mod.get_trace_reader_service
    mod.get_trace_reader_service = lambda: mock_reader
    yield TestClient(app)
    mod.get_trace_reader_service = original


AUTH = {"Authorization": "Bearer tr_sometoken"}


class TestExportBundle:
    def test_returns_v1_bundle_parts(self, client, mock_reader):
        mock_reader.get_trace.return_value = dict(TRACE_DETAIL)
        resp = client.get("/api/v1/public/traces/abc123/export", headers=AUTH)
        assert resp.status_code == 200
        body = resp.json()
        assert set(body.keys()) == {"manifest", "trace", "spans", "git_context"}

    def test_manifest_lists_only_v1_files(self, client, mock_reader):
        mock_reader.get_trace.return_value = dict(TRACE_DETAIL)
        manifest = client.get("/api/v1/public/traces/abc123/export", headers=AUTH).json()[
            "manifest"
        ]
        assert manifest["files"] == [
            "trace.json",
            "spans.json",
            "git_context.json",
            "manifest.json",
        ]
        assert manifest["trace_id"] == "abc123"
        assert manifest["project_id"] == "proj-A"
        # excluded deferred files
        for excluded in ("logs.json", "metrics.json", "related_context.json"):
            assert excluded not in manifest["files"]

    def test_export_trace_equals_get_payload(self, client, mock_reader):
        mock_reader.get_trace.return_value = dict(TRACE_DETAIL)
        got = client.get("/api/v1/public/traces/abc123", headers=AUTH).json()
        mock_reader.get_trace.return_value = dict(TRACE_DETAIL)
        exported = client.get("/api/v1/public/traces/abc123/export", headers=AUTH).json()
        assert exported["trace"] == got

    def test_spans_match_trace_spans(self, client, mock_reader):
        mock_reader.get_trace.return_value = dict(TRACE_DETAIL)
        body = client.get("/api/v1/public/traces/abc123/export", headers=AUTH).json()
        assert body["spans"] == body["trace"]["spans"]
        assert body["spans"][0]["span_id"] == "span-1"

    def test_git_context_from_trace_and_spans(self, client, mock_reader):
        mock_reader.get_trace.return_value = dict(TRACE_DETAIL)
        gc = client.get("/api/v1/public/traces/abc123/export", headers=AUTH).json()["git_context"]
        assert gc["git_repo"] == "org/repo"
        assert gc["git_ref"] == "main"
        assert gc["sources"] == [
            {"span_id": "span-1", "file": "app/main.py", "line": 42, "function": "handler"}
        ]

    def test_git_context_omits_spans_without_git_fields(self, client, mock_reader):
        gitless = {
            **TRACE_DETAIL["spans"][0],
            "span_id": "span-2",
            "git_source_file": None,
            "git_source_line": None,
            "git_source_function": None,
        }
        trace = {**TRACE_DETAIL, "spans": [TRACE_DETAIL["spans"][0], gitless]}
        mock_reader.get_trace.return_value = trace
        gc = client.get("/api/v1/public/traces/abc123/export", headers=AUTH).json()["git_context"]
        assert [s["span_id"] for s in gc["sources"]] == ["span-1"]

    def test_git_context_typed_empty_when_no_git(self, client, mock_reader):
        """A trace with no git data yields a stable, typed-empty git_context."""
        gitless_span = {
            **TRACE_DETAIL["spans"][0],
            "git_source_file": None,
            "git_source_line": None,
            "git_source_function": None,
        }
        trace = {**TRACE_DETAIL, "git_ref": None, "git_repo": None, "spans": [gitless_span]}
        mock_reader.get_trace.return_value = trace
        gc = client.get("/api/v1/public/traces/abc123/export", headers=AUTH).json()["git_context"]
        assert gc == {"git_repo": None, "git_ref": None, "sources": []}

    def test_export_spans_equal_public_get_spans(self, client, mock_reader):
        """spans.json matches the spans from the public `traces get` payload."""
        mock_reader.get_trace.return_value = dict(TRACE_DETAIL)
        get_spans = client.get("/api/v1/public/traces/abc123", headers=AUTH).json()["spans"]
        mock_reader.get_trace.return_value = dict(TRACE_DETAIL)
        export_spans = client.get("/api/v1/public/traces/abc123/export", headers=AUTH).json()[
            "spans"
        ]
        assert export_spans == get_spans

    def test_scopes_to_auth_project_id(self, client, mock_reader):
        mock_reader.get_trace.return_value = dict(TRACE_DETAIL)
        client.get("/api/v1/public/traces/abc123/export?project_id=evil", headers=AUTH)
        kw = mock_reader.get_trace.call_args.kwargs
        assert kw["project_id"] == "proj-A"
        assert kw["trace_id"] == "abc123"

    def test_trace_url_present(self, client, mock_reader):
        mock_reader.get_trace.return_value = dict(TRACE_DETAIL)
        body = client.get("/api/v1/public/traces/abc123/export", headers=AUTH).json()
        assert (
            body["trace"]["trace_url"]
            == "http://localhost:3000/projects/proj-A/traces?traceId=abc123"
        )

    def test_404_when_missing(self, client, mock_reader):
        mock_reader.get_trace.return_value = None
        resp = client.get("/api/v1/public/traces/nope/export", headers=AUTH)
        assert resp.status_code == 404


class TestExportAuth:
    def test_missing_api_key_returns_401(self):
        test_client = TestClient(app, raise_server_exceptions=False)
        resp = test_client.get("/api/v1/public/traces/abc123/export")
        assert resp.status_code == 401

    @respx.mock
    def test_invalid_api_key_returns_401(self):
        respx.post(f"{BASE_URL}/api/internal/validate-api-key").mock(
            return_value=Response(200, json={"valid": False, "error": "Invalid API key"})
        )
        test_client = TestClient(app, raise_server_exceptions=False)
        resp = test_client.get(
            "/api/v1/public/traces/abc123/export",
            headers={"Authorization": "Bearer bad"},
        )
        assert resp.status_code == 401
