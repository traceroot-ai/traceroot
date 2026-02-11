"""Unit tests for ClickHouseClient row-building logic.

Tests row construction without a real ClickHouse connection.
"""

from datetime import datetime
from unittest.mock import MagicMock

from db.clickhouse.client import ClickHouseClient


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
                "environment": "production",
                "release": "v1.0",
                "input": "hello",
                "output": "world",
            }
        ]
        client.insert_traces_batch(traces)

        mock_internal.insert.assert_called_once()
        call_args = mock_internal.insert.call_args
        table = call_args[0][0]
        rows = call_args[0][1]
        columns = call_args[1]["column_names"]

        assert table == "traces"
        assert len(rows) == 1
        row = rows[0]
        assert row[0] == "trace-1"  # trace_id
        assert row[1] == "proj-1"  # project_id
        assert row[3] == "test-trace"  # name
        assert row[4] == "user-1"  # user_id
        assert row[5] == "sess-1"  # session_id
        assert row[6] == "production"  # environment
        assert row[7] == "v1.0"  # release
        assert row[8] == "hello"  # input
        assert row[9] == "world"  # output
        assert row[10] is None  # metadata
        # ch_create_time and ch_update_time are auto-set
        assert isinstance(row[11], datetime)
        assert isinstance(row[12], datetime)
        assert len(columns) == 13

    def test_empty_batch_no_insert(self):
        """Empty list -> no _client.insert() call."""
        mock_internal = MagicMock()
        client = ClickHouseClient(mock_internal)

        client.insert_traces_batch([])
        mock_internal.insert.assert_not_called()


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
                "environment": "default",
            }
        ]
        client.insert_spans_batch(spans)

        mock_internal.insert.assert_called_once()
        call_args = mock_internal.insert.call_args
        table = call_args[0][0]
        rows = call_args[0][1]
        columns = call_args[1]["column_names"]

        assert table == "spans"
        assert len(rows) == 1
        row = rows[0]
        assert row[0] == "span-1"  # span_id
        assert row[1] == "trace-1"  # trace_id
        assert row[2] is None  # parent_span_id
        assert row[3] == "proj-1"  # project_id
        assert row[7] == "LLM"  # span_kind
        assert row[10] == "gpt-4o"  # model_name
        assert row[11] == 0.005  # cost
        assert row[12] == 100  # input_tokens
        assert row[13] == 50  # output_tokens
        assert row[14] == 150  # total_tokens
        assert len(columns) == 21

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

        row = mock_internal.insert.call_args[0][1][0]
        assert row[2] is None  # parent_span_id
        assert row[5] is None  # span_end_time
        assert row[9] is None  # status_message
        assert row[10] is None  # model_name
        assert row[11] is None  # cost
        assert row[12] is None  # input_tokens
        assert row[13] is None  # output_tokens
        assert row[14] is None  # total_tokens
