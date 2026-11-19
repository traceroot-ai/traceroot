"""Unit tests for the shared ClickHouse read bounds.

The point of one shared mapping is that every read surface expires and spills at the
same place. That only holds if a caller cannot edit what it was handed: the mapping is
passed by reference to clickhouse-connect from several call sites, so a single in-place
edit anywhere would move the bounds for every other read path in the process, with no
import and no diff at those sites to show for it.
"""

import pytest

from db.clickhouse.query_settings import (
    GROUP_BY_SPILL_BYTES,
    QUERY_TIMEOUT_S,
    READ_QUERY_SETTINGS,
)


def test_a_caller_cannot_edit_the_shared_bounds():
    with pytest.raises(TypeError):
        READ_QUERY_SETTINGS["max_execution_time"] = 3600


def test_a_caller_cannot_add_a_setting_for_everyone_else():
    with pytest.raises(TypeError):
        READ_QUERY_SETTINGS["readonly"] = 0

    with pytest.raises(TypeError):
        READ_QUERY_SETTINGS["max_result_rows"] = 1

    with pytest.raises(TypeError):
        del READ_QUERY_SETTINGS["readonly"]

    assert READ_QUERY_SETTINGS["readonly"] == 1


def test_the_bounds_are_the_three_a_read_needs():
    """A read is read-only, expires, and spills rather than OOMing.

    Named here so dropping one from the mapping is a failure rather than a quiet
    loosening of every read surface at once.
    """
    assert dict(READ_QUERY_SETTINGS) == {
        "readonly": 1,
        "max_execution_time": QUERY_TIMEOUT_S,
        "max_bytes_before_external_group_by": GROUP_BY_SPILL_BYTES,
    }


def test_copying_the_bounds_yields_a_plain_editable_mapping():
    """A caller that needs one extra setting derives a copy instead of editing shared
    state — the supported escape hatch, and proof the proxy is not simply frozen data."""
    derived = {**READ_QUERY_SETTINGS, "max_result_rows": 10}

    assert derived["max_execution_time"] == QUERY_TIMEOUT_S
    assert "max_result_rows" not in READ_QUERY_SETTINGS
