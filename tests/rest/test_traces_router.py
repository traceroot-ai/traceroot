"""Unit tests for trace query endpoints.

Uses FastAPI TestClient with mocked dependencies — no ClickHouse needed.
"""

import copy
from datetime import UTC, datetime, timedelta
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
    "error_count": 0,
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
    "git_ref": None,
    "git_repo": None,
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
            "usage_details": {},
            "cost_details": {},
        }
    ],
}

# Full I/O payload returned by the dedicated per-span endpoint.
SPAN_IO = {
    "span_id": "span-1",
    "trace_id": "abc123",
    "input": '{"prompt": "hello"}',
    "output": '{"completion": "world"}',
    "metadata": '{"traceroot.span.path": ["root"]}',
}


@pytest.fixture()
def mock_trace_reader():
    """Mock TraceReaderService."""
    return MagicMock()


@pytest.fixture()
def client(mock_trace_reader):
    """TestClient with mocked auth and trace reader."""

    async def mock_get_access(project_id: str, x_user_id=None):
        # Mirror the validate-project-access contract (workspaceId + billingPlan)
        # so get_rate_limited_project_access stamps a real workspace for the
        # per-workspace rate limiter.
        return ProjectAccessInfo(
            project_id=project_id,
            user_id="test-user",
            role="ADMIN",
            workspace_id="ws-test",
            billing_plan="enterprise",
        )

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
        assert data["data"][0]["error_count"] == 0
        assert "status" not in data["data"][0]
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

    def test_default_skeleton_io_is_null_and_no_bulk_query(self, client, mock_trace_reader):
        """Default (skeleton) projection: per-span I/O fields are present but null,
        and the bulk span-I/O query is NOT issued.

        The #1040 win is preserved by never *fetching* the heavy blobs on the
        default read; the null I/O keys are additive (a few bytes/span) so the
        shipped CLI's generated types keep finding the fields they declare.
        """
        mock_trace_reader.get_trace.return_value = copy.deepcopy(TRACE_DETAIL)
        response = client.get("/api/v1/projects/test-project/traces/abc123")
        assert response.status_code == 200
        span = response.json()["spans"][0]
        # I/O fields are present and null — the bulk read was skipped.
        assert span["input"] is None
        assert span["output"] is None
        assert span["metadata"] is None
        mock_trace_reader.get_trace_spans_io.assert_not_called()
        # Tree/display fields are still present.
        assert span["span_id"] == "span-1"
        assert span["parent_span_id"] is None
        assert "usage_details" in span
        assert "cost_details" in span

    def test_fields_full_merges_bulk_span_io(self, client, mock_trace_reader):
        """fields=full issues ONE bulk query and attaches per-span I/O."""
        mock_trace_reader.get_trace.return_value = copy.deepcopy(TRACE_DETAIL)
        mock_trace_reader.get_trace_spans_io.return_value = {
            "span-1": {"input": "the-in", "output": "the-out", "metadata": "the-meta"}
        }
        response = client.get("/api/v1/projects/test-project/traces/abc123?fields=full")
        assert response.status_code == 200
        span = response.json()["spans"][0]
        assert span["input"] == "the-in"
        assert span["output"] == "the-out"
        assert span["metadata"] == "the-meta"
        # One trace-scoped bulk query, all three columns requested.
        mock_trace_reader.get_trace_spans_io.assert_called_once()
        kw = mock_trace_reader.get_trace_spans_io.call_args.kwargs
        assert kw["project_id"] == "test-project"
        assert kw["trace_id"] == "abc123"
        assert set(kw["columns"]) == {"input", "output", "metadata"}

    def test_fields_io_requests_input_output_only(self, client, mock_trace_reader):
        """fields=io requests input+output (not metadata); metadata stays null."""
        mock_trace_reader.get_trace.return_value = copy.deepcopy(TRACE_DETAIL)
        mock_trace_reader.get_trace_spans_io.return_value = {
            "span-1": {"input": "the-in", "output": "the-out"}
        }
        response = client.get("/api/v1/projects/test-project/traces/abc123?fields=io")
        assert response.status_code == 200
        span = response.json()["spans"][0]
        assert span["input"] == "the-in"
        assert span["output"] == "the-out"
        assert span["metadata"] is None
        assert set(mock_trace_reader.get_trace_spans_io.call_args.kwargs["columns"]) == {
            "input",
            "output",
        }

    def test_fields_full_missing_span_in_map_serializes_null(self, client, mock_trace_reader):
        """A span absent from the bulk I/O map keeps null I/O (no 500)."""
        mock_trace_reader.get_trace.return_value = copy.deepcopy(TRACE_DETAIL)
        mock_trace_reader.get_trace_spans_io.return_value = {}  # span-1 absent
        response = client.get("/api/v1/projects/test-project/traces/abc123?fields=full")
        assert response.status_code == 200
        span = response.json()["spans"][0]
        assert span["input"] is None
        assert span["output"] is None
        assert span["metadata"] is None

    def test_unknown_fields_returns_400(self, client, mock_trace_reader):
        mock_trace_reader.get_trace.return_value = copy.deepcopy(TRACE_DETAIL)
        response = client.get("/api/v1/projects/test-project/traces/abc123?fields=bogus")
        assert response.status_code == 400
        assert "bogus" in response.json()["detail"]
        mock_trace_reader.get_trace_spans_io.assert_not_called()

    def test_trace_level_io_is_preserved(self, client, mock_trace_reader):
        """Trace-level input/output/metadata stay on the trace (only spans drop I/O)."""
        detail = {
            **TRACE_DETAIL,
            "input": "trace-input",
            "output": "trace-output",
            "metadata": "trace-metadata",
        }
        mock_trace_reader.get_trace.return_value = detail
        response = client.get("/api/v1/projects/test-project/traces/abc123")
        assert response.status_code == 200
        data = response.json()
        assert data["input"] == "trace-input"
        assert data["output"] == "trace-output"
        assert data["metadata"] == "trace-metadata"


