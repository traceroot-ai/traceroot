"""Unit tests for the internal project first-trace endpoint.

The web app compares the time with the moment it started recording first traces, and
fills ``projects.first_trace_receive_time`` from it for projects that already had traces.
"""

from datetime import datetime
from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient

from rest.main import app
from shared.config import settings

URL = "/api/v1/internal/projects/proj-1/first-trace"


@pytest.fixture()
def secret(monkeypatch):
    """Configure a known internal secret so the auth dependency accepts our header."""
    monkeypatch.setattr(settings, "internal_api_secret", "test-secret")
    return "test-secret"


@pytest.fixture()
def reader(monkeypatch):
    mock = MagicMock()
    monkeypatch.setattr("rest.routers.internal.projects.get_trace_reader_service", lambda: mock)
    return mock


@pytest.fixture()
def client(secret, reader):
    return TestClient(app)


class TestFirstTrace:
    def test_reports_the_receive_time_in_utc(self, client, reader, secret):
        reader.first_trace_receive_time.return_value = datetime(2026, 10, 1, 8, 30, 0, 250000)

        resp = client.get(URL, headers={"X-Internal-Secret": secret})

        assert resp.status_code == 200
        assert resp.json() == {"first_trace_receive_time": "2026-10-01T08:30:00.250000+00:00"}
        reader.first_trace_receive_time.assert_called_once_with("proj-1")

    def test_reports_nulls_for_a_project_without_traces(self, client, reader, secret):
        reader.first_trace_receive_time.return_value = None

        resp = client.get(URL, headers={"X-Internal-Secret": secret})

        assert resp.status_code == 200
        assert resp.json() == {"first_trace_receive_time": None}

    @pytest.mark.parametrize("headers", [{}, {"X-Internal-Secret": "wrong"}])
    def test_rejects_a_caller_without_the_secret(self, client, reader, headers):
        resp = client.get(URL, headers=headers)

        assert resp.status_code == 403
        reader.first_trace_receive_time.assert_not_called()
