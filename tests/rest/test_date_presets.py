"""Tests for the query-window presets shared by the widget query surfaces."""

from datetime import UTC, datetime, timedelta
from typing import get_args

import pytest

from rest.schemas.dashboards import RangeId
from rest.services.date_presets import (
    DEFAULT_RANGE_ID,
    RANGE_PRESET_MINUTES,
    WindowSpecError,
    resolve_window,
)

NOW = datetime(2026, 9, 7, 12, 0, tzinfo=UTC)


def test_preset_table_mirrors_the_ui_durations_id_for_id():
    # frontend/ui/src/lib/date-filter.ts DATE_FILTER_OPTIONS, minus ``custom``.
    assert RANGE_PRESET_MINUTES == {
        "30m": 30,
        "1h": 60,
        "3h": 180,
        "6h": 360,
        "1d": 1440,
        "7d": 10080,
        "14d": 20160,
        "30d": 43200,
        "60d": 86400,
        "90d": 129600,
    }
    assert DEFAULT_RANGE_ID == "1d"


def test_request_schema_literal_matches_the_table():
    # The request schema advertises the ids as an enum (so generated tool and
    # CLI schemas show them); it must never drift from the table that resolves them.
    assert set(get_args(RangeId)) == set(RANGE_PRESET_MINUTES)


def test_range_resolves_to_a_window_ending_now():
    start, end, range_id = resolve_window("7d", None, None, now=NOW)
    assert (start, end, range_id) == (NOW - timedelta(days=7), NOW, "7d")


def test_neither_range_nor_bounds_uses_the_site_default():
    start, end, range_id = resolve_window(None, None, None, now=NOW)
    assert (start, end, range_id) == (NOW - timedelta(days=1), NOW, DEFAULT_RANGE_ID)


def test_explicit_bounds_pass_through_with_no_range_id():
    start_in = datetime(2026, 9, 1, tzinfo=UTC)
    end_in = datetime(2026, 9, 2, tzinfo=UTC)
    start, end, range_id = resolve_window(None, start_in, end_in, now=NOW)
    assert (start, end, range_id) == (start_in, end_in, None)


def test_unknown_range_id_is_rejected_before_any_query():
    with pytest.raises(WindowSpecError, match="unknown range '2w'"):
        resolve_window("2w", None, None, now=NOW)


def test_range_and_bounds_together_are_rejected():
    start_in = datetime(2026, 9, 1, tzinfo=UTC)
    with pytest.raises(WindowSpecError, match="either range or start_time/end_time"):
        resolve_window("7d", start_in, NOW, now=NOW)


@pytest.mark.parametrize("missing", ["start_time", "end_time"])
def test_one_bound_without_the_other_is_rejected(missing):
    start_in = None if missing == "start_time" else datetime(2026, 9, 1, tzinfo=UTC)
    end_in = None if missing == "end_time" else NOW
    with pytest.raises(WindowSpecError, match="both start_time and end_time"):
        resolve_window(None, start_in, end_in, now=NOW)


def test_inverted_bounds_are_rejected():
    with pytest.raises(WindowSpecError, match="end_time must be after start_time"):
        resolve_window(None, NOW, NOW - timedelta(hours=1), now=NOW)


def test_naive_bounds_are_treated_as_utc():
    # The UI sends ISO strings with a Z; a naive datetime from another caller
    # must not shift the window by the server's local offset.
    start, end, _ = resolve_window(None, datetime(2026, 9, 1), datetime(2026, 9, 2), now=NOW)
    assert start == datetime(2026, 9, 1, tzinfo=UTC)
    assert end == datetime(2026, 9, 2, tzinfo=UTC)
