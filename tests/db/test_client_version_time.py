"""The version (``ch_update_time``) the insert helpers hand to ``insert`` for each row.

The driver is mocked, so these tests check the values handed to it. What the driver
then serializes for a version is checked in ``TestDriverWritesMilliseconds``, without
a server.
"""

import struct
from datetime import UTC, datetime
from typing import Any
from unittest.mock import MagicMock

from clickhouse_connect.datatypes.registry import get_from_name
from clickhouse_connect.driver.insert import InsertContext

from db.clickhouse.client import ClickHouseClient

RECEIVED = datetime(2026, 10, 29, 12, 0, 0, 123456, tzinfo=UTC)
#: RECEIVED in whole milliseconds since the epoch, 2026-10-29T12:00:00.123Z.
RECEIVED_MS = 1_793_275_200_123


def _trace(trace_id: str = "trace-1", **extra: Any) -> dict[str, Any]:
    return {
        "trace_id": trace_id,
        "project_id": "proj-1",
        "trace_start_time": datetime(2026, 10, 29, 11, 59, 0, tzinfo=UTC),
        "name": "root",
        **extra,
    }


def _span(span_id: str = "span-1", **extra: Any) -> dict[str, Any]:
    return {
        "span_id": span_id,
        "trace_id": "trace-1",
        "project_id": "proj-1",
        "span_start_time": datetime(2026, 10, 29, 11, 59, 0, tzinfo=UTC),
        "name": "step",
        "span_kind": "SPAN",
        **extra,
    }


def _column(mock_internal: MagicMock, name: str) -> list[Any]:
    """Every row's value in the named column of the single recorded insert."""
    mock_internal.insert.assert_called_once()
    rows = mock_internal.insert.call_args[0][1]
    columns = mock_internal.insert.call_args[1]["column_names"]
    return [row[columns.index(name)] for row in rows]


def _written_ticks(value: datetime) -> int:
    """The Int64 clickhouse-connect serializes for ``value`` in a DateTime64(3) column."""
    column_type = get_from_name("DateTime64(3)")
    dest = bytearray()
    column_type.write_column(
        [value], dest, InsertContext("spans", ["ch_update_time"], [column_type])
    )
    (ticks,) = struct.unpack("<q", dest)
    return ticks


class TestSpanVersion:
    def test_version_time_is_written_as_ch_update_time(self):
        internal = MagicMock()
        ClickHouseClient(internal).insert_spans_batch(
            [_span("a", ch_update_time=RECEIVED), _span("b", ch_update_time=RECEIVED)]
        )
        assert _column(internal, "ch_update_time") == [RECEIVED, RECEIVED]

    def test_create_time_stays_the_insert_time(self):
        internal = MagicMock()
        before = datetime.now(UTC)
        ClickHouseClient(internal).insert_spans_batch([_span(ch_update_time=RECEIVED)])
        (created,) = _column(internal, "ch_create_time")
        assert created >= before
        assert created != RECEIVED

    def test_without_a_version_time_the_insert_time_is_the_version(self):
        internal = MagicMock()
        before = datetime.now(UTC)
        ClickHouseClient(internal).insert_spans_batch([_span()])
        after = datetime.now(UTC)
        (version,) = _column(internal, "ch_update_time")
        assert before <= version <= after
        assert _column(internal, "ch_create_time") == [version]

    def test_microseconds_are_handed_to_insert(self):
        """The helper passes the receive time on unrounded; rounding is the driver's."""
        internal = MagicMock()
        ClickHouseClient(internal).insert_spans_batch([_span(ch_update_time=RECEIVED)])
        (version,) = _column(internal, "ch_update_time")
        assert version.microsecond == 123456


class TestTraceVersion:
    def test_version_time_is_written_as_ch_update_time(self):
        internal = MagicMock()
        ClickHouseClient(internal).insert_traces_batch([_trace(ch_update_time=RECEIVED)])
        assert _column(internal, "ch_update_time") == [RECEIVED]
        (created,) = _column(internal, "ch_create_time")
        assert created != RECEIVED

    def test_without_a_version_time_the_insert_time_is_the_version(self):
        internal = MagicMock()
        before = datetime.now(UTC)
        ClickHouseClient(internal).insert_traces_batch([_trace()])
        (version,) = _column(internal, "ch_update_time")
        assert version >= before
        assert _column(internal, "ch_create_time") == [version]

    def test_each_record_keeps_its_own_version(self):
        internal = MagicMock()
        own = datetime(1970, 1, 1, tzinfo=UTC)
        ClickHouseClient(internal).insert_traces_batch(
            [_trace("t-own", ch_update_time=own), _trace("t-batch", ch_update_time=RECEIVED)]
        )
        assert _column(internal, "ch_update_time") == [own, RECEIVED]


class TestDriverWritesMilliseconds:
    """``spans.ch_update_time`` and ``traces.ch_update_time`` are DateTime64(3) columns."""

    def test_the_version_handed_to_insert_is_written_in_whole_milliseconds(self):
        internal = MagicMock()
        ClickHouseClient(internal).insert_spans_batch([_span(ch_update_time=RECEIVED)])
        (version,) = _column(internal, "ch_update_time")
        assert _written_ticks(version) == RECEIVED_MS

    def test_receive_times_within_one_millisecond_are_written_equal(self):
        """Such versions tie, and a tie keeps the row inserted last."""
        assert _written_ticks(RECEIVED.replace(microsecond=123999)) == RECEIVED_MS
        assert _written_ticks(RECEIVED.replace(microsecond=124000)) == RECEIVED_MS + 1
