"""Unit tests for the public trace export endpoint.

GET /api/v1/public/traces/{trace_id}/export. V1 bundle = trace + spans +
git_context + manifest (no logs/metrics/related). Scoped to the API key's
project. `bundle.trace` must equal the public `traces get` payload.
"""

import copy
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
        billing_plan="enterprise",
        ingestion_blocked=False,
    )


@pytest.fixture()
def mock_reader():
    reader = MagicMock()
    # Export defaults to the `full` projection, so it always runs the bulk
    # span-I/O reader. Default it to an empty map (no I/O) so tests that don't
    # care about I/O keep their span shapes; tests that assert I/O override it.
    reader.get_trace_spans_io.return_value = {}
    return reader


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

    def test_trace_url_uses_public_ui_url_not_internal(self, client, mock_reader, monkeypatch):
        """Export trace_url must use the host-usable public UI URL, never the
        internal backend-to-web URL (which can be a Docker service host)."""
        from shared.config import settings

        monkeypatch.setattr(settings, "traceroot_ui_url", "http://web:3000")
        monkeypatch.setattr(settings, "traceroot_public_ui_url", "http://localhost:3000")
        mock_reader.get_trace.return_value = dict(TRACE_DETAIL)
        body = client.get("/api/v1/public/traces/abc123/export", headers=AUTH).json()
        url = body["trace"]["trace_url"]
        assert url == "http://localhost:3000/projects/proj-A/traces?traceId=abc123"
        assert "web:3000" not in url

    def test_export_includes_span_io_by_default(self, client, mock_reader):
        """The core regression fix: export defaults to full fidelity, so spans.json
        carries real per-span input/output/metadata (not null)."""
        mock_reader.get_trace.return_value = copy.deepcopy(TRACE_DETAIL)
        mock_reader.get_trace_spans_io.return_value = {
            "span-1": {
                "input": '{"prompt": "hi"}',
                "output": '{"completion": "yo"}',
                "metadata": '{"k": "v"}',
            }
        }
        body = client.get("/api/v1/public/traces/abc123/export", headers=AUTH).json()
        span = body["spans"][0]
        assert span["input"] == '{"prompt": "hi"}'
        assert span["output"] == '{"completion": "yo"}'
        assert span["metadata"] == '{"k": "v"}'
        # spans.json still mirrors trace.spans at the same (full) projection.
        assert body["spans"] == body["trace"]["spans"]
        mock_reader.get_trace_spans_io.assert_called_once()

    def test_export_fields_skeleton_omits_io_and_skips_bulk(self, client, mock_reader):
        """Narrowing export to skeleton avoids the bulk I/O query and returns null I/O."""
        mock_reader.get_trace.return_value = copy.deepcopy(TRACE_DETAIL)
        body = client.get(
            "/api/v1/public/traces/abc123/export?fields=skeleton", headers=AUTH
        ).json()
        span = body["spans"][0]
        assert span["input"] is None
        assert span["output"] is None
        assert span["metadata"] is None
        mock_reader.get_trace_spans_io.assert_not_called()

    def test_export_fields_skeleton_drops_span_tree_metadata(self, client, mock_reader):
        """The reader's span-path subset (for the dashboard's live-tree repair)
        must not reach an export bundle that did not ask for metadata."""
        trace = copy.deepcopy(TRACE_DETAIL)
        trace["spans"][0]["metadata"] = (
            '{"traceroot.span.ids_path":["root-id"],"traceroot.span.path":["root","child"]}'
        )
        mock_reader.get_trace.return_value = trace
        body = client.get(
            "/api/v1/public/traces/abc123/export?fields=skeleton", headers=AUTH
        ).json()
        assert body["spans"][0]["metadata"] is None
        assert body["trace"]["spans"][0]["metadata"] is None

    def test_export_trace_equals_get_at_equal_fields(self, client, mock_reader):
        """The invariant holds at equal projection: export?fields=full == get?fields=full."""
        io_map = {
            "span-1": {"input": "i", "output": "o", "metadata": "m"},
        }
        mock_reader.get_trace.return_value = copy.deepcopy(TRACE_DETAIL)
        mock_reader.get_trace_spans_io.return_value = io_map
        got = client.get("/api/v1/public/traces/abc123?fields=full", headers=AUTH).json()
        mock_reader.get_trace.return_value = copy.deepcopy(TRACE_DETAIL)
        mock_reader.get_trace_spans_io.return_value = io_map
        exported = client.get(
            "/api/v1/public/traces/abc123/export?fields=full", headers=AUTH
        ).json()
        assert exported["trace"] == got

    def test_unknown_fields_returns_400(self, client, mock_reader):
        mock_reader.get_trace.return_value = dict(TRACE_DETAIL)
        resp = client.get("/api/v1/public/traces/abc123/export?fields=bogus", headers=AUTH)
        assert resp.status_code == 400
        mock_reader.get_trace_spans_io.assert_not_called()

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


class TestPublicUrlAcrossStack:
    """Top-of-stack guard: every client-facing URL the public API emits —
    whoami ``ui_base_url`` and the list/get/export ``trace_url`` — is built from
    the public UI URL, never the internal backend-to-web URL (``web:3000``)."""

    def test_all_public_urls_use_public_ui_url(self, client, mock_reader, monkeypatch):
        from shared.config import settings

        monkeypatch.setattr(settings, "traceroot_ui_url", "http://web:3000")
        monkeypatch.setattr(settings, "traceroot_public_ui_url", "http://localhost:3000")
        app.dependency_overrides[authenticate_api_key] = lambda: AuthResult(
            project_id="proj-A",
            workspace_id="ws-1",
            billing_plan="enterprise",
            ingestion_blocked=False,
            project_name="P",
            workspace_name="W",
            key_name="k",
            key_hint="tr_ab…yz",
        )
        mock_reader.list_traces.return_value = {
            "data": [dict(TRACE_LIST_ITEM)],
            "meta": {"page": 0, "limit": 50, "total": 1},
        }
        mock_reader.get_trace.return_value = dict(TRACE_DETAIL)

        whoami = client.get("/api/v1/public/whoami", headers=AUTH).json()
        listed = client.get("/api/v1/public/traces", headers=AUTH).json()
        got = client.get("/api/v1/public/traces/abc123", headers=AUTH).json()
        exported = client.get("/api/v1/public/traces/abc123/export", headers=AUTH).json()

        urls = [
            whoami["ui_base_url"],
            listed["data"][0]["trace_url"],
            got["trace_url"],
            exported["trace"]["trace_url"],
        ]
        for url in urls:
            assert url.startswith("http://localhost:3000")
            assert "web:3000" not in url
