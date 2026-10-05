"""Unit tests for the internal signal assignment endpoints.

The SQL runs against a stubbed ClickHouse client here; the queries' semantics
(FINAL collapse, the anti-join, payload extraction) were checked against a live
ClickHouse when the endpoints were written.
"""

import json
from datetime import UTC, datetime
from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient

from rest.main import app
from shared.config import settings

HEADERS = {"X-Internal-Secret": "test-secret"}
BASE = "/api/v1/internal/signals"


@pytest.fixture()
def mock_ch(monkeypatch):
    monkeypatch.setattr(settings, "internal_api_secret", "test-secret")
    mock = MagicMock()
    monkeypatch.setattr("rest.routers.internal.signals.get_clickhouse_client", lambda: mock)
    return mock


@pytest.fixture()
def client(mock_ch):
    return TestClient(app)


def _result(rows, columns=None):
    r = MagicMock()
    r.result_rows = rows
    r.column_names = columns or []
    return r


RUN_COLS = ["run_id", "trace_id", "finding_id", "timestamp_ms"]


def _entry(detector_id, summary, data):
    return json.dumps({"detectorId": detector_id, "summary": summary, "data": data})


class TestWaitingHits:
    def test_returns_hits_with_their_detector_output_and_trace_start(self, client, mock_ch):
        mock_ch.query.side_effect = [
            _result([("r1", "t1", "f1", 1000), ("r2", "t2", "f2", 2000)], RUN_COLS),
            _result([("f1", _entry("d1", "tool timed out", {"tool": "search"}))]),
            _result([("t1", 900)]),
        ]
        resp = client.get(
            f"{BASE}/waiting-hits",
            params={"project_id": "p1", "detector_id": "d1", "since_ms": 500},
            headers=HEADERS,
        )
        assert resp.status_code == 200
        assert resp.json() == {
            "data": [
                {
                    "run_id": "r1",
                    "trace_id": "t1",
                    "finding_id": "f1",
                    "timestamp_ms": 1000,
                    "trace_start_ms": 900,
                    "summary": "tool timed out",
                    "data": {"tool": "search"},
                },
                # No payload entry or trace row: empty output and no start.
                {
                    "run_id": "r2",
                    "trace_id": "t2",
                    "finding_id": "f2",
                    "timestamp_ms": 2000,
                    "trace_start_ms": None,
                    "summary": "",
                    "data": {},
                },
            ]
        }

    def test_runs_query_collapses_runs_and_excludes_assigned_ones(self, client, mock_ch):
        mock_ch.query.side_effect = [_result([], RUN_COLS)]
        resp = client.get(
            f"{BASE}/waiting-hits",
            params={"project_id": "p1", "detector_id": "d1", "since_ms": 1_000, "limit": 50},
            headers=HEADERS,
        )
        assert resp.json() == {"data": []}
        # Nothing waiting: no payload or trace lookups.
        assert mock_ch.query.call_count == 1
        sql = mock_ch.query.call_args.args[0]
        params = mock_ch.query.call_args.kwargs["parameters"]
        assert "FROM detector_runs FINAL" in sql
        assert "finding_id IS NOT NULL" in sql
        assert "status = 'completed'" in sql
        assert "run_id NOT IN" in sql and "FROM signal_assignments" in sql
        # A run's assignment counts however long ago it was written: a trace
        # evaluated again keeps its run id, and must not wait forever.
        assignments = sql[sql.index("FROM signal_assignments") :]
        assert "assigned_at" not in assignments
        # Status and finding filters run after the collapse, the time filter before.
        assert (
            sql.index("FINAL")
            < sql.index("timestamp >= {since")
            < sql.index("finding_id IS NOT NULL")
        )
        assert "ORDER BY timestamp_ms, run_id" in sql
        assert params["since"] == datetime(1970, 1, 1, 0, 0, 1, tzinfo=UTC)
        assert params["limit"] == 50
        assert params["project_id"] == "p1" and params["detector_id"] == "d1"

    def test_payload_lookup_is_scoped_to_the_detector_and_the_hits(self, client, mock_ch):
        mock_ch.query.side_effect = [
            _result([("r1", "t1", "f1", 1000)], RUN_COLS),
            _result([]),
            _result([]),
        ]
        client.get(
            f"{BASE}/waiting-hits",
            params={"project_id": "p1", "detector_id": "d1", "since_ms": 0},
            headers=HEADERS,
        )
        payload_call, trace_call = mock_ch.query.call_args_list[1:]
        assert "JSONExtractString(x, 'detectorId') = {detector_id:String}" in payload_call.args[0]
        assert "argMax(payload, timestamp)" in payload_call.args[0]
        assert payload_call.kwargs["parameters"]["finding_ids"] == ["f1"]
        assert payload_call.kwargs["parameters"]["trace_ids"] == ["t1"]
        assert "min(trace_start_time)" in trace_call.args[0]
        assert trace_call.kwargs["parameters"] == {"project_id": "p1", "trace_ids": ["t1"]}

    def test_keeps_unparseable_data_as_text(self, client, mock_ch):
        raw = '{"detectorId":"d1","summary":"s","data":"plain text"}'
        mock_ch.query.side_effect = [
            _result([("r1", "t1", "f1", 1000)], RUN_COLS),
            _result([("f1", raw)]),
            _result([]),
        ]
        body = client.get(
            f"{BASE}/waiting-hits",
            params={"project_id": "p1", "detector_id": "d1", "since_ms": 0},
            headers=HEADERS,
        ).json()
        assert body["data"][0]["data"] == "plain text"

    def test_ignores_a_malformed_payload_entry(self, client, mock_ch):
        mock_ch.query.side_effect = [
            _result([("r1", "t1", "f1", 1000)], RUN_COLS),
            _result([("f1", "not json")]),
            _result([]),
        ]
        body = client.get(
            f"{BASE}/waiting-hits",
            params={"project_id": "p1", "detector_id": "d1", "since_ms": 0},
            headers=HEADERS,
        ).json()
        assert body["data"][0]["summary"] == "" and body["data"][0]["data"] == {}

    @pytest.mark.parametrize("params", [{"since_ms": -1}, {"since_ms": 0, "limit": 501}, {}])
    def test_rejects_bad_parameters(self, client, mock_ch, params):
        resp = client.get(
            f"{BASE}/waiting-hits",
            params={"project_id": "p1", "detector_id": "d1", **params},
            headers=HEADERS,
        )
        assert resp.status_code == 422
        mock_ch.query.assert_not_called()


