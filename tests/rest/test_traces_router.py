"""Unit tests for trace query endpoints.

Uses FastAPI TestClient with mocked dependencies — no ClickHouse needed.
"""

from datetime import datetime
from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient

from rest.main import app
from rest.routers.deps import ProjectAccessInfo, get_project_access

TRACE_LIST_ITEM = {
    "trace_id": "abc123",
    "project_id": "test-project",
    "name": "test-trace",
    "trace_start_time": datetime(2024, 1, 15, 12, 0, 0),
    "user_id": "user-1",
    "session_id": None,
    "span_count": 3,
    "duration_ms": 1500.0,
    "status": "ok",
    "input": "hello",
    "output": "world",
}

TRACE_DETAIL = {
    "trace_id": "abc123",
    "project_id": "test-project",
    "name": "test-trace",
    "trace_start_time": datetime(2024, 1, 15, 12, 0, 0),
    "user_id": None,
    "session_id": None,
    "environment": "default",
    "release": None,
    "input": None,
    "output": None,
    "metadata": None,
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


@pytest.fixture()
def mock_trace_reader():
    """Mock TraceReaderService."""
    return MagicMock()


@pytest.fixture()
def client(mock_trace_reader):
    """TestClient with mocked auth and trace reader."""

    async def mock_get_access(project_id: str, x_user_id=None):
        return ProjectAccessInfo(project_id=project_id, user_id="test-user", role="ADMIN")

    app.dependency_overrides[get_project_access] = mock_get_access

    import rest.routers.traces as traces_mod

    original = traces_mod.get_trace_reader_service
    traces_mod.get_trace_reader_service = lambda: mock_trace_reader

    yield TestClient(app)

    traces_mod.get_trace_reader_service = original


class TestListTraces:
    def test_200(self, client, mock_trace_reader):
        mock_trace_reader.list_traces.return_value = {
            "data": [TRACE_LIST_ITEM],
            "meta": {"page": 0, "limit": 50, "total": 1},
        }
        response = client.get("/api/v1/projects/test-project/traces")
        assert response.status_code == 200
        data = response.json()
        assert len(data["data"]) == 1
        assert data["data"][0]["trace_id"] == "abc123"
        assert data["meta"]["total"] == 1

    def test_with_name_and_user_filters(self, client, mock_trace_reader):
        mock_trace_reader.list_traces.return_value = {
            "data": [],
            "meta": {"page": 0, "limit": 50, "total": 0},
        }
        response = client.get("/api/v1/projects/test-project/traces?name=foo&user_id=bar")
        assert response.status_code == 200
        kw = mock_trace_reader.list_traces.call_args.kwargs
        assert kw["name"] == "foo"
        assert kw["user_id"] == "bar"

    def test_pagination(self, client, mock_trace_reader):
        mock_trace_reader.list_traces.return_value = {
            "data": [],
            "meta": {"page": 2, "limit": 10, "total": 25},
        }
        response = client.get("/api/v1/projects/test-project/traces?page=2&limit=10")
        assert response.status_code == 200
        kw = mock_trace_reader.list_traces.call_args.kwargs
        assert kw["page"] == 2
        assert kw["limit"] == 10

    def test_search_query(self, client, mock_trace_reader):
        mock_trace_reader.list_traces.return_value = {
            "data": [],
            "meta": {"page": 0, "limit": 50, "total": 0},
        }
        response = client.get("/api/v1/projects/test-project/traces?search_query=abc")
        assert response.status_code == 200
        assert mock_trace_reader.list_traces.call_args.kwargs["search_query"] == "abc"

    def test_date_range_filters(self, client, mock_trace_reader):
        mock_trace_reader.list_traces.return_value = {
            "data": [],
            "meta": {"page": 0, "limit": 50, "total": 0},
        }
        response = client.get(
            "/api/v1/projects/test-project/traces"
            "?start_after=2024-01-01T00:00:00"
            "&end_before=2024-01-31T23:59:59"
        )
        assert response.status_code == 200
        kw = mock_trace_reader.list_traces.call_args.kwargs
        assert kw["start_after"] == datetime(2024, 1, 1, 0, 0, 0)
        assert kw["end_before"] == datetime(2024, 1, 31, 23, 59, 59)

    def test_empty_result(self, client, mock_trace_reader):
        mock_trace_reader.list_traces.return_value = {
            "data": [],
            "meta": {"page": 0, "limit": 50, "total": 0},
        }
        response = client.get("/api/v1/projects/test-project/traces")
        assert response.status_code == 200
        assert response.json()["data"] == []
        assert response.json()["meta"]["total"] == 0

    def test_service_error_returns_500(self, client, mock_trace_reader):
        mock_trace_reader.list_traces.side_effect = Exception("ClickHouse down")
        response = client.get("/api/v1/projects/test-project/traces")
        assert response.status_code == 500

    def test_limit_validation_rejects_over_200(self, client, mock_trace_reader):
        response = client.get("/api/v1/projects/test-project/traces?limit=500")
        assert response.status_code == 422

    def test_page_validation_rejects_negative(self, client, mock_trace_reader):
        response = client.get("/api/v1/projects/test-project/traces?page=-1")
        assert response.status_code == 422


class TestGetTrace:
    def test_200(self, client, mock_trace_reader):
        mock_trace_reader.get_trace.return_value = TRACE_DETAIL
        response = client.get("/api/v1/projects/test-project/traces/abc123")
        assert response.status_code == 200
        data = response.json()
        assert data["trace_id"] == "abc123"
        assert len(data["spans"]) == 1
        assert data["spans"][0]["span_id"] == "span-1"

    def test_404(self, client, mock_trace_reader):
        mock_trace_reader.get_trace.return_value = None
        response = client.get("/api/v1/projects/test-project/traces/nonexistent")
        assert response.status_code == 404

    def test_trace_with_multiple_spans(self, client, mock_trace_reader):
        detail = {
            **TRACE_DETAIL,
            "spans": [
                TRACE_DETAIL["spans"][0],
                {
                    **TRACE_DETAIL["spans"][0],
                    "span_id": "span-2",
                    "parent_span_id": "span-1",
                    "name": "child-span",
                    "span_kind": "LLM",
                    "model_name": "gpt-4o",
                    "cost": 0.005,
                    "input_tokens": 100,
                    "output_tokens": 50,
                    "total_tokens": 150,
                },
            ],
        }
        mock_trace_reader.get_trace.return_value = detail
        response = client.get("/api/v1/projects/test-project/traces/abc123")
        assert response.status_code == 200
        spans = response.json()["spans"]
        assert len(spans) == 2
        assert spans[1]["model_name"] == "gpt-4o"
        assert spans[1]["cost"] == 0.005
