"""Unit tests for user query endpoints."""

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

    import rest.routers.users as users_mod

    original = users_mod.get_trace_reader_service
    users_mod.get_trace_reader_service = lambda: mock_trace_reader

    yield TestClient(app)

    users_mod.get_trace_reader_service = original


class TestListUsers:
    def test_200(self, client, mock_trace_reader):
        mock_trace_reader.list_users.return_value = {
            "data": [
                {
                    "user_id": "user-1",
                    "trace_count": 10,
                    "last_trace_time": datetime(2024, 1, 15, 12, 0, 0),
                    "total_input_tokens": 500,
                    "total_output_tokens": 1000,
                    "total_cost": 0.03,
                },
            ],
            "meta": {"page": 0, "limit": 50, "total": 1},
        }
        response = client.get("/api/v1/projects/test-project/users")
        assert response.status_code == 200
        data = response.json()
        assert len(data["data"]) == 1
        assert data["data"][0]["user_id"] == "user-1"
        assert data["data"][0]["trace_count"] == 10
        assert data["data"][0]["total_input_tokens"] == 500
        assert data["data"][0]["total_output_tokens"] == 1000
        assert data["data"][0]["total_cost"] == 0.03

    def test_input_output_tokens_and_cost_null(self, client, mock_trace_reader):
        mock_trace_reader.list_users.return_value = {
            "data": [
                {
                    "user_id": "user-no-spans",
                    "trace_count": 2,
                    "last_trace_time": datetime(2024, 1, 10, 8, 0, 0),
                    "total_input_tokens": None,
                    "total_output_tokens": None,
                    "total_cost": None,
                },
            ],
            "meta": {"page": 0, "limit": 50, "total": 1},
        }
        response = client.get("/api/v1/projects/test-project/users")
        assert response.status_code == 200
        item = response.json()["data"][0]
        assert item["user_id"] == "user-no-spans"
        assert item["total_input_tokens"] is None
        assert item["total_output_tokens"] is None
        assert item["total_cost"] is None

    def test_pagination(self, client, mock_trace_reader):
        mock_trace_reader.list_users.return_value = {
            "data": [],
            "meta": {"page": 1, "limit": 10, "total": 15},
        }
        response = client.get("/api/v1/projects/test-project/users?page=1&limit=10")
        assert response.status_code == 200
        kw = mock_trace_reader.list_users.call_args.kwargs
        assert kw["page"] == 1
        assert kw["limit"] == 10

    def test_search_query(self, client, mock_trace_reader):
        mock_trace_reader.list_users.return_value = {
            "data": [],
            "meta": {"page": 0, "limit": 50, "total": 0},
        }
        response = client.get("/api/v1/projects/test-project/users?search_query=alice")
        assert response.status_code == 200
        assert mock_trace_reader.list_users.call_args.kwargs["search_query"] == "alice"

    def test_date_range(self, client, mock_trace_reader):
        mock_trace_reader.list_users.return_value = {
            "data": [],
            "meta": {"page": 0, "limit": 50, "total": 0},
        }
        response = client.get(
            "/api/v1/projects/test-project/users"
            "?start_after=2024-01-01T00:00:00"
            "&end_before=2024-01-31T23:59:59"
        )
        assert response.status_code == 200
        kw = mock_trace_reader.list_users.call_args.kwargs
        assert kw["start_after"] == datetime(2024, 1, 1, 0, 0, 0)
        assert kw["end_before"] == datetime(2024, 1, 31, 23, 59, 59)

    def test_empty_result(self, client, mock_trace_reader):
        mock_trace_reader.list_users.return_value = {
            "data": [],
            "meta": {"page": 0, "limit": 50, "total": 0},
        }
        response = client.get("/api/v1/projects/test-project/users")
        assert response.status_code == 200
        assert response.json()["data"] == []

    def test_service_error_returns_500(self, client, mock_trace_reader):
        mock_trace_reader.list_users.side_effect = Exception("ClickHouse down")
        response = client.get("/api/v1/projects/test-project/users")
        assert response.status_code == 500

    def test_multiple_users(self, client, mock_trace_reader):
        mock_trace_reader.list_users.return_value = {
            "data": [
                {
                    "user_id": "alice",
                    "trace_count": 20,
                    "last_trace_time": datetime(2024, 1, 15),
                    "total_input_tokens": 2000,
                    "total_output_tokens": 3000,
                    "total_cost": 0.10,
                },
                {
                    "user_id": "bob",
                    "trace_count": 5,
                    "last_trace_time": datetime(2024, 1, 10),
                    "total_input_tokens": 300,
                    "total_output_tokens": 500,
                    "total_cost": 0.02,
                },
                {
                    "user_id": "charlie",
                    "trace_count": 1,
                    "last_trace_time": datetime(2024, 1, 5),
                    "total_input_tokens": None,
                    "total_output_tokens": None,
                    "total_cost": None,
                },
            ],
            "meta": {"page": 0, "limit": 50, "total": 3},
        }
        response = client.get("/api/v1/projects/test-project/users")
        assert response.status_code == 200
        data = response.json()["data"]
        assert len(data) == 3
        assert data[0]["user_id"] == "alice"
        assert data[0]["total_input_tokens"] == 2000
        assert data[0]["total_output_tokens"] == 3000
        assert data[0]["total_cost"] == 0.10
        assert data[2]["trace_count"] == 1
        assert data[2]["total_input_tokens"] is None
        assert data[2]["total_output_tokens"] is None
        assert data[2]["total_cost"] is None