class TestWriteAssignments:
    def _row(self, **over):
        row = {
            "project_id": "p1",
            "detector_id": "d1",
            "run_id": "r1",
            "trace_id": "t1",
            "signal_id": "s1",
            "embedding": [0.1, 0.2],
            "score": 0.95,
            "criteria_version": 2,
            "assigned_at_ms": 1_700_000_000_000,
        }
        row.update(over)
        return row

    def test_inserts_rows_with_an_aware_assigned_at(self, client, mock_ch):
        resp = client.post(
            f"{BASE}/assignments",
            json={
                "rows": [
                    self._row(),
                    self._row(run_id="r2", score=None, criteria_version=None, embedding=[]),
                ]
            },
            headers=HEADERS,
        )
        assert resp.json() == {"ok": True, "written": 2}
        rows = mock_ch.insert_signal_assignments.call_args.args[0]
        assert rows[0] == {
            "project_id": "p1",
            "detector_id": "d1",
            "run_id": "r1",
            "trace_id": "t1",
            "signal_id": "s1",
            "embedding": [0.1, 0.2],
            "score": 0.95,
            "criteria_version": 2,
            "assigned_at": datetime.fromtimestamp(1_700_000_000, tz=UTC),
        }
        assert rows[1]["score"] is None and rows[1]["embedding"] == []

    @pytest.mark.parametrize(
        "bad",
        [
            {"embedding": [0.0] * 4097},
            {"criteria_version": -1},
            {"assigned_at_ms": -5},
        ],
    )
    def test_rejects_malformed_rows(self, client, mock_ch, bad):
        resp = client.post(
            f"{BASE}/assignments", json={"rows": [self._row(**bad)]}, headers=HEADERS
        )
        assert resp.status_code == 422
        mock_ch.insert_signal_assignments.assert_not_called()

    def test_accepts_a_given_up_hit_with_an_empty_signal(self, client, mock_ch):
        resp = client.post(
            f"{BASE}/assignments",
            json={
                "rows": [self._row(signal_id="", gave_up=True, score=None, criteria_version=None)]
            },
            headers=HEADERS,
        )
        assert resp.status_code == 200
        row = mock_ch.insert_signal_assignments.call_args.args[0][0]
        assert row["signal_id"] == "" and "gave_up" not in row

    @pytest.mark.parametrize(
        "bad", [{"signal_id": "", "gave_up": False}, {"signal_id": "s1", "gave_up": True}]
    )
    def test_signal_id_is_empty_exactly_when_given_up(self, client, mock_ch, bad):
        resp = client.post(
            f"{BASE}/assignments", json={"rows": [self._row(**bad)]}, headers=HEADERS
        )
        assert resp.status_code == 422
        mock_ch.insert_signal_assignments.assert_not_called()

    def test_caps_rows_per_call(self, client, mock_ch):
        resp = client.post(
            f"{BASE}/assignments", json={"rows": [self._row()] * 501}, headers=HEADERS
        )
        assert resp.status_code == 422


