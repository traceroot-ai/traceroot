"""The sample trace a project with no traces can add."""

import json
from datetime import UTC, datetime
from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient

from rest.main import app
from rest.services.sample_trace import SAMPLE_ENVIRONMENT, build_sample_trace, sample_trace_id
from shared.config import settings

URL = "/api/v1/internal/projects/proj-1/sample-trace"
NOW = datetime(2026, 10, 1, 12, 0, tzinfo=UTC)


class TestBuildSampleTrace:
    def test_is_one_tree_under_a_single_root(self):
        trace, spans = build_sample_trace("proj-1", now=NOW)

        roots = [s for s in spans if s["parent_span_id"] is None]
        assert [s["span_kind"] for s in roots] == ["AGENT"]
        assert {s["parent_span_id"] for s in spans if s not in roots} == {roots[0]["span_id"]}
        assert [s["span_kind"] for s in spans] == ["AGENT", "LLM", "TOOL", "LLM"]
        assert len({s["span_id"] for s in spans}) == len(spans)
        assert {s["trace_id"] for s in spans} == {trace["trace_id"]}

    def test_children_run_inside_the_root_which_ends_now(self):
        trace, spans = build_sample_trace("proj-1", now=NOW)
        root, *children = spans

        assert root["span_end_time"] == NOW
        assert root["span_start_time"] == trace["trace_start_time"]
        for child in children:
            assert root["span_start_time"] <= child["span_start_time"]
            assert child["span_end_time"] <= root["span_end_time"]

    def test_model_calls_carry_tokens_and_cost(self, monkeypatch):
        monkeypatch.setattr(
            "rest.services.sample_trace.get_model_price",
            lambda model: {"input": 0.000001, "output": 0.000002},
        )
        _, spans = build_sample_trace("proj-1", now=NOW)

        for span in spans:
            if span["span_kind"] == "LLM":
                assert span["total_tokens"] == span["input_tokens"] + span["output_tokens"]
                assert span["cost"] > 0
            else:
                assert "cost" not in span

    def test_every_row_is_marked_and_belongs_to_the_project(self):
        trace, spans = build_sample_trace("proj-1", now=NOW)

        for row in (trace, *spans):
            assert row["project_id"] == "proj-1"
            assert row["environment"] == SAMPLE_ENVIRONMENT
            json.loads(row["input"])

    def test_ids_are_stable_per_project_and_differ_between_projects(self):
        first = build_sample_trace("proj-1", now=NOW)
        again = build_sample_trace("proj-1")

        assert [s["span_id"] for s in first[1]] == [s["span_id"] for s in again[1]]
        assert first[0]["trace_id"] == sample_trace_id("proj-1") != sample_trace_id("proj-2")
        assert len(first[0]["trace_id"]) == 32


@pytest.fixture()
def secret(monkeypatch):
    monkeypatch.setattr(settings, "internal_api_secret", "test-secret")
    return "test-secret"


@pytest.fixture()
def reader(monkeypatch):
    mock = MagicMock()
    mock.has_traces.return_value = False
    monkeypatch.setattr("rest.routers.internal.projects.get_trace_reader_service", lambda: mock)
    return mock


@pytest.fixture()
def clickhouse(monkeypatch):
    mock = MagicMock()
    monkeypatch.setattr("rest.routers.internal.projects.get_clickhouse_client", lambda: mock)
    return mock


@pytest.fixture()
def client(secret, reader, clickhouse):
    return TestClient(app)


class TestCreateSampleTrace:
    def test_inserts_the_trace_then_spans(self, client, reader, clickhouse, secret):
        resp = client.post(URL, headers={"X-Internal-Secret": secret})

        assert resp.status_code == 200
        assert resp.json() == {"trace_id": sample_trace_id("proj-1")}
        assert [call[0] for call in clickhouse.method_calls] == [
            "insert_traces_batch",
            "insert_spans_batch",
        ]
        assert [call[0] for call in reader.method_calls] == [
            "forget_has_traces",
            "has_traces",
            "forget_has_traces",
        ]

    def test_refuses_a_project_that_has_traces(self, client, reader, clickhouse, secret):
        reader.has_traces.return_value = True

        resp = client.post(URL, headers={"X-Internal-Secret": secret})

        assert resp.status_code == 409
        assert clickhouse.method_calls == []

    @pytest.mark.parametrize("headers", [{}, {"X-Internal-Secret": "wrong"}])
    def test_rejects_a_caller_without_the_secret(self, client, clickhouse, headers):
        resp = client.post(URL, headers=headers)

        assert resp.status_code == 403
        assert clickhouse.method_calls == []
