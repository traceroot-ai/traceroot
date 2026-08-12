"""Unit tests for ClickHouseClient row-building logic.

Tests row construction without a real ClickHouse connection.

Values are read out of a row BY COLUMN NAME rather than by a hardcoded index. The insert
is positional: clickhouse-connect zips the row tuple against ``column_names``, so a value
inserted at the wrong offset is written into a neighbouring column of the same type with
no error anywhere. Looking each value up through the column list is what turns that
silent corruption into a failing assertion.
"""

from datetime import datetime
from typing import Any
from unittest.mock import MagicMock

from db.clickhouse.client import ClickHouseClient


def _insert_call(mock_internal: MagicMock) -> tuple[str, list[Any], list[str]]:
    """Unpack the single recorded insert into (table, row, column_names).

    Also asserts the row is exactly as wide as the column list, since a width mismatch
    is what shifts every subsequent value into the wrong column.
    """
    mock_internal.insert.assert_called_once()
    call_args = mock_internal.insert.call_args
    table = call_args[0][0]
    rows = call_args[0][1]
    columns = call_args[1]["column_names"]
    assert len(rows) == 1
    assert len(rows[0]) == len(columns), "row is not as wide as column_names"
    return table, rows[0], columns


def _value(row: list[Any], columns: list[str], name: str) -> Any:
    """The row value written into the named column."""
    assert name in columns, f"{name} is not an insert column"
    return row[columns.index(name)]


class TestInsertTracesBatch:
    def test_builds_correct_rows(self):
        """Verify row structure matches column_names order."""
        mock_internal = MagicMock()
        client = ClickHouseClient(mock_internal)

        traces = [
            {
                "trace_id": "trace-1",
                "project_id": "proj-1",
                "trace_start_time": datetime(2024, 1, 15, 12, 0, 0),
                "name": "test-trace",
                "user_id": "user-1",
                "session_id": "sess-1",
                "git_ref": "abc123",
                "git_repo": "owner/repo",
                "input": "hello",
                "output": "world",
                "environment": "production",
            }
        ]
        client.insert_traces_batch(traces)

        table, row, columns = _insert_call(mock_internal)

        assert table == "traces"
        assert _value(row, columns, "trace_id") == "trace-1"
        assert _value(row, columns, "project_id") == "proj-1"
        assert _value(row, columns, "name") == "test-trace"
        assert _value(row, columns, "source") == "user"
        assert _value(row, columns, "environment") == "production"
        assert _value(row, columns, "user_id") == "user-1"
        assert _value(row, columns, "session_id") == "sess-1"
        assert _value(row, columns, "git_ref") == "abc123"
        assert _value(row, columns, "git_repo") == "owner/repo"
        assert _value(row, columns, "input") == "hello"
        assert _value(row, columns, "output") == "world"
        assert _value(row, columns, "metadata") is None
        # ch_create_time and ch_update_time are auto-set
        assert isinstance(_value(row, columns, "ch_create_time"), datetime)
        assert isinstance(_value(row, columns, "ch_update_time"), datetime)

    def test_column_names_are_the_traces_schema_in_order(self):
        """Pin the written column list. The insert is positional, so the order here is
        half of the contract with the row builder; a column added to one side only would
        otherwise shift every value after it into its neighbour."""
        mock_internal = MagicMock()
        client = ClickHouseClient(mock_internal)

        client.insert_traces_batch(
            [
                {
                    "trace_id": "trace-1",
                    "project_id": "proj-1",
                    "trace_start_time": datetime(2024, 1, 15, 12, 0, 0),
                    "name": "test-trace",
                }
            ]
        )

        _table, _row, columns = _insert_call(mock_internal)
        assert columns == [
            "trace_id",
            "project_id",
            "trace_start_time",
            "name",
            "source",
            "user_id",
            "session_id",
            "git_ref",
            "git_repo",
            "input",
            "output",
            "metadata",
            "ch_create_time",
            "ch_update_time",
            "environment",
        ]

    def test_empty_batch_no_insert(self):
        """Empty list -> no _client.insert() call."""
        mock_internal = MagicMock()
        client = ClickHouseClient(mock_internal)

        client.insert_traces_batch([])
        mock_internal.insert.assert_not_called()

    def test_source_passthrough_and_default(self):
        """Traces carry their source through; traces without one write 'user'."""
        mock_internal = MagicMock()
        client = ClickHouseClient(mock_internal)

        traces = [
            {
                "trace_id": "trace-1",
                "project_id": "proj-1",
                "trace_start_time": datetime(2024, 1, 15, 12, 0, 0),
                "name": "detector-trace",
                "source": "detector",
            },
            {
                "trace_id": "trace-2",
                "project_id": "proj-1",
                "trace_start_time": datetime(2024, 1, 15, 12, 0, 0),
                "name": "user-trace",
            },
        ]
        client.insert_traces_batch(traces)

        rows = mock_internal.insert.call_args[0][1]
        columns = mock_internal.insert.call_args[1]["column_names"]
        source_idx = columns.index("source")
        assert rows[0][source_idx] == "detector"
        assert rows[1][source_idx] == "user"
        assert all(len(row) == len(columns) for row in rows)

    def test_environment_defaults_to_none_when_absent(self):
        """A trace record without an environment key must not raise and must
        insert NULL rather than silently omitting the column."""
        mock_internal = MagicMock()
        client = ClickHouseClient(mock_internal)

        traces = [
            {
                "trace_id": "trace-1",
                "project_id": "proj-1",
                "trace_start_time": datetime(2024, 1, 15, 12, 0, 0),
                "name": "test-trace",
            }
        ]
        client.insert_traces_batch(traces)

        columns = mock_internal.insert.call_args[1]["column_names"]
        row = mock_internal.insert.call_args[0][1][0]
        assert row[columns.index("environment")] is None


