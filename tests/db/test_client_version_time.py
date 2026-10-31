"""The version (``ch_update_time``) the insert helpers write for each row."""

from datetime import UTC, datetime
from typing import Any
from unittest.mock import MagicMock

from db.clickhouse.client import ClickHouseClient

RECEIVED = datetime(2026, 10, 29, 12, 0, 0, 123456, tzinfo=UTC)


def _trace(trace_id: str = "trace-1", **extra: Any) -> dict[str, Any]:
    return {
        "trace_id": trace_id,
        "project_id": "proj-1",
        "trace_start_time": datetime(2026, 10, 29, 11, 59, 0, tzinfo=UTC),
        "name": "root",
        **extra,
    }


def _span(span_id: str = "span-1") -> dict[str, Any]:
    return {
        "span_id": span_id,
        "trace_id": "trace-1",
        "project_id": "proj-1",
        "span_start_time": datetime(2026, 10, 29, 11, 59, 0, tzinfo=UTC),
        "name": "step",
        "span_kind": "SPAN",
    }


def _column(mock_internal: MagicMock, name: str) -> list[Any]:
    """Every row's value in the named column of the single recorded insert."""
    mock_internal.insert.assert_called_once()
    rows = mock_internal.insert.call_args[0][1]
    columns = mock_internal.insert.call_args[1]["column_names"]
    return [row[columns.index(name)] for row in rows]


class TestSpanVersion:
    def test_version_time_is_written_as_ch_update_time(self):
        internal = MagicMock()
        ClickHouseClient(internal).insert_spans_batch(
            [_span("a"), _span("b")], version_time=RECEIVED
        )
        assert _column(internal, "ch_update_time") == [RECEIVED, RECEIVED]

    def test_create_time_stays_the_insert_time(self):
        internal = MagicMock()
        before = datetime.now(UTC)
        ClickHouseClient(internal).insert_spans_batch([_span()], version_time=RECEIVED)
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

    def test_microseconds_reach_the_driver(self):
        """The column is DateTime64(3); the driver keeps the milliseconds of what it gets."""
        internal = MagicMock()
        ClickHouseClient(internal).insert_spans_batch([_span()], version_time=RECEIVED)
        (version,) = _column(internal, "ch_update_time")
        assert version.microsecond == 123456


class TestTraceVersion:
    def test_version_time_is_written_as_ch_update_time(self):
        internal = MagicMock()
        ClickHouseClient(internal).insert_traces_batch([_trace()], version_time=RECEIVED)
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

    def test_a_record_version_wins_over_the_batch_version(self):
        internal = MagicMock()
        own = datetime(1970, 1, 1, tzinfo=UTC)
        ClickHouseClient(internal).insert_traces_batch(
            [_trace("t-own", ch_update_time=own), _trace("t-batch")], version_time=RECEIVED
        )
        assert _column(internal, "ch_update_time") == [own, RECEIVED]

    def test_a_record_version_wins_over_the_insert_time(self):
        internal = MagicMock()
        own = datetime(1970, 1, 1, tzinfo=UTC)
        ClickHouseClient(internal).insert_traces_batch([_trace(ch_update_time=own)])
        assert _column(internal, "ch_update_time") == [own]
