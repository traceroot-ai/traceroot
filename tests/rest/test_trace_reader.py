"""Unit tests for read-path cost derivation.

Pure logic — get_model_price is patched, so no DB/ClickHouse is needed.
"""

from datetime import datetime
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

CLAUDE_PRICES = {
    "input": 0.000003,
    "output": 0.000015,
    "cacheRead": 0.0000003,
    "cacheWrite": 0.00000375,
}


def test_span_cost_details_reconciles_to_cost():
    from rest.services.trace_reader import span_cost_details
    from worker.tokens.buckets import TokenBuckets
    from worker.tokens.pricing import cost_from_buckets

    with patch("rest.services.trace_reader.get_model_price", return_value=CLAUDE_PRICES):
        details = span_cost_details(
            "claude-3-5-sonnet-20241022",
            input_tokens=10000,  # gross: 2000 uncached + 6000 read + 2000 write
            output_tokens=1500,
            usage_details={
                "cache_read_tokens": 6000,
                "cache_write_tokens": 2000,
                "reasoning_tokens": 800,
            },
        )

    expected = cost_from_buckets(
        CLAUDE_PRICES,
        TokenBuckets(input_uncached=2000, output=1500, cache_read=6000, cache_write=2000),
    )
    assert sum(details.values()) == pytest.approx(expected)
    assert details["cache_read_cost"] == pytest.approx(6000 * 0.0000003)
    assert details["input_uncached_cost"] == pytest.approx(2000 * 0.000003)


def test_span_cost_details_empty_without_model():
    from rest.services.trace_reader import span_cost_details

    assert span_cost_details(None, 100, 50, {}) == {}


def test_span_cost_details_empty_for_unknown_model():
    from rest.services.trace_reader import span_cost_details

    with patch("rest.services.trace_reader.get_model_price", return_value=None):
        assert span_cost_details("mystery-model", 100, 50, {}) == {}


# ---------------------------------------------------------------------------
# Two-phase loading: get_trace skeleton + get_span_io.
# The ClickHouse client is mocked; we assert on the SQL issued and the dicts
# produced, never touching a real database.
# ---------------------------------------------------------------------------


def _make_service(query_side_effect):
    """Build a TraceReaderService backed by a mock ClickHouse client.

    ``query_side_effect`` is a callable invoked with each query string; it
    returns an object exposing ``result_rows`` (mirroring clickhouse_connect).
    """
    from rest.services.trace_reader import TraceReaderService

    client = MagicMock()
    client.query.side_effect = query_side_effect
    with patch(
        "rest.services.trace_reader.get_clickhouse_client",
        return_value=client,
    ):
        service = TraceReaderService()
    return service, client


def _rows(rows):
    return SimpleNamespace(result_rows=rows)


class TestGetTraceSkeleton:
    def test_spans_query_omits_io_columns(self):
        """The spans SELECT must not read input/output/metadata blobs."""
        captured = {}

        def side_effect(query, parameters=None):
            if "FROM traces FINAL" in query:
                return _rows(
                    [
                        (
                            "abc123",  # trace_id
                            "proj",  # project_id
                            "trace-name",  # name
                            datetime(2024, 1, 1),  # trace_start_time
                            None,  # user_id
                            None,  # session_id
                            None,  # git_ref
                            None,  # git_repo
                            "trace-in",  # input (trace-level, kept)
                            "trace-out",  # output (trace-level, kept)
                            "trace-meta",  # metadata (trace-level, kept)
                        )
                    ]
                )
            # spans query
            captured["spans_query"] = query
            return _rows(
                [
                    (
                        "span-1",  # span_id
                        "abc123",  # trace_id
                        None,  # parent_span_id
                        "root",  # name
                        "SPAN",  # span_kind
                        datetime(2024, 1, 1),  # span_start_time
                        datetime(2024, 1, 1),  # span_end_time
                        "OK",  # status
                        None,  # status_message
                        None,  # model_name
                        None,  # cost
                        None,  # input_tokens
                        None,  # output_tokens
                        None,  # total_tokens
                        {},  # usage_details
                        "file.py",  # git_source_file
                        12,  # git_source_line
                        "fn",  # git_source_function
                    )
                ]
            )

        service, _ = _make_service(side_effect)
        result = service.get_trace("proj", "abc123")

        spans_sql = captured["spans_query"]
        # No blob columns in the SELECT clause. Tokenize on commas/whitespace so
        # `input_tokens` / `output_tokens` (which legitimately remain) don't
        # trip a naive substring check.
        select_clause = spans_sql.split("FROM spans")[0]
        cols = {c.strip() for c in select_clause.replace("SELECT", "").split(",")}
        assert "input" not in cols
        assert "output" not in cols
        assert "metadata" not in cols
        # The token columns (which share a prefix with the blobs) are still there.
        assert "input_tokens" in cols
        assert "output_tokens" in cols
        # Still selects via FINAL (correctness for ReplacingMergeTree).
        assert "FROM spans FINAL" in spans_sql

        # Resulting span dict carries NO I/O keys, but keeps tree fields.
        span = result["spans"][0]
        assert "input" not in span
        assert "output" not in span
        assert "metadata" not in span
        assert span["span_id"] == "span-1"
        assert span["git_source_file"] == "file.py"
        assert span["git_source_line"] == 12
        assert span["git_source_function"] == "fn"

        # Trace-level I/O is preserved.
        assert result["input"] == "trace-in"
        assert result["output"] == "trace-out"
        assert result["metadata"] == "trace-meta"

    def test_returns_none_when_trace_missing(self):
        def side_effect(query, parameters=None):
            return _rows([])

        service, _ = _make_service(side_effect)
        assert service.get_trace("proj", "missing") is None


class TestGetSpanIO:
    def test_returns_blobs_for_existing_span(self):
        def side_effect(query, parameters=None):
            assert "FROM spans FINAL" in query
            # All three blob columns must be in the SELECT.
            assert "input" in query
            assert "output" in query
            assert "metadata" in query
            assert parameters == {
                "project_id": "proj",
                "trace_id": "abc123",
                "span_id": "span-1",
            }
            return _rows([("span-1", "abc123", "the-input", "the-output", "the-meta")])

        service, _ = _make_service(side_effect)
        result = service.get_span_io("proj", "abc123", "span-1")
        assert result == {
            "span_id": "span-1",
            "trace_id": "abc123",
            "input": "the-input",
            "output": "the-output",
            "metadata": "the-meta",
        }

    def test_returns_none_for_unknown_span(self):
        def side_effect(query, parameters=None):
            return _rows([])

        service, _ = _make_service(side_effect)
        assert service.get_span_io("proj", "abc123", "missing") is None

    def test_null_blobs_pass_through(self):
        def side_effect(query, parameters=None):
            return _rows([("span-1", "abc123", None, None, None)])

        service, _ = _make_service(side_effect)
        result = service.get_span_io("proj", "abc123", "span-1")
        assert result == {
            "span_id": "span-1",
            "trace_id": "abc123",
            "input": None,
            "output": None,
            "metadata": None,
        }
