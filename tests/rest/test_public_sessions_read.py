"""Unit tests for the public API-key-authenticated session read endpoints.

GET /api/v1/public/sessions and GET /api/v1/public/sessions/{session_id}.
Reads are scoped to the API key's project; the client never supplies a
project id.
"""

from datetime import UTC, datetime, timedelta
from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient

from rest.main import app
from rest.retention import get_retention_cutoff
from rest.routers.public.deps import AuthResult, authenticate_public_caller

SESSION_LIST = {
    "data": [
        {
            "session_id": "sess-1",
            "trace_count": 2,
            "user_ids": ["u1"],
            "first_trace_time": datetime(2024, 1, 15, 12, 0, 0),
            "last_trace_time": datetime(2024, 1, 15, 12, 5, 0),
            "duration_ms": 300000.0,
            "total_input_tokens": 10,
            "total_output_tokens": 20,
            "total_cost": 0.01,
            "input": "hi",
            "output": "yo",
        }
    ],
    "meta": {"page": 0, "limit": 50, "total": 1},
}

SESSION_DETAIL = {
    "session_id": "sess-1",
    "traces": [
        {
            "trace_id": "t1",
            "name": "turn",
            "trace_start_time": datetime(2024, 1, 15, 12, 0, 0),
            "user_id": "u1",
            "input": "hi",
            "output": "yo",
            "duration_ms": 1500.0,
            "status": "ok",
        }
    ],
    "user_ids": ["u1"],
    "trace_count": 1,
    "first_trace_time": datetime(2024, 1, 15, 12, 0, 0),
    "last_trace_time": datetime(2024, 1, 15, 12, 0, 2),
    "duration_ms": 2000.0,
    "total_input_tokens": 10,
    "total_output_tokens": 20,
    "total_cost": 0.01,
}


def make_auth(project_id: str = "proj-A", billing_plan: str = "enterprise") -> AuthResult:
    return AuthResult(
        project_id=project_id,
        workspace_id="ws-1",
        billing_plan=billing_plan,
        ingestion_blocked=False,
    )


@pytest.fixture()
def mock_reader():
    return MagicMock()


def _client_with(mock_reader, billing_plan: str = "enterprise"):
    app.dependency_overrides[authenticate_public_caller] = lambda: make_auth(
        billing_plan=billing_plan
    )
    import rest.routers.public.sessions_read as mod

    original = mod.get_trace_reader_service
    mod.get_trace_reader_service = lambda: mock_reader
    return TestClient(app), mod, original


@pytest.fixture()
def client(mock_reader):
    """TestClient with mocked API-key auth and trace reader."""
    tc, mod, original = _client_with(mock_reader)
    yield tc
    mod.get_trace_reader_service = original
    app.dependency_overrides.clear()


AUTH_HEADER = {"Authorization": "Bearer tr_sometoken"}