class TestGetSpanIO:
    def test_200_returns_span_blobs(self, client, mock_trace_reader):
        mock_trace_reader.get_span_io.return_value = SPAN_IO
        response = client.get("/api/v1/projects/test-project/traces/abc123/spans/span-1/io")
        assert response.status_code == 200
        data = response.json()
        assert data == {
            "span_id": "span-1",
            "trace_id": "abc123",
            "input": '{"prompt": "hello"}',
            "output": '{"completion": "world"}',
            "metadata": '{"traceroot.span.path": ["root"]}',
        }

    def test_passes_through_path_params(self, client, mock_trace_reader):
        mock_trace_reader.get_span_io.return_value = SPAN_IO
        client.get("/api/v1/projects/test-project/traces/abc123/spans/span-1/io")
        kw = mock_trace_reader.get_span_io.call_args.kwargs
        assert kw["project_id"] == "test-project"
        assert kw["trace_id"] == "abc123"
        assert kw["span_id"] == "span-1"

    def test_404_for_unknown_span(self, client, mock_trace_reader):
        mock_trace_reader.get_span_io.return_value = None
        response = client.get("/api/v1/projects/test-project/traces/abc123/spans/missing/io")
        assert response.status_code == 404

    def test_500_on_service_error(self, client, mock_trace_reader):
        """An unexpected reader error maps to the controlled 500 contract."""
        mock_trace_reader.get_span_io.side_effect = RuntimeError("clickhouse down")
        response = client.get("/api/v1/projects/test-project/traces/abc123/spans/span-1/io")
        assert response.status_code == 500
        assert response.json()["detail"] == "Failed to get span I/O"

    def test_null_io_fields_serialize(self, client, mock_trace_reader):
        """A span row that exists but has empty I/O still returns 200 with nulls."""
        mock_trace_reader.get_span_io.return_value = {
            "span_id": "span-1",
            "trace_id": "abc123",
            "input": None,
            "output": None,
            "metadata": None,
        }
        response = client.get("/api/v1/projects/test-project/traces/abc123/spans/span-1/io")
        assert response.status_code == 200
        data = response.json()
        assert data["input"] is None
        assert data["output"] is None
        assert data["metadata"] is None

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


class TestDashboardKeepsSpanTreeMetadata:
    """The dashboard route MUST return the reader's span-path metadata subset.

    This is the delivery path the live-tree repair depends on: children are
    exported before their parents, so mid-run the client only reconnects the
    tree because these path attributes ride along on the skeleton. The public
    routes deliberately drop them (their contract is `metadata: null`), which
    makes "drop them on this route too, for consistency" an inviting cleanup —
    one that would silently reintroduce the orphaned-tree bug. These tests fail
    if anyone does that.
    """

    TREE_METADATA = '{"traceroot.span.ids_path":["root-id"],"traceroot.span.path":["root","child"]}'

    def _trace_with_tree_metadata(self):
        trace = copy.deepcopy(TRACE_DETAIL)
        trace["spans"][0]["metadata"] = self.TREE_METADATA
        return trace

    def test_default_skeleton_preserves_the_subset(self, client, mock_trace_reader):
        mock_trace_reader.get_trace.return_value = self._trace_with_tree_metadata()
        response = client.get("/api/v1/projects/test-project/traces/abc123")
        assert response.status_code == 200
        assert response.json()["spans"][0]["metadata"] == self.TREE_METADATA
        mock_trace_reader.get_trace_spans_io.assert_not_called()

    def test_fields_io_preserves_the_subset(self, client, mock_trace_reader):
        """`fields=io` does not request metadata, so the subset stays — the
        dashboard still needs it to build the tree."""
        mock_trace_reader.get_trace.return_value = self._trace_with_tree_metadata()
        mock_trace_reader.get_trace_spans_io.return_value = {
            "span-1": {"input": "the-in", "output": "the-out"}
        }
        response = client.get("/api/v1/projects/test-project/traces/abc123?fields=io")
        assert response.status_code == 200
        span = response.json()["spans"][0]
        assert span["input"] == "the-in"
        assert span["metadata"] == self.TREE_METADATA

    def test_fields_full_replaces_subset_with_the_real_blob(self, client, mock_trace_reader):
        mock_trace_reader.get_trace.return_value = self._trace_with_tree_metadata()
        mock_trace_reader.get_trace_spans_io.return_value = {
            "span-1": {"input": "i", "output": "o", "metadata": '{"user":"real-blob"}'}
        }
        response = client.get("/api/v1/projects/test-project/traces/abc123?fields=full")
        assert response.status_code == 200
        assert response.json()["spans"][0]["metadata"] == '{"user":"real-blob"}'


