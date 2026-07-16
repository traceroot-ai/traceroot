"""Unit tests for the retention access-window module."""

from datetime import UTC, datetime, timedelta

import pytest
from fastapi import HTTPException

from rest.retention import (
    clamp_retention_window,
    enforce_retention_by_time,
    enforce_retention_window,
    get_retention_cutoff,
)


def _now_naive():
    return datetime.now(UTC).replace(tzinfo=None)


class TestGetRetentionCutoff:
    def test_free_plan_returns_15_day_cutoff(self):
        cutoff = get_retention_cutoff("free")
        assert cutoff is not None
        expected = _now_naive() - timedelta(days=15, hours=1)
        assert abs((cutoff - expected).total_seconds()) < 2

    def test_starter_plan_returns_30_day_cutoff(self):
        cutoff = get_retention_cutoff("starter")
        assert cutoff is not None
        expected = _now_naive() - timedelta(days=30, hours=1)
        assert abs((cutoff - expected).total_seconds()) < 2

    def test_pro_plan_returns_90_day_cutoff(self):
        cutoff = get_retention_cutoff("pro")
        assert cutoff is not None
        expected = _now_naive() - timedelta(days=90, hours=1)
        assert abs((cutoff - expected).total_seconds()) < 2

    def test_enterprise_plan_returns_none(self):
        assert get_retention_cutoff("enterprise") is None

    def test_unknown_plan_fails_closed_to_15_days(self):
        cutoff = get_retention_cutoff("bogus")
        assert cutoff is not None
        expected = _now_naive() - timedelta(days=15, hours=1)
        assert abs((cutoff - expected).total_seconds()) < 2

    def test_cutoff_is_naive(self):
        cutoff = get_retention_cutoff("free")
        assert cutoff.tzinfo is None


class TestEnforceRetentionWindow:
    def test_enterprise_passes_through(self):
        sa = datetime(2020, 1, 1)
        eb = datetime(2020, 2, 1)
        result = enforce_retention_window("enterprise", sa, eb)
        assert result == (sa, eb)

    def test_no_start_after_clamps_to_cutoff(self):
        result_sa, result_eb = enforce_retention_window("free", None, None)
        assert result_sa is not None
        expected = _now_naive() - timedelta(days=15, hours=1)
        assert abs((result_sa - expected).total_seconds()) < 2
        assert result_eb is None

    def test_start_after_within_window_passes(self):
        recent = _now_naive() - timedelta(days=5)
        result_sa, _ = enforce_retention_window("free", recent)
        assert result_sa == recent

    def test_start_after_outside_window_raises_403(self):
        old = _now_naive() - timedelta(days=30)
        with pytest.raises(HTTPException) as exc_info:
            enforce_retention_window("free", old)
        assert exc_info.value.status_code == 403
        detail = exc_info.value.detail
        assert detail["message"] == "Data outside retention window"
        assert detail["retention_days"] == 15
        assert detail["plan"] == "free"
        assert "cutoff" in detail

    def test_tz_aware_start_after_outside_window_raises_403(self):
        old = datetime.now(UTC) - timedelta(days=30)
        with pytest.raises(HTTPException) as exc_info:
            enforce_retention_window("free", old)
        assert exc_info.value.status_code == 403

    def test_end_before_passed_through(self):
        recent = _now_naive() - timedelta(days=1)
        eb = _now_naive()
        _, result_eb = enforce_retention_window("free", recent, eb)
        assert result_eb == eb


class TestEnforceRetentionByTime:
    def test_enterprise_never_raises(self):
        old = datetime(2020, 1, 1)
        enforce_retention_by_time("enterprise", old)

    def test_in_window_passes(self):
        recent = _now_naive() - timedelta(days=5)
        enforce_retention_by_time("free", recent)

    def test_out_of_window_raises_403(self):
        old = _now_naive() - timedelta(days=30)
        with pytest.raises(HTTPException) as exc_info:
            enforce_retention_by_time("free", old)
        assert exc_info.value.status_code == 403
        detail = exc_info.value.detail
        assert detail["message"] == "Data outside retention window"

    def test_none_timestamp_passes(self):
        enforce_retention_by_time("free", None)

    def test_tz_aware_timestamp_out_of_window_raises_403(self):
        old = datetime(2020, 1, 1, tzinfo=UTC)
        with pytest.raises(HTTPException) as exc_info:
            enforce_retention_by_time("free", old)
        assert exc_info.value.status_code == 403


class TestClampRetentionWindow:
    def test_enterprise_passes_through(self):
        sa = datetime(2020, 1, 1)
        eb = datetime(2020, 2, 1)
        result = clamp_retention_window("enterprise", sa, eb)
        assert result == (sa, eb)

    def test_no_start_after_clamps_to_cutoff(self):
        result_sa, _ = clamp_retention_window("free", None)
        assert result_sa is not None
        expected = _now_naive() - timedelta(days=15, hours=1)
        assert abs((result_sa - expected).total_seconds()) < 2

    def test_old_start_after_clamps_instead_of_403(self):
        old = _now_naive() - timedelta(days=30)
        result_sa, _ = clamp_retention_window("free", old)
        expected = _now_naive() - timedelta(days=15, hours=1)
        assert abs((result_sa - expected).total_seconds()) < 2

    def test_recent_start_after_passes_through(self):
        recent = _now_naive() - timedelta(days=5)
        result_sa, _ = clamp_retention_window("free", recent)
        assert result_sa == recent

    def test_tz_aware_old_start_after_clamps(self):
        old = datetime.now(UTC) - timedelta(days=30)
        result_sa, _ = clamp_retention_window("free", old)
        expected = _now_naive() - timedelta(days=15, hours=1)
        assert abs((result_sa - expected).total_seconds()) < 2
