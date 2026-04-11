"""Unit tests for session query endpoints."""

from datetime import datetime
from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient

from rest.main import app
from rest.routers.deps import ProjectAccessInfo, get_project_access


@pytest.fixture()
def mock_trace_reader():
    return MagicMock()


@pytest.fixture()
def client(mock_trace_reader):
    async def mock_get_access(project_id: str, x_user_id=None):
        return ProjectAccessInfo(project_id=project_id, user_id="test-user", role="ADMIN")

    app.dependency_overrides[get_project_access] = mock_get_access

    import rest.routers.sessions as sessions_mod

    original = sessions_mod.get_trace_reader_service
    sessions_mod.get_trace_reader_service = lambda: mock_trace_reader

    yield TestClient(app)

    sessions_mod.get_trace_reader_service = original


class TestListSessions:
    def test_200(self, client, mock_trace_reader):
        mock_trace_reader.list_sessions.return_value = {
            "data": [
                {
                    "session_id": "sess-1",
                    "trace_count": 5,
                    "user_ids": ["user-1"],
                    "first_trace_time": datetime(2024, 1, 15, 10, 0, 0),
                    "last_trace_time": datetime(2024, 1, 15, 10, 5, 0),
                    "duration_ms": 300000.0,
                    "total_input_tokens": 500,
                    "total_output_tokens": 800,
                    "total_cost": 0.05,
                    "input": "What is the weather?",
                    "output": "It is sunny and 72F.",
                },
            ],
            "meta": {"page": 0, "limit": 50, "total": 1},
        }
        response = client.get("/api/v1/projects/test-project/sessions")
        assert response.status_code == 200
        data = response.json()
        assert len(data["data"]) == 1
        assert data["data"][0]["session_id"] == "sess-1"
        assert data["data"][0]["trace_count"] == 5
        assert data["data"][0]["user_ids"] == ["user-1"]
        assert data["data"][0]["input"] == "What is the weather?"
        assert data["data"][0]["output"] == "It is sunny and 72F."
        assert data["data"][0]["total_cost"] == 0.05

    def test_pagination(self, client, mock_trace_reader):
        mock_trace_reader.list_sessions.return_value = {
            "data": [],
            "meta": {"page": 1, "limit": 10, "total": 15},
        }
        response = client.get("/api/v1/projects/test-project/sessions?page=1&limit=10")
        assert response.status_code == 200
        kw = mock_trace_reader.list_sessions.call_args.kwargs
        assert kw["page"] == 1
        assert kw["limit"] == 10

    def test_search_query(self, client, mock_trace_reader):
        mock_trace_reader.list_sessions.return_value = {
            "data": [],
            "meta": {"page": 0, "limit": 50, "total": 0},
        }
        response = client.get("/api/v1/projects/test-project/sessions?search_query=tool-agent")
        assert response.status_code == 200
        assert mock_trace_reader.list_sessions.call_args.kwargs["search_query"] == "tool-agent"

    def test_date_range(self, client, mock_trace_reader):
        mock_trace_reader.list_sessions.return_value = {
            "data": [],
            "meta": {"page": 0, "limit": 50, "total": 0},
        }
        response = client.get(
            "/api/v1/projects/test-project/sessions"
            "?start_after=2024-01-01T00:00:00"
            "&end_before=2024-01-31T23:59:59"
        )
        assert response.status_code == 200
        kw = mock_trace_reader.list_sessions.call_args.kwargs
        assert kw["start_after"] == datetime(2024, 1, 1, 0, 0, 0)
        assert kw["end_before"] == datetime(2024, 1, 31, 23, 59, 59)

    def test_empty_result(self, client, mock_trace_reader):
        mock_trace_reader.list_sessions.return_value = {
            "data": [],
            "meta": {"page": 0, "limit": 50, "total": 0},
        }
        response = client.get("/api/v1/projects/test-project/sessions")
        assert response.status_code == 200
        assert response.json()["data"] == []

    def test_service_error_returns_500(self, client, mock_trace_reader):
        mock_trace_reader.list_sessions.side_effect = Exception("ClickHouse down")
        response = client.get("/api/v1/projects/test-project/sessions")
        assert response.status_code == 500

    def test_multiple_sessions(self, client, mock_trace_reader):
        mock_trace_reader.list_sessions.return_value = {
            "data": [
                {
                    "session_id": "sess-a",
                    "trace_count": 10,
                    "user_ids": ["alice", "bob"],
                    "first_trace_time": datetime(2024, 1, 15, 10, 0),
                    "last_trace_time": datetime(2024, 1, 15, 10, 30),
                    "duration_ms": 1800000.0,
                    "total_input_tokens": 1000,
                    "total_output_tokens": 2000,
                    "total_cost": 0.15,
                    "input": "Hello",
                    "output": "Goodbye",
                },
                {
                    "session_id": "sess-b",
                    "trace_count": 3,
                    "user_ids": ["charlie"],
                    "first_trace_time": datetime(2024, 1, 14, 8, 0),
                    "last_trace_time": datetime(2024, 1, 14, 8, 5),
                    "duration_ms": 300000.0,
                    "total_input_tokens": 200,
                    "total_output_tokens": 400,
                    "total_cost": None,
                    "input": None,
                    "output": None,
                },
            ],
            "meta": {"page": 0, "limit": 50, "total": 2},
        }
        response = client.get("/api/v1/projects/test-project/sessions")
        assert response.status_code == 200
        data = response.json()["data"]
        assert len(data) == 2
        assert data[0]["session_id"] == "sess-a"
        assert data[1]["trace_count"] == 3