class TestPublicListSessions:
    def test_scopes_to_auth_project_id(self, client, mock_reader):
        mock_reader.list_sessions.return_value = SESSION_LIST
        resp = client.get("/api/v1/public/sessions", headers=AUTH_HEADER)
        assert resp.status_code == 200
        assert mock_reader.list_sessions.call_args.kwargs["project_id"] == "proj-A"

    def test_client_cannot_override_project_id(self, client, mock_reader):
        mock_reader.list_sessions.return_value = SESSION_LIST
        resp = client.get("/api/v1/public/sessions?project_id=evil", headers=AUTH_HEADER)
        assert resp.status_code == 200
        assert mock_reader.list_sessions.call_args.kwargs["project_id"] == "proj-A"

    def test_forwards_limit_and_search_query(self, client, mock_reader):
        mock_reader.list_sessions.return_value = SESSION_LIST
        resp = client.get("/api/v1/public/sessions?limit=5&search_query=abc", headers=AUTH_HEADER)
        assert resp.status_code == 200
        kwargs = mock_reader.list_sessions.call_args.kwargs
        assert kwargs["limit"] == 5
        assert kwargs["search_query"] == "abc"

    def test_free_plan_clamps_start_after_to_retention_cutoff(self, mock_reader):
        tc, mod, original = _client_with(mock_reader, billing_plan="free")
        try:
            mock_reader.list_sessions.return_value = SESSION_LIST
            old = (datetime.now(UTC) - timedelta(days=400)).replace(tzinfo=None)
            resp = tc.get(
                f"/api/v1/public/sessions?start_after={old.isoformat()}",
                headers=AUTH_HEADER,
            )
            assert resp.status_code == 200
            sent = mock_reader.list_sessions.call_args.kwargs["start_after"]
            cutoff = get_retention_cutoff("free")
            # Clamped to the plan cutoff (allow a few seconds of clock skew
            # between the route call and this assertion).
            assert abs((sent - cutoff).total_seconds()) < 10
        finally:
            mod.get_trace_reader_service = original
            app.dependency_overrides.clear()

    def test_500_on_reader_failure(self, client, mock_reader):
        mock_reader.list_sessions.side_effect = RuntimeError("boom")
        resp = client.get("/api/v1/public/sessions", headers=AUTH_HEADER)
        assert resp.status_code == 500
        assert resp.json()["detail"] == "Failed to list sessions"


class TestPublicGetSession:
    def test_scopes_to_auth_project_id(self, client, mock_reader):
        mock_reader.get_session.return_value = SESSION_DETAIL
        resp = client.get("/api/v1/public/sessions/sess-1", headers=AUTH_HEADER)
        assert resp.status_code == 200
        kwargs = mock_reader.get_session.call_args.kwargs
        assert kwargs["project_id"] == "proj-A"
        assert kwargs["session_id"] == "sess-1"
        assert resp.json()["session_id"] == "sess-1"

    def test_forwards_time_bounds(self, client, mock_reader):
        mock_reader.get_session.return_value = SESSION_DETAIL
        resp = client.get(
            "/api/v1/public/sessions/sess-1"
            "?start_after=2024-01-01T00:00:00&end_before=2024-02-01T00:00:00",
            headers=AUTH_HEADER,
        )
        assert resp.status_code == 200
        kwargs = mock_reader.get_session.call_args.kwargs
        # Enterprise plan has no retention cutoff, so the bounds pass through verbatim.
        assert kwargs["start_after"] == datetime(2024, 1, 1, 0, 0, 0)
        assert kwargs["end_before"] == datetime(2024, 2, 1, 0, 0, 0)

    def test_free_plan_clamps_start_after_to_retention_cutoff(self, mock_reader):
        tc, mod, original = _client_with(mock_reader, billing_plan="free")
        try:
            mock_reader.get_session.return_value = SESSION_DETAIL
            old = (datetime.now(UTC) - timedelta(days=400)).replace(tzinfo=None)
            resp = tc.get(
                f"/api/v1/public/sessions/sess-1?start_after={old.isoformat()}",
                headers=AUTH_HEADER,
            )
            assert resp.status_code == 200
            sent = mock_reader.get_session.call_args.kwargs["start_after"]
            cutoff = get_retention_cutoff("free")
            # Clamped to the plan cutoff (allow a few seconds of clock skew
            # between the route call and this assertion).
            assert abs((sent - cutoff).total_seconds()) < 10
        finally:
            mod.get_trace_reader_service = original
            app.dependency_overrides.clear()

    def test_404_when_missing(self, client, mock_reader):
        mock_reader.get_session.return_value = None
        resp = client.get("/api/v1/public/sessions/nope", headers=AUTH_HEADER)
        assert resp.status_code == 404
        assert resp.json()["detail"] == "Session not found"

    def test_500_on_reader_failure(self, client, mock_reader):
        mock_reader.get_session.side_effect = RuntimeError("boom")
        resp = client.get("/api/v1/public/sessions/sess-1", headers=AUTH_HEADER)
        assert resp.status_code == 500
        assert resp.json()["detail"] == "Failed to get session"