class TestUnsettledRuns:
    def test_lists_fired_runs_of_the_findings_with_no_assignment_row(self, client, mock_ch):
        mock_ch.query.return_value = _result([("f1", "r1", "d1", 1000), ("f2", "r2", "d2", 2000)])
        resp = client.post(
            f"{BASE}/unsettled-runs",
            json={"project_id": "p1", "finding_ids": ["f1", "f2"], "since_ms": 500},
            headers=HEADERS,
        )
        assert resp.status_code == 200
        assert resp.json()["data"] == [
            {"finding_id": "f1", "run_id": "r1", "detector_id": "d1", "timestamp_ms": 1000},
            {"finding_id": "f2", "run_id": "r2", "detector_id": "d2", "timestamp_ms": 2000},
        ]
        sql = mock_ch.query.call_args.args[0]
        # Collapsed like waiting-hits, and any assignment row (a give-up too) settles a run,
        # however long ago it was written.
        assert "detector_runs FINAL" in sql and "NOT IN" in sql and "signal_assignments" in sql
        assert "assigned_at" not in sql[sql.index("FROM signal_assignments") :]
        params = mock_ch.query.call_args.kwargs["parameters"]
        assert params["finding_ids"] == ["f1", "f2"]
        assert params["since"] == datetime.fromtimestamp(0.5, tz=UTC)

    def test_rejects_an_empty_or_oversized_finding_list(self, client):
        for ids in ([], ["f"] * 501):
            resp = client.post(
                f"{BASE}/unsettled-runs",
                json={"project_id": "p1", "finding_ids": ids, "since_ms": 0},
                headers=HEADERS,
            )
            assert resp.status_code == 422


def test_every_signal_route_requires_the_secret(client):
    for method, path in [
        ("get", f"{BASE}/waiting-hits?project_id=p&detector_id=d&since_ms=0"),
        ("post", f"{BASE}/assignments"),
        ("post", f"{BASE}/unsettled-runs"),
    ]:
        resp = getattr(client, method)(path, headers={"X-Internal-Secret": "wrong"})
        assert resp.status_code in (401, 403), path