class TestGetSession:
    def test_200(self, client, mock_trace_reader):
        mock_trace_reader.get_session.return_value = {
            "session_id": "sess-1",
            "traces": [
                {
                    "trace_id": "trace-1",
                    "name": "agent_call",
                    "trace_start_time": datetime(2024, 1, 15, 10, 0, 0),
                    "user_id": "user-1",
                    "input": "What is the weather?",
                    "output": "It is sunny.",
                    "duration_ms": 1500.0,
                    "status": "ok",
                },
                {
                    "trace_id": "trace-2",
                    "name": "agent_call",
                    "trace_start_time": datetime(2024, 1, 15, 10, 1, 0),
                    "user_id": "user-1",
                    "input": "How about tomorrow?",
                    "output": "It will rain.",
                    "duration_ms": 2000.0,
                    "status": "ok",
                },
            ],
            "user_ids": ["user-1"],
            "trace_count": 2,
            "first_trace_time": datetime(2024, 1, 15, 10, 0, 0),
            "last_trace_time": datetime(2024, 1, 15, 10, 1, 0),
            "duration_ms": 60000.0,
            "total_input_tokens": 100,
            "total_output_tokens": 200,
            "total_cost": 0.02,
        }
        response = client.get("/api/v1/projects/test-project/sessions/sess-1")
        assert response.status_code == 200
        data = response.json()
        assert data["session_id"] == "sess-1"
        assert len(data["traces"]) == 2
        assert data["traces"][0]["input"] == "What is the weather?"
        assert data["traces"][1]["output"] == "It will rain."
        assert data["trace_count"] == 2
        assert data["total_cost"] == 0.02

    def test_not_found(self, client, mock_trace_reader):
        mock_trace_reader.get_session.return_value = None
        response = client.get("/api/v1/projects/test-project/sessions/nonexistent")
        assert response.status_code == 404

    def test_service_error_returns_500(self, client, mock_trace_reader):
        mock_trace_reader.get_session.side_effect = Exception("ClickHouse down")
        response = client.get("/api/v1/projects/test-project/sessions/sess-1")
        assert response.status_code == 500

    def test_traces_ordered_chronologically(self, client, mock_trace_reader):
        mock_trace_reader.get_session.return_value = {
            "session_id": "sess-1",
            "traces": [
                {
                    "trace_id": "t1",
                    "name": "call_1",
                    "trace_start_time": datetime(2024, 1, 15, 10, 0),
                    "user_id": None,
                    "input": "first",
                    "output": "response1",
                    "duration_ms": 100.0,
                    "status": "ok",
                },
                {
                    "trace_id": "t2",
                    "name": "call_2",
                    "trace_start_time": datetime(2024, 1, 15, 10, 1),
                    "user_id": None,
                    "input": "second",
                    "output": "response2",
                    "duration_ms": 200.0,
                    "status": "ok",
                },
                {
                    "trace_id": "t3",
                    "name": "call_3",
                    "trace_start_time": datetime(2024, 1, 15, 10, 2),
                    "user_id": None,
                    "input": "third",
                    "output": "response3",
                    "duration_ms": 150.0,
                    "status": "error",
                },
            ],
            "user_ids": [],
            "trace_count": 3,
            "first_trace_time": datetime(2024, 1, 15, 10, 0),
            "last_trace_time": datetime(2024, 1, 15, 10, 2),
            "duration_ms": 120000.0,
            "total_input_tokens": None,
            "total_output_tokens": None,
        }
        response = client.get("/api/v1/projects/test-project/sessions/sess-1")
        assert response.status_code == 200
        traces = response.json()["traces"]
        assert traces[0]["input"] == "first"
        assert traces[1]["input"] == "second"
        assert traces[2]["input"] == "third"
        assert traces[2]["status"] == "error"
