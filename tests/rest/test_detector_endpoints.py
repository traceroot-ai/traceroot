"""Unit tests for the internal detector findings/runs endpoints (#806).

Covers the server-side filters (start_after/end_before/search_query — same
names trace/sessions/users use), the COUNT-driven pagination metadata, and
the {data, meta} response envelope.
"""

from datetime import datetime
from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient

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
                "d-a": {
                    "finding_count": 7,
                    "run_count": 100,
                    "sample_trace_ids": ["t-a"],
                    "sample_summaries": [],
                },
                "d-b": {
                    "finding_count": 0,
                    "run_count": 25,
                    "sample_trace_ids": [],
                    "sample_summaries": [],
                },
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
            "data": {
                "d-a": {
                    "finding_count": 0,
                    "run_count": 10,
                    "sample_trace_ids": [],
                    "sample_summaries": [],
                }
            }
        }

    # ── include_summaries (digest LLM-summary sample) ────────────────────────

    def _fake_summaries(self, rows: list[tuple]):
        # Rows are (detector_id, summary) from the capped summaries query,
        # already rank-major ordered by the SQL.
        return _make_query_result(rows=rows, column_names=["detector_id", "summary"])

    def _get(self, client, secret, **extra_params):
        return client.get(
            "/api/v1/internal/detector-window-summary",
            params={
                "project_id": "p1",
                "start_after": "2026-04-20T00:00:00Z",
                **extra_params,
            },
            headers={"X-Internal-Secret": secret},
        )

    def test_include_summaries_appends_rows_in_order(self, client, mock_ch, secret):
        mock_ch.query.side_effect = [
            self._fake_aggregate([("d-a", 100, 7, "t-a"), ("d-b", 25, 0, "")]),
            self._fake_summaries([("d-a", "newest sentence"), ("d-a", "older sentence")]),
        ]
        resp = self._get(client, secret, include_summaries="true")
        assert resp.status_code == 200
        data = resp.json()["data"]
        assert data["d-a"]["sample_summaries"] == ["newest sentence", "older sentence"]
        assert data["d-b"]["sample_summaries"] == []
        # Counts are untouched by the summaries read.
        assert data["d-a"]["finding_count"] == 7

    def test_summaries_query_is_capped_and_time_bounded(self, client, mock_ch, secret):
        mock_ch.query.side_effect = [
            self._fake_aggregate([("d-a", 10, 3, "t-a")]),
            self._fake_summaries([]),
        ]
        self._get(client, secret, include_summaries="true")
        assert mock_ch.query.call_count == 2
        second = mock_ch.query.call_args_list[1]
        sql = second.args[0] if second.args else second.kwargs.get("query")
        # SQL-side caps: per-detector LIMIT BY, total LIMIT, UTF8-safe substring
        # (a byte-based cut can hex-garble a multibyte summary), rank-major order.
        assert "LIMIT 10 BY detector_id" in sql
        assert "LIMIT 40" in sql
        assert "substringUTF8" in sql
        assert "ORDER BY rank ASC, ts DESC" in sql
        # Semi-join: the FINAL read must touch only the sampled findings'
        # payloads, never the project's whole finding history.
        assert "finding_id IN (" in sql
        # Bounded read: a stalled query degrades to counts-only via the except
        # path rather than holding the caller open.
        assert second.kwargs.get("settings") == {"max_execution_time": 10}

    def test_include_summaries_defaults_off(self, client, mock_ch, secret):
        mock_ch.query.side_effect = [self._fake_aggregate([("d-a", 100, 7, "t-a")])]
        resp = self._get(client, secret)
        assert resp.status_code == 200
        assert mock_ch.query.call_count == 1
        assert resp.json()["data"]["d-a"]["sample_summaries"] == []

    def test_include_summaries_skips_query_when_nothing_triggered(self, client, mock_ch, secret):
        # finding_count == 0 everywhere -> there is nothing to sample, so the
        # second query is never issued even with the flag set.
        mock_ch.query.side_effect = [self._fake_aggregate([("d-a", 10, 0, "")])]
        resp = self._get(client, secret, include_summaries="true")
        assert resp.status_code == 200
        assert mock_ch.query.call_count == 1
        assert resp.json()["data"]["d-a"]["sample_summaries"] == []

    def test_summaries_read_failure_degrades_to_counts_only(self, client, mock_ch, secret):
        # The summaries read is best-effort: a ClickHouse error (including the
        # execution-time cap) must never fail the endpoint — counts still return.
        mock_ch.query.side_effect = [
            self._fake_aggregate([("d-a", 100, 7, "t-a")]),
            RuntimeError("TIMEOUT_EXCEEDED"),
        ]
        resp = self._get(client, secret, include_summaries="true")
        assert resp.status_code == 200
        data = resp.json()["data"]
        assert data["d-a"]["finding_count"] == 7
        assert data["d-a"]["sample_summaries"] == []

    def test_summaries_for_unknown_detector_ids_are_dropped(self, client, mock_ch, secret):
        # Defensive: a summaries row whose detector is absent from the counts
        # map (shouldn't happen — same window) is ignored, not KeyError'd.
        mock_ch.query.side_effect = [
            self._fake_aggregate([("d-a", 100, 7, "t-a")]),
            self._fake_summaries([("d-ghost", "orphan sentence"), ("d-a", "kept sentence")]),
        ]
        resp = self._get(client, secret, include_summaries="true")
        assert resp.status_code == 200
        data = resp.json()["data"]
        assert data["d-a"]["sample_summaries"] == ["kept sentence"]
        assert "d-ghost" not in data
