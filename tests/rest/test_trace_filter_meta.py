"""Unit tests for the trace-filter meta endpoints and the distinct-values query.

Covers ``GET /traces/filter-fields`` (registry serialization) and
``GET /traces/filter-values/{field}`` (distinct categorical values), plus the
``TraceReaderService.get_distinct_span_values`` query + cache. Uses TestClient with
mocked dependencies — no ClickHouse needed.
"""

from datetime import datetime
from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient

from rest.main import app
from rest.routers.deps import ProjectAccessInfo, get_project_access
from rest.services.filters import columns as reg


@pytest.fixture()
def mock_trace_reader():
    return MagicMock()


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


class TestFilterFields:
    def test_returns_every_registry_field(self, client):
        resp = client.get("/api/v1/projects/p1/traces/filter-fields")
        assert resp.status_code == 200
        fields = resp.json()["fields"]
        assert {f["field"] for f in fields} == {c.name for c in reg.FILTER_COLUMNS}

    def test_serializes_field_shape_from_registry(self, client):
        fields = {
            f["field"]: f
            for f in client.get("/api/v1/projects/p1/traces/filter-fields").json()["fields"]
        }

        model = fields["model_name"]
        assert model["type"] == "categorical"
        assert model["level"] == "SPAN_MEMBERSHIP"
        assert model["operators"] == ["in"]
        assert model["value_source"] == "distinct_query"
        assert model["enum_values"] == []

        cost = fields["cost"]
        assert cost["type"] == "numeric"
        assert cost["operators"] == ["between"]
        assert cost["value_source"] == "range"
        # Integer-typed fields are flagged so the UI restricts them to whole numbers;
        # cost (Decimal) and model (String) are not.
        assert fields["total_tokens"]["integer"] is True
        assert fields["duration_ms"]["integer"] is True
        assert fields["errors"]["integer"] is True
        assert cost["integer"] is False
        assert model["integer"] is False


class TestFilterValues:
    def test_model_name_returns_values_by_frequency(self, client, mock_trace_reader):
        mock_trace_reader.get_distinct_span_values.return_value = [
            {"value": "gpt-4", "count": 10},
            {"value": "claude-opus-4.8", "count": 4},
        ]
        resp = client.get("/api/v1/projects/p1/traces/filter-values/model_name")
        assert resp.status_code == 200
        body = resp.json()
        assert body["field"] == "model_name"
        assert body["values"][0] == {"value": "gpt-4", "count": 10}
        kw = mock_trace_reader.get_distinct_span_values.call_args.kwargs
        assert kw["project_id"] == "p1"
        assert kw["column"] == "model_name"

    def test_start_after_is_threaded_to_the_service(self, client, mock_trace_reader):
        mock_trace_reader.get_distinct_span_values.return_value = []
        resp = client.get(
            "/api/v1/projects/p1/traces/filter-values/environment?start_after=2026-06-01T00:00:00"
        )
        assert resp.status_code == 200
        assert mock_trace_reader.get_distinct_span_values.call_args.kwargs[
            "start_after"
        ] == datetime(2026, 6, 1, 0, 0, 0)

    def test_unknown_field_is_404(self, client, mock_trace_reader):
        resp = client.get("/api/v1/projects/p1/traces/filter-values/not_a_field")
        assert resp.status_code == 404
        mock_trace_reader.get_distinct_span_values.assert_not_called()

    def test_numeric_field_is_rejected(self, client, mock_trace_reader):
        resp = client.get("/api/v1/projects/p1/traces/filter-values/cost")
        assert resp.status_code == 400
        mock_trace_reader.get_distinct_span_values.assert_not_called()


class TestGetDistinctSpanValues:
    def _service(self, monkeypatch, mock_client):
        import rest.services.trace_reader as tr_mod

        monkeypatch.setattr(tr_mod, "get_clickhouse_client", lambda: mock_client)
        return tr_mod.TraceReaderService()

    def test_builds_grouped_project_scoped_query(self, monkeypatch):
        mock_client = MagicMock()
        mock_client.query.return_value.result_rows = [("gpt-4", 10), ("claude", 5)]
        svc = self._service(monkeypatch, mock_client)

        out = svc.get_distinct_span_values(project_id="p1", column="model_name")

        assert out == [
            {"value": "gpt-4", "count": 10},
            {"value": "claude", "count": 5},
        ]
        sql, kwargs = mock_client.query.call_args
        query_text = sql[0]
        assert "FROM spans" in query_text
        assert "GROUP BY" in query_text
        assert "model_name" in query_text
        assert "project_id = {project_id:String}" in query_text
        params = kwargs["parameters"]
        assert params["project_id"] == "p1"
        assert "start_after" not in params  # no window → no time bound

    def test_start_after_adds_a_time_bound(self, monkeypatch):
        mock_client = MagicMock()
        mock_client.query.return_value.result_rows = []
        svc = self._service(monkeypatch, mock_client)

        svc.get_distinct_span_values(
            project_id="p1", column="model_name", start_after=datetime(2026, 6, 1)
        )
        sql, kwargs = mock_client.query.call_args
        assert "span_start_time >= {start_after:DateTime64(3)}" in sql[0]
        assert kwargs["parameters"]["start_after"] is not None

    def test_results_are_cached_per_project_field_window(self, monkeypatch):
        mock_client = MagicMock()
        mock_client.query.return_value.result_rows = [("gpt-4", 10)]
        svc = self._service(monkeypatch, mock_client)

        first = svc.get_distinct_span_values(project_id="p1", column="model_name")
        second = svc.get_distinct_span_values(project_id="p1", column="model_name")

        assert first == second
        mock_client.query.assert_called_once()  # second call served from cache

    def test_query_excludes_null_and_empty_values(self, monkeypatch):
        mock_client = MagicMock()
        mock_client.query.return_value.result_rows = []
        svc = self._service(monkeypatch, mock_client)

        svc.get_distinct_span_values(project_id="p1", column="model_name")
        query_text = mock_client.query.call_args[0][0]
        assert "model_name AS value" in query_text
        assert "value IS NOT NULL" in query_text
        assert "value != ''" in query_text  # blanks aren't offered as options
        # Deduped to the latest ReplacingMergeTree version per span before counting.
        assert "LIMIT 1 BY project_id, trace_id, span_id" in query_text

    def test_cache_is_bounded(self, monkeypatch):
        from rest.services.trace_reader import DISTINCT_VALUES_CACHE_MAX

        mock_client = MagicMock()
        mock_client.query.return_value.result_rows = []
        svc = self._service(monkeypatch, mock_client)

        # Far more distinct cache keys than the cap; size must stay bounded.
        for i in range(DISTINCT_VALUES_CACHE_MAX + 50):
            svc.get_distinct_span_values(project_id=f"p{i}", column="model_name")
        assert len(svc._distinct_cache) <= DISTINCT_VALUES_CACHE_MAX