class TestInsertSpansBatch:
    def test_builds_correct_rows(self):
        """Verify row structure matches column_names order."""
        mock_internal = MagicMock()
        client = ClickHouseClient(mock_internal)

        spans = [
            {
                "span_id": "span-1",
                "trace_id": "trace-1",
                "parent_span_id": None,
                "project_id": "proj-1",
                "span_start_time": datetime(2024, 1, 15, 12, 0, 0),
                "span_end_time": datetime(2024, 1, 15, 12, 0, 1),
                "name": "test-span",
                "span_kind": "LLM",
                "status": "OK",
                "status_message": None,
                "model_name": "gpt-4o",
                "cost": 0.005,
                "input_tokens": 100,
                "output_tokens": 50,
                "total_tokens": 150,
                "input": "hello",
                "output": "world",
                "environment": "production",
            }
        ]
        client.insert_spans_batch(spans)

        table, row, columns = _insert_call(mock_internal)

        assert table == "spans"
        assert _value(row, columns, "span_id") == "span-1"
        assert _value(row, columns, "trace_id") == "trace-1"
        assert _value(row, columns, "parent_span_id") is None
        assert _value(row, columns, "project_id") == "proj-1"
        assert _value(row, columns, "span_kind") == "LLM"
        assert _value(row, columns, "source") == "user"
        assert _value(row, columns, "model_name") == "gpt-4o"
        assert _value(row, columns, "cost") == 0.005
        assert _value(row, columns, "input_tokens") == 100
        assert _value(row, columns, "output_tokens") == 50
        assert _value(row, columns, "total_tokens") == 150
        assert "usage_details" in columns
        assert "environment" in columns
        assert row[columns.index("environment")] == "production"

    def test_column_names_are_the_spans_schema_in_order(self):
        """Pin the written column list, for the same positional reason as the traces
        insert. (The three fixed token-breakdown columns are collapsed into the single
        usage_details map.)"""
        mock_internal = MagicMock()
        client = ClickHouseClient(mock_internal)

        client.insert_spans_batch(
            [
                {
                    "span_id": "span-1",
                    "trace_id": "trace-1",
                    "project_id": "proj-1",
                    "span_start_time": datetime(2024, 1, 15, 12, 0, 0),
                    "name": "test-span",
                    "span_kind": "LLM",
                }
            ]
        )

        _table, _row, columns = _insert_call(mock_internal)
        assert columns == [
            "span_id",
            "trace_id",
            "parent_span_id",
            "project_id",
            "span_start_time",
            "span_end_time",
            "name",
            "span_kind",
            "source",
            "status",
            "status_message",
            "model_name",
            "cost",
            "input_tokens",
            "output_tokens",
            "total_tokens",
            "usage_details",
            "input",
            "output",
            "metadata",
            "git_source_file",
            "git_source_line",
            "git_source_function",
            "ch_create_time",
            "ch_update_time",
            "environment",
        ]

    def test_optional_fields_none(self):
        """None values for optional fields (cost, tokens)."""
        mock_internal = MagicMock()
        client = ClickHouseClient(mock_internal)

        spans = [
            {
                "span_id": "span-1",
                "trace_id": "trace-1",
                "project_id": "proj-1",
                "span_start_time": datetime(2024, 1, 15, 12, 0, 0),
                "name": "simple-span",
                "span_kind": "SPAN",
            }
        ]
        client.insert_spans_batch(spans)

        _table, row, columns = _insert_call(mock_internal)
        assert _value(row, columns, "parent_span_id") is None
        assert _value(row, columns, "span_end_time") is None
        assert _value(row, columns, "status_message") is None
        assert _value(row, columns, "model_name") is None
        assert _value(row, columns, "cost") is None
        assert _value(row, columns, "input_tokens") is None
        assert _value(row, columns, "output_tokens") is None
        assert _value(row, columns, "total_tokens") is None
        assert _value(row, columns, "environment") is None

    def test_source_passthrough_and_default(self):
        """Spans carry their source through; spans without one write 'user'."""
        mock_internal = MagicMock()
        client = ClickHouseClient(mock_internal)

        spans = [
            {
                "span_id": "span-1",
                "trace_id": "trace-1",
                "project_id": "proj-1",
                "span_start_time": datetime(2024, 1, 15, 12, 0, 0),
                "name": "detector-span",
                "span_kind": "SPAN",
                "source": "detector",
            },
            {
                "span_id": "span-2",
                "trace_id": "trace-1",
                "project_id": "proj-1",
                "span_start_time": datetime(2024, 1, 15, 12, 0, 0),
                "name": "user-span",
                "span_kind": "SPAN",
            },
        ]
        client.insert_spans_batch(spans)

        rows = mock_internal.insert.call_args[0][1]
        columns = mock_internal.insert.call_args[1]["column_names"]
        source_idx = columns.index("source")
        assert rows[0][source_idx] == "detector"
        assert rows[1][source_idx] == "user"
        assert all(len(row) == len(columns) for row in rows)


