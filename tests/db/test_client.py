"""Unit tests for ClickHouseClient row-building logic.

Tests row construction without a real ClickHouse connection.
"""

from datetime import UTC, datetime, timedelta
from unittest.mock import MagicMock

from db.clickhouse.client import ClickHouseClient, _make_trace_version


def test_authoritative_trace_beats_a_newer_internal_placeholder():
    """Authority, not request completion order, decides the winner."""
    root_time = datetime(2026, 1, 1, tzinfo=UTC)
    later_placeholder_time = root_time + timedelta(days=1)

    assert _make_trace_version(root_time, authoritative=True) > _make_trace_version(
        later_placeholder_time, authoritative=False
    )


def test_newer_trace_wins_when_authority_is_equal():
    """The old timestamp ordering is preserved within each authority class."""
    older_time = datetime(2026, 1, 1, tzinfo=UTC)
    newer_time = older_time + timedelta(seconds=1)

    assert _make_trace_version(newer_time, authoritative=True) > _make_trace_version(
        older_time, authoritative=True
    )
    assert _make_trace_version(newer_time, authoritative=False) > _make_trace_version(
        older_time, authoritative=False
    )


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
        assert row[4] == "user"  # source (default)
        assert row[5] == "user-1"  # user_id
        assert row[6] == "sess-1"  # session_id
        assert row[7] == "abc123"  # git_ref
        assert row[8] == "owner/repo"  # git_repo
        assert row[9] == "hello"  # input
        assert row[10] == "world"  # output
        assert row[11] is None  # metadata
        # ch_create_time and ch_update_time are auto-set
        assert isinstance(row[12], datetime)
        assert isinstance(row[13], datetime)
        assert len(columns) == 17
        assert "environment" in columns
        assert row[columns.index("environment")] == "production"
        # Omitting root_bearing_keys is the public/legacy path: preserve its
        # existing timestamp-only behavior by treating the row as authority 1.
        assert row[columns.index("trace_authority")] == 1
        assert row[columns.index("trace_version")] == _make_trace_version(
            row[columns.index("ch_update_time")],
            authoritative=True,
        )

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

    def test_internal_root_keys_classify_root_and_placeholder_rows(self):
        """An empty/internal root set differs from the public None default."""
        mock_internal = MagicMock()
        client = ClickHouseClient(mock_internal)

        traces = [
            {
                "trace_id": "root-trace",
                "project_id": "proj-1",
                "trace_start_time": datetime(2024, 1, 15, 12, 0, 0),
                "name": "root",
            },
            {
                "trace_id": "child-only-trace",
                "project_id": "proj-1",
                "trace_start_time": datetime(2024, 1, 15, 12, 0, 0),
                "name": "placeholder",
            },
        ]

        client.insert_traces_batch(
            traces,
            root_bearing_keys={("proj-1", "root-trace")},
        )

        columns = mock_internal.insert.call_args.kwargs["column_names"]
        rows = mock_internal.insert.call_args.args[1]
        authority_index = columns.index("trace_authority")
        version_index = columns.index("trace_version")

        assert rows[0][authority_index] == 1
        assert rows[1][authority_index] == 0
        assert rows[0][version_index] > rows[1][version_index]


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
        assert row[8] == "user"  # source (default)
        assert row[11] == "gpt-4o"  # model_name
        assert row[12] == 0.005  # cost
        assert row[13] == 100  # input_tokens
        assert row[14] == 50  # output_tokens
        assert row[15] == 150  # total_tokens
        # 3 fixed breakdown columns collapsed into one usage_details map (net -2),
        # then source and environment added.
        assert len(columns) == 26
        assert "usage_details" in columns
        assert "environment" in columns
        assert row[columns.index("environment")] == "production"

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
        assert row[10] is None  # status_message
        assert row[11] is None  # model_name
        assert row[12] is None  # cost
        assert row[13] is None  # input_tokens
        assert row[14] is None  # output_tokens
        assert row[15] is None  # total_tokens
        columns = mock_internal.insert.call_args[1]["column_names"]
        assert row[columns.index("environment")] is None

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
