"""Endpoint tests for the trace-list ``?filters=`` param.

Covers that a valid predicate array is parsed and threaded into ``list_traces``, and
that a malformed array or an unknown field/operator is rejected with 422 (not swallowed
by the list endpoint's broad 500 handler). Mocked deps — no ClickHouse.
"""

import json
from datetime import UTC, datetime, timedelta
from unittest.mock import AsyncMock, MagicMock, call

import pytest
from fastapi.testclient import TestClient

from rest.main import app
from rest.routers.deps import ProjectAccessInfo, get_project_access
from rest.routers.labels_common import LabeledTraceIds
from rest.services.filters.translate import Predicate

_EMPTY_PAGE = {"data": [], "meta": {"page": 0, "limit": 50, "total": 0}}
_LABEL_FILTER = {"field": "label", "op": "in", "value": ["incorrect"]}


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


def test_metadata_predicate_carries_its_key_through_to_the_service(client, mock_trace_reader):
    raw = json.dumps([{"field": "metadata", "op": "eq", "value": "acme-corp", "key": "tenant_id"}])
    resp = client.get("/api/v1/projects/p1/traces", params={"filters": raw})
    assert resp.status_code == 200
    threaded = mock_trace_reader.list_traces.call_args.kwargs["filters"]
    assert threaded == [Predicate(field="metadata", op="eq", value="acme-corp", key="tenant_id")]


def test_metadata_predicate_without_a_key_returns_422(client, mock_trace_reader):
    raw = json.dumps([{"field": "metadata", "op": "eq", "value": "acme-corp"}])
    resp = client.get("/api/v1/projects/p1/traces", params={"filters": raw})
    assert resp.status_code == 422
    mock_trace_reader.list_traces.assert_not_called()


def test_key_on_a_field_that_takes_none_returns_422(client, mock_trace_reader):
    raw = json.dumps([{"field": "model_name", "op": "in", "value": ["gpt-4"], "key": "x"}])
    resp = client.get("/api/v1/projects/p1/traces", params={"filters": raw})
    assert resp.status_code == 422
    mock_trace_reader.list_traces.assert_not_called()


def test_unknown_field_returns_422(client, mock_trace_reader):
    raw = json.dumps([{"field": "nope", "op": "in", "value": ["x"]}])
    resp = client.get("/api/v1/projects/p1/traces", params={"filters": raw})
    assert resp.status_code == 422
    mock_trace_reader.list_traces.assert_not_called()


def test_malformed_json_returns_422(client, mock_trace_reader):
    resp = client.get("/api/v1/projects/p1/traces", params={"filters": "not json"})
    assert resp.status_code == 422
    mock_trace_reader.list_traces.assert_not_called()


def test_label_filter_intersects_trace_ids_and_preserves_other_filters(
    client, mock_trace_reader, monkeypatch
):
    matches = AsyncMock(return_value=LabeledTraceIds(traceIds=["a", "b"], overflow=False))
    monkeypatch.setattr("rest.routers.labels_common.find_labeled_trace_ids", matches)
    model = {"field": "model_name", "op": "in", "value": ["gpt-4"]}
    resp = client.get(
        "/api/v1/projects/p1/traces",
        params={
            "filters": json.dumps([_LABEL_FILTER, model]),
            "trace_ids": ["b", "c"],
            "include_evaluations": True,
        },
    )
    assert resp.status_code == 200
    matches.assert_awaited_once_with("p1", "incorrect", trace_ids=["b", "c"], after_trace_id=None)
    mock_trace_reader.matching_trace_ids.assert_not_called()
    kwargs = mock_trace_reader.list_traces.call_args.kwargs
    assert kwargs["trace_ids"] == ["b"]
    assert kwargs["filters"] == [Predicate(**model)]
    assert kwargs["include_evaluations"] is False


def test_empty_label_filter_never_runs_an_unrestricted_trace_query(
    client, mock_trace_reader, monkeypatch
):
    matches = AsyncMock(return_value=LabeledTraceIds(traceIds=[], overflow=False))
    monkeypatch.setattr("rest.routers.labels_common.find_labeled_trace_ids", matches)
    resp = client.get("/api/v1/projects/p1/traces", params={"filters": json.dumps([_LABEL_FILTER])})
    assert resp.status_code == 200
    assert resp.json() == _EMPTY_PAGE
    mock_trace_reader.list_traces.assert_not_called()


def test_label_limit_ignores_historical_matches_outside_trace_scope(
    client, mock_trace_reader, monkeypatch
):
    old_ids = [f"old-{index:03d}" for index in range(500)]
    matches = AsyncMock(
        side_effect=[
            LabeledTraceIds(traceIds=old_ids, overflow=True),
            LabeledTraceIds(traceIds=["today"], overflow=False),
        ]
    )
    monkeypatch.setattr("rest.routers.labels_common.find_labeled_trace_ids", matches)
    mock_trace_reader.matching_trace_ids.side_effect = [[], ["today"]]
    end = datetime.now(UTC)
    start = end - timedelta(hours=1)
    model = {"field": "model_name", "op": "in", "value": ["gpt-4"]}
    resp = client.get(
        "/api/v1/projects/p1/traces",
        params={
            "filters": json.dumps([_LABEL_FILTER, model]),
            "start_after": start.isoformat(),
            "end_before": end.isoformat(),
        },
    )

    assert resp.status_code == 200
    assert matches.await_args_list == [
        call("p1", "incorrect", trace_ids=None, after_trace_id=None),
        call("p1", "incorrect", trace_ids=None, after_trace_id=old_ids[-1]),
    ]
    scope = {
        "project_id": "p1",
        "name": None,
        "user_id": None,
        "start_after": start,
        "end_before": end,
        "search_query": None,
        "filters": [Predicate(**model)],
        "include_evaluations": False,
    }
    assert mock_trace_reader.matching_trace_ids.call_args_list == [
        call(old_ids, **scope),
        call(["today"], **scope),
    ]
    mock_trace_reader.list_traces.assert_called_once_with(
        page=0, limit=50, trace_ids=["today"], sort=None, order="desc", **scope
    )


def test_label_filter_rejects_only_when_the_current_scope_exceeds_the_limit(
    client, mock_trace_reader, monkeypatch
):
    ids = [f"trace-{index:03d}" for index in range(101)]
    matches = AsyncMock(return_value=LabeledTraceIds(traceIds=ids, overflow=True))
    monkeypatch.setattr("rest.routers.labels_common.find_labeled_trace_ids", matches)
    mock_trace_reader.matching_trace_ids.return_value = ids
    resp = client.get("/api/v1/projects/p1/traces", params={"filters": json.dumps([_LABEL_FILTER])})

    assert resp.status_code == 422
    assert "in the current filters" in resp.json()["detail"]
    matches.assert_awaited_once()
    mock_trace_reader.list_traces.assert_not_called()