class TestDerivedColumnsAreNotInserted:
    """The queryable metadata map is derived in ClickHouse, so the writer never sends it.

    Naming a materialized column in an explicit INSERT column list is rejected outright,
    which would fail EVERY insert in the batch — including the deploy window where a
    writer that names the column ships ahead of the migration that adds it. Deriving the
    map in one place also removes the second spelling of it that a Python twin would keep
    in step only by convention.
    """

    def test_traces_insert_does_not_name_the_derived_map(self):
        mock_internal = MagicMock()
        client = ClickHouseClient(mock_internal)

        client.insert_traces_batch(
            [
                {
                    "trace_id": "trace-1",
                    "project_id": "proj-1",
                    "trace_start_time": datetime(2024, 1, 15, 12, 0, 0),
                    "name": "test-trace",
                    "metadata": '{"experiment": "v2"}',
                }
            ]
        )

        _table, row, columns = _insert_call(mock_internal)
        assert "metadata_map" not in columns
        # The blob the map is derived from is still written.
        assert _value(row, columns, "metadata") == '{"experiment": "v2"}'

    def test_spans_insert_does_not_name_the_derived_map(self):
        mock_internal = MagicMock()
        client = ClickHouseClient(mock_internal)

        client.insert_spans_batch(
            [
                {
                    "span_id": "span-1",
                    "trace_id": "trace-1",
                    "project_id": "proj-1",
                    "span_start_time": datetime(2024, 1, 15, 12, 0, 0),
                    "name": "test-span",
                    "span_kind": "LLM",
                    "metadata": '{"session_id": "s-1"}',
                }
            ]
        )

        _table, row, columns = _insert_call(mock_internal)
        assert "metadata_map" not in columns
        assert _value(row, columns, "metadata") == '{"session_id": "s-1"}'
