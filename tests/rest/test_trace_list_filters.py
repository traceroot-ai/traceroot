"""Endpoint tests for the trace-list ``?filters=`` param.

Covers that a valid predicate array is parsed and threaded into ``list_traces``, and
that a malformed array or an unknown field/operator is rejected with 422 (not swallowed
by the list endpoint's broad 500 handler). Mocked deps — no ClickHouse.
"""

import json
from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient

from rest.main import app
from rest.routers.deps import ProjectAccessInfo, get_project_access
from rest.services.filters.translate import Predicate

_EMPTY_PAGE = {"data": [], "meta": {"page": 0, "limit": 50, "total": 0}}


@pytest.fixture()
def mock_trace_reader():
    m = MagicMock()
    m.list_traces.return_value = _EMPTY_PAGE
    return m


@pytest.fixture()
def client(mock_trace_reader):
    async def mock_get_access(project_id: str, x_user_id=None):
        return ProjectAccessInfo(
            project_id=project_id,
            user_id="test-user",
            role="ADMIN",
            workspace_id="ws-test",
            billing_plan="free",
        )

    app.dependency_overrides[get_project_access] = mock_get_access
    import rest.routers.traces as traces_mod

    original = traces_mod.get_trace_reader_service
    traces_mod.get_trace_reader_service = lambda: mock_trace_reader
    yield TestClient(app)
    traces_mod.get_trace_reader_service = original
    app.dependency_overrides.clear()


def test_valid_filters_are_parsed_and_threaded_to_the_service(client, mock_trace_reader):
    raw = json.dumps([{"field": "model_name", "op": "in", "value": ["gpt-4"]}])
    resp = client.get("/api/v1/projects/p1/traces", params={"filters": raw})
    assert resp.status_code == 200
    threaded = mock_trace_reader.list_traces.call_args.kwargs["filters"]
    assert threaded == [Predicate(field="model_name", op="in", value=["gpt-4"])]


def test_no_filters_param_threads_an_empty_list(client, mock_trace_reader):
    resp = client.get("/api/v1/projects/p1/traces")
    assert resp.status_code == 200
    assert mock_trace_reader.list_traces.call_args.kwargs["filters"] == []


def test_unknown_field_returns_422(client, mock_trace_reader):
    raw = json.dumps([{"field": "nope", "op": "in", "value": ["x"]}])
    resp = client.get("/api/v1/projects/p1/traces", params={"filters": raw})
    assert resp.status_code == 422
    mock_trace_reader.list_traces.assert_not_called()


def test_malformed_json_returns_422(client, mock_trace_reader):
    resp = client.get("/api/v1/projects/p1/traces", params={"filters": "not json"})
    assert resp.status_code == 422
    mock_trace_reader.list_traces.assert_not_called()
