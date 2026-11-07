"""Unit tests for GET /internal/trace-counts: the traces a signal's detector
checked, behind the panel's "traces per bucket" overlay, must match what the
customer-facing Traces list would show, not a raw scan of every row in `traces`.
"""

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
    mock = MagicMock()
    monkeypatch.setattr(
        "rest.routers.internal.detectors.get_clickhouse_client",
        lambda: mock,
    )
    return mock


@pytest.fixture()
def client(secret, mock_ch):
    return TestClient(app)


def _empty_result():
    r = MagicMock()
    r.result_rows = []
    return r


class TestTraceCountsExclusions:
    """The detector's checked traces must apply the same customer-traffic and
    evaluation exclusions as the Traces list."""

    def test_checked_traces_exclude_internal_and_eval_traces(self, client, mock_ch, secret):
        mock_ch.query.return_value = _empty_result()
        response = client.get(
            "/api/v1/internal/trace-counts",
            params={
                "project_id": "p1",
                "start_after": "2026-01-01T00:00:00",
                "end_before": "2026-01-02T00:00:00",
                "detector_id": "d1",
            },
            headers={"X-Internal-Secret": secret},
        )
        assert response.status_code == 200
        sql = mock_ch.query.call_args.args[0]
        assert "source = 'user'" in sql
        assert "is_evaluation = 1" in sql

    def test_exclusion_is_monotonic_not_a_latest_row_predicate(self, client, mock_ch, secret):
        """Same invariant as trace_reader's list_traces (see
        test_trace_reader_evaluations.py): the exclusion must read every row for the
        trace, not a deduped latest row, or a later batch that rewrites a trace with
        is_evaluation=0 would un-hide it. Both call sites share ``_evaluation_exclusion``
        so this is really a guard against the router stopping using that helper."""
        mock_ch.query.return_value = _empty_result()
        response = client.get(
            "/api/v1/internal/trace-counts",
            params={
                "project_id": "p1",
                "start_after": "2026-01-01T00:00:00",
                "end_before": "2026-01-02T00:00:00",
                "detector_id": "d1",
            },
            headers={"X-Internal-Secret": secret},
        )
        assert response.status_code == 200
        sql = mock_ch.query.call_args.args[0]
        start = sql.index("is_evaluation = 1")
        # The sub-select containing the predicate: back up to its opening paren.
        sub_start = sql.rindex("(", 0, start)
        depth = 0
        end = sub_start
        for i in range(sub_start, len(sql)):
            if sql[i] == "(":
                depth += 1
            elif sql[i] == ")":
                depth -= 1
                if depth == 0:
                    end = i + 1
                    break
        sub = sql[sub_start:end]
        assert "LIMIT 1 BY" not in sub
        assert "argMax" not in sub
        assert "ch_update_time" not in sub


class TestHourBucketOffsets:
    """Hour buckets carry the UTC offset of the bucket's own instant, so the two real
    local hours of a DST fall-back night stay distinct instead of merging into one
    "HH:00" key (see reads.ts in core for the Postgres/TS side of the same fix)."""

    def test_dst_fallback_hour_produces_two_distinct_buckets(self, client, mock_ch, secret):
        # America/New_York falls back at 2026-11-01 06:00 UTC (local 02:00 EDT -> 01:00
        # EST). ClickHouse groups by the bucket's actual instant (toStartOfHour), so the
        # two real occurrences of local "01:00" arrive as two rows with different
        # offsets; our job is to turn that into two differently-keyed buckets.
        result = MagicMock()
        result.result_rows = [
            ("2026-11-01T01:00", -4 * 3600, 3),  # 05:00-05:59 UTC, still EDT
            ("2026-11-01T01:00", -5 * 3600, 5),  # 06:00-06:59 UTC, now EST
        ]
        mock_ch.query.return_value = result
        response = client.get(
            "/api/v1/internal/trace-counts",
            params={
                "project_id": "p1",
                "detector_id": "d1",
                "start_after": "2026-11-01T05:00:00",
                "end_before": "2026-11-01T07:00:00",
                "granularity": "hour",
                "tz": "America/New_York",
            },
            headers={"X-Internal-Secret": secret},
        )
        assert response.status_code == 200
        assert response.json()["data"] == [
            {"bucket": "2026-11-01T01:00-04:00", "count": 3},
            {"bucket": "2026-11-01T01:00-05:00", "count": 5},
        ]
        sql = mock_ch.query.call_args.args[0]
        assert "toStartOfHour(ts, {tz:String})" in sql
        assert "timeZoneOffset(toTimeZone(bucket_start, {tz:String}))" in sql
        assert "GROUP BY bucket_start" in sql

    def test_half_hour_offset_zone_formats_minutes(self, client, mock_ch, secret):
        """A zone offset on the half hour (Asia/Kolkata, UTC+5:30) must still format
        as "+05:30", not truncate or round to a whole hour."""
        result = MagicMock()
        result.result_rows = [("2026-06-01T05:00", 5 * 3600 + 30 * 60, 7)]
        mock_ch.query.return_value = result
        response = client.get(
            "/api/v1/internal/trace-counts",
            params={
                "project_id": "p1",
                "detector_id": "d1",
                "start_after": "2026-05-31T23:00:00",
                "end_before": "2026-06-01T01:00:00",
                "granularity": "hour",
                "tz": "Asia/Kolkata",
            },
            headers={"X-Internal-Secret": secret},
        )
        assert response.status_code == 200
        assert response.json()["data"] == [{"bucket": "2026-06-01T05:00+05:30", "count": 7}]

    def test_day_buckets_carry_no_offset(self, client, mock_ch, secret):
        """Day buckets are not DST-ambiguous and must stay exactly as before."""
        result = MagicMock()
        result.result_rows = [("2026-11-01", 20)]
        mock_ch.query.return_value = result
        response = client.get(
            "/api/v1/internal/trace-counts",
            params={
                "project_id": "p1",
                "detector_id": "d1",
                "start_after": "2026-11-01T00:00:00",
                "end_before": "2026-11-02T00:00:00",
                "granularity": "day",
                "tz": "America/New_York",
            },
            headers={"X-Internal-Secret": secret},
        )
        assert response.status_code == 200
        assert response.json()["data"] == [{"bucket": "2026-11-01", "count": 20}]