@pytest.fixture()
def free_plan_client(mock_trace_reader):
    """TestClient with free-plan billing for retention gate tests."""

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


def _now_naive():
    return datetime.now(UTC).replace(tzinfo=None)


class TestRetentionGate:
    """Retention access-window enforcement on trace endpoints."""

    def test_list_traces_clamps_default_query(self, free_plan_client, mock_trace_reader):
        """Default list (no start_after) clamps to the plan's cutoff."""
        mock_trace_reader.list_traces.return_value = {
            "data": [],
            "meta": {"page": 0, "limit": 50, "total": 0},
        }
        response = free_plan_client.get("/api/v1/projects/test-project/traces")
        assert response.status_code == 200
        kw = mock_trace_reader.list_traces.call_args.kwargs
        assert kw["start_after"] is not None

    def test_list_traces_403_when_start_after_outside_window(self, free_plan_client):
        old = (_now_naive() - timedelta(days=30)).isoformat()
        response = free_plan_client.get(f"/api/v1/projects/test-project/traces?start_after={old}")
        assert response.status_code == 403
        detail = response.json()["detail"]
        assert detail["message"] == "Data outside retention window"
        assert detail["retention_days"] == 15

    def test_get_filter_values_403_when_outside_window(self, free_plan_client):
        old = (_now_naive() - timedelta(days=30)).isoformat()
        response = free_plan_client.get(
            f"/api/v1/projects/test-project/traces/filter-values/model_name?start_after={old}"
        )
        assert response.status_code == 403

    def test_get_trace_403_when_trace_outside_window(self, free_plan_client, mock_trace_reader):
        old_trace = {**TRACE_DETAIL, "trace_start_time": datetime(2020, 1, 1)}
        mock_trace_reader.get_trace.return_value = old_trace
        response = free_plan_client.get("/api/v1/projects/test-project/traces/old-trace")
        assert response.status_code == 403

    def test_get_trace_200_when_trace_in_window(self, free_plan_client, mock_trace_reader):
        recent_trace = {
            **TRACE_DETAIL,
            "trace_start_time": _now_naive() - timedelta(days=5),
        }
        mock_trace_reader.get_trace.return_value = recent_trace
        response = free_plan_client.get("/api/v1/projects/test-project/traces/recent-trace")
        assert response.status_code == 200

    def test_get_span_io_403_when_trace_outside_window(self, free_plan_client, mock_trace_reader):
        mock_trace_reader.get_trace.return_value = {
            "trace_start_time": datetime(2020, 1, 1),
        }
        mock_trace_reader.get_span_io.return_value = SPAN_IO
        response = free_plan_client.get(
            "/api/v1/projects/test-project/traces/old-trace/spans/span-1/io"
        )
        assert response.status_code == 403

    def test_get_span_io_200_when_trace_in_window(self, free_plan_client, mock_trace_reader):
        mock_trace_reader.get_trace.return_value = {
            "trace_start_time": _now_naive() - timedelta(days=1),
        }
        mock_trace_reader.get_span_io.return_value = SPAN_IO
        response = free_plan_client.get(
            "/api/v1/projects/test-project/traces/abc123/spans/span-1/io"
        )
        assert response.status_code == 200


class TestRetentionGateEnterprise:
    """Enterprise plan has no retention limit — uses the main client fixture (enterprise)."""

    def test_enterprise_list_no_clamp(self, client, mock_trace_reader):
        mock_trace_reader.list_traces.return_value = {
            "data": [],
            "meta": {"page": 0, "limit": 50, "total": 0},
        }
        response = client.get("/api/v1/projects/test-project/traces")
        assert response.status_code == 200
        kw = mock_trace_reader.list_traces.call_args.kwargs
        assert kw["start_after"] is None

    def test_enterprise_old_start_after_passes(self, client, mock_trace_reader):
        mock_trace_reader.list_traces.return_value = {
            "data": [],
            "meta": {"page": 0, "limit": 50, "total": 0},
        }
        response = client.get(
            "/api/v1/projects/test-project/traces?start_after=2020-01-01T00:00:00"
        )
        assert response.status_code == 200

    def test_enterprise_old_trace_accessible(self, client, mock_trace_reader):
        old_trace = {**TRACE_DETAIL, "trace_start_time": datetime(2020, 1, 1)}
        mock_trace_reader.get_trace.return_value = old_trace
        response = client.get("/api/v1/projects/test-project/traces/old")
        assert response.status_code == 200
