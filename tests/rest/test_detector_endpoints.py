"""Unit tests for the internal detector findings/runs endpoints (#806).

Covers the server-side filters (start_after/end_before/search_query — same
names trace/sessions/users use), the COUNT-driven pagination metadata, and
the {data, meta} response envelope.
"""

import gzip
import inspect
import logging
from datetime import datetime
from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient
from opentelemetry.proto.collector.trace.v1.trace_service_pb2 import (
    ExportTraceServiceRequest,
)

from rest.main import app
from shared.config import settings


@pytest.fixture()
def secret(monkeypatch):
    """Configure a known internal-secret so the auth dep accepts our header."""
    monkeypatch.setattr(settings, "internal_api_secret", "test-secret")
    return "test-secret"


@pytest.fixture()
def mock_ch(monkeypatch):
    """Mock the ClickHouse client used by the internal router."""
    mock = MagicMock()
    monkeypatch.setattr(
        "rest.routers.internal.get_clickhouse_client",
        lambda: mock,
    )
    return mock


@pytest.fixture()
def client(secret, mock_ch):
    return TestClient(app)


def _make_query_result(rows: list[tuple], column_names: list[str]) -> MagicMock:
    """Helper: shape ClickHouse-client-style result object."""
    r = MagicMock()
    r.result_rows = rows
    r.column_names = column_names
    return r


# =============================================================================
# /detector-runs
# =============================================================================


class TestListDetectorRuns:
    def _fake_data(self):
        ts = datetime(2026, 5, 1, 12, 0, 0)
        return _make_query_result(
            rows=[
                ("r1", "d1", "p1", "trace-bbb", "f1", "completed", ts, "summary text"),
            ],
            column_names=[
                "run_id",
                "detector_id",
                "project_id",
                "trace_id",
                "finding_id",
                "status",
                "timestamp",
                "summary",
            ],
        )

    def _fake_count(self, total: int):
        return _make_query_result(rows=[(total,)], column_names=["count()"])

    def test_returns_data_meta_envelope(self, client, mock_ch, secret):
        mock_ch.query.side_effect = [self._fake_data(), self._fake_count(1)]
        resp = client.get(
            "/api/v1/internal/detector-runs",
            params={"project_id": "p1", "detector_id": "d1"},
            headers={"X-Internal-Secret": secret},
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["meta"] == {"page": 0, "limit": 50, "total": 1}
        assert body["data"][0]["run_id"] == "r1"

    def test_search_query_hits_trace_id_and_joined_summary(self, client, mock_ch, secret):
        mock_ch.query.side_effect = [self._fake_data(), self._fake_count(0)]
        resp = client.get(
            "/api/v1/internal/detector-runs",
            params={"project_id": "p1", "detector_id": "d1", "search_query": "foo"},
            headers={"X-Internal-Secret": secret},
        )
        assert resp.status_code == 200
        data_sql = mock_ch.query.call_args_list[0].args[0]
        # Runs search must hit trace_id directly and the joined finding's
        # per-detector summary expression — confirm both are wired.
        assert "r.trace_id ILIKE" in data_sql
        assert "JSONExtractString" in data_sql  # the joined-summary expression
        assert "ILIKE {search_kw:String}" in data_sql

    def test_start_after_end_before_apply_to_run_timestamp(self, client, mock_ch, secret):
        mock_ch.query.side_effect = [self._fake_data(), self._fake_count(0)]
        client.get(
            "/api/v1/internal/detector-runs",
            params={
                "project_id": "p1",
                "detector_id": "d1",
                "start_after": "2026-04-01T00:00:00Z",
                "end_before": "2026-05-01T00:00:00Z",
            },
            headers={"X-Internal-Secret": secret},
        )
        data_sql = mock_ch.query.call_args_list[0].args[0]
        assert "r.timestamp >= {start_after:DateTime64(3)}" in data_sql
        assert "r.timestamp < {end_before:DateTime64(3)}" in data_sql

    def test_no_filters_means_no_extra_where(self, client, mock_ch, secret):
        """Bare query should have only project_id + detector_id conditions."""
        mock_ch.query.side_effect = [self._fake_data(), self._fake_count(1)]
        client.get(
            "/api/v1/internal/detector-runs",
            params={"project_id": "p1", "detector_id": "d1"},
            headers={"X-Internal-Secret": secret},
        )
        data_sql = mock_ch.query.call_args_list[0].args[0]
        assert "ILIKE" not in data_sql  # no search → no ILIKE
        assert "start_after" not in data_sql
        assert "end_before" not in data_sql
        # The Findings-view filter is off by default → no finding_id predicate
        # in the WHERE clause. (The summary `if()` expression mentions
        # finding_id unconditionally, so match the standalone AND-predicate.)
        assert "AND r.finding_id IS NOT NULL" not in data_sql

    def test_identified_filters_to_triggered_runs(self, client, mock_ch, secret):
        """identified=true restricts the listing to runs that fired a finding."""
        mock_ch.query.side_effect = [self._fake_data(), self._fake_count(1)]
        client.get(
            "/api/v1/internal/detector-runs",
            params={"project_id": "p1", "detector_id": "d1", "identified": "true"},
            headers={"X-Internal-Secret": secret},
        )
        # The predicate must reach both the data and the count WHERE clause so
        # the paginated total matches the filtered rows.
        data_sql = mock_ch.query.call_args_list[0].args[0]
        count_sql = mock_ch.query.call_args_list[1].args[0]
        assert "AND r.finding_id IS NOT NULL" in data_sql
        assert "AND r.finding_id IS NOT NULL" in count_sql

    def test_data_query_dedups_both_sides(self, client, mock_ch, secret):
        """Pre-merge ReplacingMergeTree duplicates must not fan out the JOIN."""
        mock_ch.query.side_effect = [self._fake_data(), self._fake_count(1)]
        client.get(
            "/api/v1/internal/detector-runs",
            params={"project_id": "p1", "detector_id": "d1"},
            headers={"X-Internal-Secret": secret},
        )
        data_sql = mock_ch.query.call_args_list[0].args[0]
        assert "(SELECT * FROM detector_runs FINAL) AS r" in data_sql
        assert "(SELECT * FROM detector_findings FINAL) AS f" in data_sql

    def test_count_query_dedups_both_sides(self, client, mock_ch, secret):
        mock_ch.query.side_effect = [self._fake_data(), self._fake_count(1)]
        client.get(
            "/api/v1/internal/detector-runs",
            params={"project_id": "p1", "detector_id": "d1"},
            headers={"X-Internal-Secret": secret},
        )
        count_sql = mock_ch.query.call_args_list[1].args[0]
        assert "(SELECT * FROM detector_runs FINAL) AS r" in count_sql
        assert "(SELECT * FROM detector_findings FINAL) AS f" in count_sql


# =============================================================================
# /traces/{trace_id}/detector-runs
# =============================================================================


class TestListTraceDetectorRuns:
    TS = datetime(2026, 6, 24, 12, 30, 45)

    def _fake_data(self):
        return _make_query_result(
            rows=[
                ("r1", "d-a", "p1", "trace-1", "f1", "triggered", self.TS, "Found it"),
                ("r2", "d-b", "p1", "trace-1", None, "clean", self.TS, ""),
            ],
            column_names=[
                "run_id",
                "detector_id",
                "project_id",
                "trace_id",
                "finding_id",
                "status",
                "timestamp",
                "summary",
            ],
        )

    def test_returns_runs_envelope_with_each_field(self, client, mock_ch, secret):
        mock_ch.query.return_value = self._fake_data()
        resp = client.get(
            "/api/v1/internal/traces/trace-1/detector-runs",
            params={"project_id": "p1"},
            headers={"X-Internal-Secret": secret},
        )
        assert resp.status_code == 200
        body = resp.json()
        assert set(body.keys()) == {"runs"}
        runs = body["runs"]
        assert len(runs) == 2

        assert runs[0] == {
            "run_id": "r1",
            "detector_id": "d-a",
            "project_id": "p1",
            "trace_id": "trace-1",
            "finding_id": "f1",
            "status": "triggered",
            "timestamp": self.TS.isoformat(),
            "summary": "Found it",
        }
        assert runs[1] == {
            "run_id": "r2",
            "detector_id": "d-b",
            "project_id": "p1",
            "trace_id": "trace-1",
            "finding_id": None,
            "status": "clean",
            "timestamp": self.TS.isoformat(),
            "summary": "",
        }

    def test_filters_by_trace_and_project(self, client, mock_ch, secret):
        mock_ch.query.return_value = _make_query_result(rows=[], column_names=[])
        resp = client.get(
            "/api/v1/internal/traces/trace-9/detector-runs",
            params={"project_id": "p9"},
            headers={"X-Internal-Secret": secret},
        )
        assert resp.status_code == 200
        mock_ch.query.assert_called_once()
        params = mock_ch.query.call_args.kwargs["parameters"]
        assert params == {"trace_id": "trace-9", "project_id": "p9"}
        sql = mock_ch.query.call_args.args[0]
        assert "r.trace_id = {trace_id:String}" in sql
        assert "r.project_id = {project_id:String}" in sql

    def test_uses_final_on_both_tables(self, client, mock_ch, secret):
        mock_ch.query.return_value = _make_query_result(rows=[], column_names=[])
        client.get(
            "/api/v1/internal/traces/trace-1/detector-runs",
            params={"project_id": "p1"},
            headers={"X-Internal-Secret": secret},
        )
        sql = mock_ch.query.call_args.args[0]
        assert "detector_runs FINAL" in sql
        assert "detector_findings FINAL" in sql

    def test_missing_secret_returns_403(self, client, mock_ch):
        resp = client.get(
            "/api/v1/internal/traces/trace-1/detector-runs",
            params={"project_id": "p1"},
        )
        assert resp.status_code == 403


# =============================================================================
# POST /detector-findings
# =============================================================================


class TestWriteDetectorFinding:
    def _body(self) -> dict:
        return {
            "findingId": "f1",
            "projectId": "p1",
            "traceId": "trace-aaa",
            "summary": "summary text",
            "payload": "{}",
        }

    def test_writes_finding_row(self, client, mock_ch, secret):
        resp = client.post(
            "/api/v1/internal/detector-findings",
            json=self._body(),
            headers={"X-Internal-Secret": secret},
        )
        assert resp.status_code == 200
        sql = mock_ch.query.call_args.args[0]
        assert "INSERT INTO detector_findings" in sql
        assert "retracted" not in sql

    def test_stamps_timestamp_when_provided(self, client, mock_ch, secret):
        resp = client.post(
            "/api/v1/internal/detector-findings",
            json={**self._body(), "timestampMs": 1_700_000_000_123},
            headers={"X-Internal-Secret": secret},
        )
        assert resp.status_code == 200
        sql = mock_ch.query.call_args.args[0]
        params = mock_ch.query.call_args.kwargs["parameters"]
        assert "fromUnixTimestamp64Milli({timestamp_ms:Int64})" in sql
        assert params["timestamp_ms"] == 1_700_000_000_123

    def test_omits_timestamp_when_absent(self, client, mock_ch, secret):
        resp = client.post(
            "/api/v1/internal/detector-findings",
            json=self._body(),
            headers={"X-Internal-Secret": secret},
        )
        assert resp.status_code == 200
        sql = mock_ch.query.call_args.args[0]
        params = mock_ch.query.call_args.kwargs["parameters"]
        assert "fromUnixTimestamp64Milli" not in sql
        assert "timestamp_ms" not in params


class TestWriteDetectorRun:
    def _body(self) -> dict:
        return {
            "runId": "r1",
            "detectorId": "d1",
            "projectId": "p1",
            "traceId": "trace-aaa",
            "findingId": "f1",
            "status": "completed",
        }

    def test_writes_run_row(self, client, mock_ch, secret):
        resp = client.post(
            "/api/v1/internal/detector-runs",
            json=self._body(),
            headers={"X-Internal-Secret": secret},
        )
        assert resp.status_code == 200
        sql = mock_ch.query.call_args.args[0]
        assert "INSERT INTO detector_runs" in sql

    def test_stamps_timestamp_when_provided(self, client, mock_ch, secret):
        resp = client.post(
            "/api/v1/internal/detector-runs",
            json={**self._body(), "timestampMs": 1_700_000_000_123},
            headers={"X-Internal-Secret": secret},
        )
        assert resp.status_code == 200
        sql = mock_ch.query.call_args.args[0]
        params = mock_ch.query.call_args.kwargs["parameters"]
        assert "fromUnixTimestamp64Milli({timestamp_ms:Int64})" in sql
        assert params["timestamp_ms"] == 1_700_000_000_123

    def test_omits_timestamp_when_absent(self, client, mock_ch, secret):
        resp = client.post(
            "/api/v1/internal/detector-runs",
            json=self._body(),
            headers={"X-Internal-Secret": secret},
        )
        assert resp.status_code == 200
        sql = mock_ch.query.call_args.args[0]
        params = mock_ch.query.call_args.kwargs["parameters"]
        assert "fromUnixTimestamp64Milli" not in sql
        assert "timestamp_ms" not in params


# =============================================================================
# /traces/{trace_id}/findings
# =============================================================================


class TestGetTraceFindings:
    def test_dedups_with_final(self, client, mock_ch, secret):
        ts = datetime(2026, 5, 1, 12, 0, 0)
        mock_ch.query.return_value = _make_query_result(
            rows=[("f1", "p1", "trace-aaa", "summary text", "{}", ts)],
            column_names=[
                "finding_id",
                "project_id",
                "trace_id",
                "summary",
                "payload",
                "timestamp",
            ],
        )
        resp = client.get(
            "/api/v1/internal/traces/trace-aaa/findings",
            params={"project_id": "p1"},
            headers={"X-Internal-Secret": secret},
        )
        assert resp.status_code == 200
        assert resp.json()["findings"][0]["finding_id"] == "f1"
        sql = mock_ch.query.call_args.args[0]
        assert "FROM detector_findings FINAL" in sql


# =============================================================================
# Auth — both endpoints
# =============================================================================


class TestInternalAuth:
    def test_missing_secret_rejected(self, client, mock_ch):
        resp = client.get(
            "/api/v1/internal/detector-runs",
            params={"project_id": "p1", "detector_id": "d1"},
        )
        assert resp.status_code == 403

    def test_wrong_secret_rejected(self, client, mock_ch, secret):
        resp = client.get(
            "/api/v1/internal/detector-runs",
            params={"project_id": "p1", "detector_id": "d1"},
            headers={"X-Internal-Secret": "wrong"},
        )
        assert resp.status_code == 403


# =============================================================================
# /detector-window-summary (#810)
# =============================================================================


class TestListDetectorWindowSummary:
    def _fake_aggregate(self, rows: list[tuple]):
        # Rows are (detector_id, run_count, finding_count, latest_trace_id).
        return _make_query_result(
            rows=rows,
            column_names=["detector_id", "run_count", "finding_count", "latest_trace_id"],
        )

    def test_returns_per_detector_counts(self, client, mock_ch, secret):
        mock_ch.query.side_effect = [
            self._fake_aggregate([("d-a", 100, 7, "t-a"), ("d-b", 25, 0, "")]),
        ]
        resp = client.get(
            "/api/v1/internal/detector-window-summary",
            params={
                "project_id": "p1",
                "start_after": "2026-04-20T00:00:00Z",
            },
            headers={"X-Internal-Secret": secret},
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body == {
            "data": {
                "d-a": {"finding_count": 7, "run_count": 100, "sample_trace_ids": ["t-a"]},
                "d-b": {"finding_count": 0, "run_count": 25, "sample_trace_ids": []},
            }
        }

    def test_empty_when_no_runs_in_window(self, client, mock_ch, secret):
        mock_ch.query.side_effect = [self._fake_aggregate([])]
        resp = client.get(
            "/api/v1/internal/detector-window-summary",
            params={
                "project_id": "p1",
                "start_after": "2026-04-20T00:00:00Z",
            },
            headers={"X-Internal-Secret": secret},
        )
        assert resp.status_code == 200
        assert resp.json() == {"data": {}}

    def test_passes_end_before_when_provided(self, client, mock_ch, secret):
        mock_ch.query.side_effect = [self._fake_aggregate([])]
        client.get(
            "/api/v1/internal/detector-window-summary",
            params={
                "project_id": "p1",
                "start_after": "2026-04-20T00:00:00Z",
                "end_before": "2026-05-01T00:00:00Z",
            },
            headers={"X-Internal-Secret": secret},
        )
        call_args = mock_ch.query.call_args
        sql = call_args.args[0] if call_args.args else call_args.kwargs.get("query")
        params = call_args.kwargs.get("parameters", {})
        # The window upper bound is applied to the collapsed timestamp (ts), not
        # the raw rows.
        assert "ts <" in sql
        assert "end_before" in params

    def test_omits_end_before_when_absent(self, client, mock_ch, secret):
        mock_ch.query.side_effect = [self._fake_aggregate([])]
        client.get(
            "/api/v1/internal/detector-window-summary",
            params={
                "project_id": "p1",
                "start_after": "2026-04-20T00:00:00Z",
            },
            headers={"X-Internal-Secret": secret},
        )
        call_args = mock_ch.query.call_args
        sql = call_args.args[0] if call_args.args else call_args.kwargs.get("query")
        params = call_args.kwargs.get("parameters", {})
        assert "ts <" not in sql
        assert "end_before" not in params

    def test_requires_internal_secret(self, client, mock_ch):
        resp = client.get(
            "/api/v1/internal/detector-window-summary",
            params={"project_id": "p1", "start_after": "2026-04-20T00:00:00Z"},
        )
        assert resp.status_code == 403

    def test_requires_start_after(self, client, mock_ch, secret):
        resp = client.get(
            "/api/v1/internal/detector-window-summary",
            params={"project_id": "p1"},
            headers={"X-Internal-Secret": secret},
        )
        assert resp.status_code == 422

    def test_dedups_via_argmax_without_final(self, client, mock_ch, secret):
        """Runs are deduped by run_id via argMax (no FINAL), and finding_count
        comes straight off the run's finding_id (no detector_findings JOIN)."""
        mock_ch.query.side_effect = [self._fake_aggregate([("d-a", 10, 3, "t-x")])]
        resp = client.get(
            "/api/v1/internal/detector-window-summary",
            params={
                "project_id": "p1",
                "start_after": "2026-04-20T00:00:00Z",
            },
            headers={"X-Internal-Secret": secret},
        )
        assert resp.status_code == 200
        sql = mock_ch.query.call_args.args[0]
        # No FINAL — the OOM-shaped merge-on-read is gone.
        assert "FINAL" not in sql
        # Dedup is an argMax aggregate per run_id.
        assert "GROUP BY detector_id, run_id" in sql
        assert "argMax(finding_id, timestamp)" in sql
        # Finding count straight off the collapsed run; no findings JOIN.
        assert "countIf(latest_finding_id IS NOT NULL)" in sql
        assert "JOIN" not in sql

    def test_dedups_before_windowing(self, client, mock_ch, secret):
        """The window filter is applied to the collapsed timestamp (ts), AFTER
        the per-run dedup — so a retry that re-stamps across a window boundary is
        placed by its latest version, matching FINAL's semantics."""
        mock_ch.query.side_effect = [self._fake_aggregate([])]
        client.get(
            "/api/v1/internal/detector-window-summary",
            params={
                "project_id": "p1",
                "start_after": "2026-04-20T00:00:00Z",
                "end_before": "2026-05-01T00:00:00Z",
            },
            headers={"X-Internal-Secret": secret},
        )
        sql = mock_ch.query.call_args.args[0]
        # The inner dedup (GROUP BY run_id) must come before the outer window
        # filter on the collapsed ts.
        assert sql.index("GROUP BY detector_id, run_id") < sql.index("ts >=")
        assert sql.index("GROUP BY detector_id, run_id") < sql.index("ts <")

    def test_returns_sample_trace_ids(self, client, mock_ch, secret):
        """The latest *triggered* run's trace (argMaxIf) is surfaced as a
        one-element sample_trace_ids list."""
        mock_ch.query.side_effect = [self._fake_aggregate([("d-a", 10, 3, "trace-latest")])]
        resp = client.get(
            "/api/v1/internal/detector-window-summary",
            params={
                "project_id": "p1",
                "start_after": "2026-04-20T00:00:00Z",
            },
            headers={"X-Internal-Secret": secret},
        )
        assert resp.json()["data"]["d-a"]["sample_trace_ids"] == ["trace-latest"]
        sql = mock_ch.query.call_args.args[0]
        assert "argMaxIf(latest_trace_id, ts, latest_finding_id IS NOT NULL)" in sql

    def test_detector_with_runs_but_no_findings(self, client, mock_ch, secret):
        # A detector that ran 10 times but never triggered: 0 findings, 10 runs,
        # and no sample traces (argMaxIf over no triggered runs -> "" -> []).
        mock_ch.query.side_effect = [self._fake_aggregate([("d-a", 10, 0, "")])]
        resp = client.get(
            "/api/v1/internal/detector-window-summary",
            params={
                "project_id": "p1",
                "start_after": "2026-04-20T00:00:00Z",
            },
            headers={"X-Internal-Secret": secret},
        )
        assert resp.json() == {
            "data": {"d-a": {"finding_count": 0, "run_count": 10, "sample_trace_ids": []}}
        }


# =============================================================================
# /traces (internal OTLP ingest for detector self-traces)
# =============================================================================


def _otlp_body(
    trace_id: bytes = b"\xab" * 16,
    compress: bool = False,
    extra_trace_ids: tuple[bytes, ...] = (),
    span_id: bytes = b"\x01" * 8,
    parent_span_id: bytes | None = None,
) -> bytes:
    """Serialize an OTLP ExportTraceServiceRequest with one span per trace id."""
    request = ExportTraceServiceRequest()
    resource_spans = request.resource_spans.add()
    scope_spans = resource_spans.scope_spans.add()
    scope_spans.scope.name = "test-internal-ingest"
    for index, tid in enumerate((trace_id, *extra_trace_ids)):
        span = scope_spans.spans.add()
        span.trace_id = tid
        span.span_id = span_id if index == 0 else bytes([index + 1]) * 8
        if index == 0 and parent_span_id is not None:
            span.parent_span_id = parent_span_id
        span.name = "detector-run"
        span.start_time_unix_nano = 1700000000000000000
        span.end_time_unix_nano = 1700000001000000000
    body = request.SerializeToString()
    return gzip.compress(body) if compress else body


class TestInternalTraceIngest:
    URL = "/api/v1/internal/traces?project_id=proj-1"

    def test_rejects_missing_secret(self, client):
        resp = client.post(self.URL, content=_otlp_body())
        assert resp.status_code == 403

    def test_rejects_malformed_trace_id(self, client, secret, mock_ch):
        """An 8-byte trace id decodes to 16 hex chars and must be rejected."""
        resp = client.post(
            self.URL,
            content=_otlp_body(trace_id=b"\xab" * 8),
            headers={"X-Internal-Secret": secret},
        )
        assert resp.status_code == 400
        mock_ch.insert_spans_batch.assert_not_called()
        mock_ch.insert_traces_batch.assert_not_called()

    def test_rejects_empty_and_invalid_bodies(self, client, secret, mock_ch, caplog):
        resp = client.post(self.URL, content=b"", headers={"X-Internal-Secret": secret})
        assert resp.status_code == 400

        # An undecodable body means a bug in our own tracer — it must leave
        # a warning breadcrumb, not fail silently.
        with caplog.at_level(logging.WARNING):
            resp = client.post(
                self.URL, content=b"not-protobuf-at-all", headers={"X-Internal-Secret": secret}
            )
        assert resp.status_code == 400
        assert any("protobuf" in record.getMessage().lower() for record in caplog.records)
        mock_ch.insert_spans_batch.assert_not_called()

    def test_zero_span_payload_is_ok(self, client, secret, mock_ch):
        """A valid payload with no spans no-ops cleanly instead of erroring."""
        request = ExportTraceServiceRequest()
        request.resource_spans.add().scope_spans.add().scope.name = "empty-batch"

        resp = client.post(
            self.URL,
            content=request.SerializeToString(),
            headers={"X-Internal-Secret": secret},
        )

        assert resp.status_code == 200
        assert resp.json() == {"ok": True}
        assert mock_ch.insert_spans_batch.call_args[0][0] == []
        assert mock_ch.insert_traces_batch.call_args[0][0] == []

    def test_rejects_malformed_span_id(self, client, secret, mock_ch):
        """A 4-byte span id decodes to 8 hex chars and must be rejected."""
        resp = client.post(
            self.URL,
            content=_otlp_body(span_id=b"\x01" * 4),
            headers={"X-Internal-Secret": secret},
        )
        assert resp.status_code == 400
        mock_ch.insert_spans_batch.assert_not_called()
        mock_ch.insert_traces_batch.assert_not_called()

    def test_rejects_malformed_parent_span_id(self, client, secret, mock_ch):
        """parent_span_id must be absent (root span) or a full 16-hex id."""
        resp = client.post(
            self.URL,
            content=_otlp_body(parent_span_id=b"\x02" * 4),
            headers={"X-Internal-Secret": secret},
        )
        assert resp.status_code == 400
        mock_ch.insert_spans_batch.assert_not_called()
        mock_ch.insert_traces_batch.assert_not_called()

    def test_accepts_valid_parent_span_id(self, client, secret, mock_ch):
        resp = client.post(
            self.URL,
            content=_otlp_body(parent_span_id=b"\x02" * 8),
            headers={"X-Internal-Secret": secret},
        )
        assert resp.status_code == 200
        spans = mock_ch.insert_spans_batch.call_args[0][0]
        assert spans[0]["parent_span_id"] == "02" * 8

    def test_multi_trace_payload_validates_every_id(self, client, secret, mock_ch):
        """One malformed id among several traces rejects the whole payload."""
        resp = client.post(
            self.URL,
            content=_otlp_body(extra_trace_ids=(b"\xcd" * 8,)),
            headers={"X-Internal-Secret": secret},
        )
        assert resp.status_code == 400
        mock_ch.insert_spans_batch.assert_not_called()
        mock_ch.insert_traces_batch.assert_not_called()

    def test_inserts_detector_source_spans_before_trace(self, client, secret, mock_ch):
        """Rows land with source='detector'; spans insert before the trace row."""
        resp = client.post(self.URL, content=_otlp_body(), headers={"X-Internal-Secret": secret})
        assert resp.status_code == 200
        assert resp.json() == {"ok": True}

        spans = mock_ch.insert_spans_batch.call_args[0][0]
        traces = mock_ch.insert_traces_batch.call_args[0][0]
        assert spans and all(s["source"] == "detector" for s in spans)
        assert traces and all(t["source"] == "detector" for t in traces)
        assert all(s["project_id"] == "proj-1" for s in spans)
        assert all(t["project_id"] == "proj-1" for t in traces)
        assert all(t["trace_id"] == "ab" * 16 for t in traces)

        # Spans first: a partial failure must not leave a trace row that
        # points at missing spans.
        call_order = [name for name, _args, _kw in mock_ch.method_calls]
        assert call_order.index("insert_spans_batch") < call_order.index("insert_traces_batch")

    def test_rejects_corrupt_gzip_body(self, client, secret, mock_ch, caplog):
        with caplog.at_level(logging.WARNING):
            resp = client.post(
                self.URL,
                content=b"\x1f\x8b-not-actually-gzip",
                headers={"X-Internal-Secret": secret, "Content-Encoding": "gzip"},
            )
        assert resp.status_code == 400
        assert any("gzip" in record.getMessage().lower() for record in caplog.records)
        mock_ch.insert_spans_batch.assert_not_called()

    def test_accepts_gzip_body(self, client, secret, mock_ch):
        resp = client.post(
            self.URL,
            content=_otlp_body(compress=True),
            headers={"X-Internal-Secret": secret, "Content-Encoding": "gzip"},
        )
        assert resp.status_code == 200
        assert mock_ch.insert_spans_batch.called

    def test_route_never_references_detection_enqueue(self):
        """Anti-recursion by construction: the module cannot enqueue detection."""
        import rest.routers.internal as internal_module

        assert "enqueue_detector_runs" not in inspect.getsource(internal_module)
