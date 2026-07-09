"""Unit tests for read-path cost derivation.

Pure logic — get_model_price is patched, so no DB/ClickHouse is needed.
"""

from datetime import datetime, timedelta, timezone
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


def test_span_cost_details_rebuilds_1h_portion():
    from rest.services.trace_reader import span_cost_details
    from worker.tokens.buckets import TokenBuckets
    from worker.tokens.pricing import cost_from_buckets

    # input 1000 = 100 uncached + 0 read + 900 write; of the 900: 600 @1h, 300 remainder.
    prices = {**CLAUDE_PRICES, "cacheWrite1h": 0.000006}  # 2x the 0.000003 input rate
    with patch("rest.services.trace_reader.get_model_price", return_value=prices):
        details = span_cost_details(
            "claude-opus-4-7",
            input_tokens=1000,
            output_tokens=0,
            usage_details={
                "cache_read_tokens": 0,
                "cache_write_tokens": 900,
                "cache_write_1h_tokens": 600,
            },
        )

    expected = cost_from_buckets(
        prices,
        TokenBuckets(
            input_uncached=100,
            output=0,
            cache_read=0,
            cache_write=900,
            cache_write_1h=600,
        ),
    )
    assert sum(details.values()) == pytest.approx(expected)
    # Independent ground truth: 300 remainder @cacheWrite + 600 @cacheWrite1h.
    assert details["cache_write_cost"] == pytest.approx(300 * 0.00000375 + 600 * 0.000006)


def test_span_cost_details_without_1h_key_matches_combined_rate():
    # A stored span with no 1-hour key (every span today) prices its whole write total
    # at the combined cacheWrite rate.
    from rest.services.trace_reader import span_cost_details

    prices = {**CLAUDE_PRICES, "cacheWrite1h": 0.000006}
    with patch("rest.services.trace_reader.get_model_price", return_value=prices):
        details = span_cost_details(
            "claude-opus-4-7",
            input_tokens=1000,
            output_tokens=0,
            usage_details={"cache_read_tokens": 0, "cache_write_tokens": 900},
        )
    assert details["cache_write_cost"] == pytest.approx(900 * 0.00000375)


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
            if "FROM traces" in query and "FROM spans" not in query:
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
            captured["spans_parameters"] = parameters
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
        # Uses dedup subquery instead of FINAL for better read performance.
        assert "LIMIT 1 BY span_id" in spans_sql
        assert "ch_update_time DESC" in spans_sql
        assert "FROM spans FINAL" not in spans_sql
        # Bound by the already-read trace_start_time so ClickHouse can prune
        # monthly span partitions before the trace.
        from rest.services.trace_reader import TRACE_SPAN_LOOKBACK_HOURS

        lower_bound_sql = (
            "span_start_time >= {trace_start_time:DateTime64(3)} "
            f"- INTERVAL {TRACE_SPAN_LOOKBACK_HOURS} HOUR"
        )
        assert lower_bound_sql in spans_sql
        assert captured["spans_parameters"] == {
            "project_id": "proj",
            "trace_id": "abc123",
            "trace_start_time": datetime(2024, 1, 1),
        }

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

    def test_spans_query_is_unbounded_when_trace_start_time_is_null(self):
        captured = {}

        def side_effect(query, parameters=None):
            if "FROM traces" in query and "FROM spans" not in query:
                return _rows(
                    [
                        (
                            "abc123",  # trace_id
                            "proj",  # project_id
                            "trace-name",  # name
                            None,  # trace_start_time
                            None,  # user_id
                            None,  # session_id
                            None,  # git_ref
                            None,  # git_repo
                            None,  # input
                            None,  # output
                            None,  # metadata
                        )
                    ]
                )

            captured["spans_query"] = query
            captured["spans_parameters"] = parameters
            return _rows([])

        service, _ = _make_service(side_effect)
        result = service.get_trace("proj", "abc123")

        assert result["spans"] == []
        assert "span_start_time >=" not in captured["spans_query"]
        assert captured["spans_parameters"] == {
            "project_id": "proj",
            "trace_id": "abc123",
        }

    def test_spans_query_normalizes_aware_trace_start_time_to_utc(self):
        captured = {}
        trace_start_time = datetime(
            2024,
            1,
            1,
            12,
            0,
            tzinfo=timezone(timedelta(hours=-8)),
        )

        def side_effect(query, parameters=None):
            if "FROM traces" in query and "FROM spans" not in query:
                return _rows(
                    [
                        (
                            "abc123",  # trace_id
                            "proj",  # project_id
                            "trace-name",  # name
                            trace_start_time,  # trace_start_time
                            None,  # user_id
                            None,  # session_id
                            None,  # git_ref
                            None,  # git_repo
                            None,  # input
                            None,  # output
                            None,  # metadata
                        )
                    ]
                )

            captured["spans_query"] = query
            captured["spans_parameters"] = parameters
            return _rows([])

        service, _ = _make_service(side_effect)
        result = service.get_trace("proj", "abc123")

        assert result["spans"] == []
        from rest.services.trace_reader import TRACE_SPAN_LOOKBACK_HOURS

        lower_bound_sql = (
            "span_start_time >= {trace_start_time:DateTime64(3)} "
            f"- INTERVAL {TRACE_SPAN_LOOKBACK_HOURS} HOUR"
        )
        assert lower_bound_sql in captured["spans_query"]
        assert captured["spans_parameters"] == {
            "project_id": "proj",
            "trace_id": "abc123",
            "trace_start_time": datetime(2024, 1, 1, 20, 0),
        }


class TestGetTraceSpansIO:
    """Bulk per-span I/O reader: one trace-scoped query, span-id-keyed map,
    column pruning driven by the requested projection."""

    def test_single_query_returns_span_id_keyed_map(self):
        calls = []

        def side_effect(query, parameters=None):
            calls.append((query, parameters))
            return _rows(
                [
                    ("span-1", "in-1", "out-1", "meta-1"),
                    ("span-2", "in-2", "out-2", "meta-2"),
                ]
            )

        service, _ = _make_service(side_effect)
        result = service.get_trace_spans_io(
            "proj", "abc123", frozenset({"input", "output", "metadata"})
        )

        # Exactly one trace-scoped query (no N+1 single-span fan-out).
        assert len(calls) == 1
        query, params = calls[0]
        assert "LIMIT 1 BY span_id" in query
        assert "ch_update_time DESC" in query
        assert "FROM spans FINAL" not in query
        assert params == {"project_id": "proj", "trace_id": "abc123"}
        # No span_id filter — it is trace-wide.
        assert "span_id =" not in query
        # Keyed by span_id, each value carries all requested columns.
        assert result == {
            "span-1": {"input": "in-1", "output": "out-1", "metadata": "meta-1"},
            "span-2": {"input": "in-2", "output": "out-2", "metadata": "meta-2"},
        }

    def test_prunes_to_requested_columns_only(self):
        """A metadata-only projection must SELECT only span_id + metadata."""
        captured = {}

        def side_effect(query, parameters=None):
            captured["query"] = query
            return _rows([("span-1", "meta-1")])

        service, _ = _make_service(side_effect)
        result = service.get_trace_spans_io("proj", "abc123", frozenset({"metadata"}))

        # Extract inner SELECT (after the last "FROM (") to get the actual projected cols.
        inner_select = captured["query"].split("FROM spans")[0].split("FROM (")[-1]
        cols = {c.strip() for c in inner_select.replace("SELECT", "").split(",")}
        assert "span_id" in cols
        assert "metadata" in cols
        assert "input" not in cols
        assert "output" not in cols
        assert result == {"span-1": {"metadata": "meta-1"}}

    def test_empty_columns_skips_query(self):
        """No requested blob columns -> no query issued, empty map."""
        calls = []

        def side_effect(query, parameters=None):
            calls.append(query)
            return _rows([])

        service, _ = _make_service(side_effect)
        result = service.get_trace_spans_io("proj", "abc123", frozenset())
        assert result == {}
        assert calls == []

    def test_null_blobs_pass_through(self):
        def side_effect(query, parameters=None):
            return _rows([("span-1", None, None, None)])

        service, _ = _make_service(side_effect)
        result = service.get_trace_spans_io(
            "proj", "abc123", frozenset({"input", "output", "metadata"})
        )
        assert result == {"span-1": {"input": None, "output": None, "metadata": None}}


class TestGetSpanIO:
    def test_returns_blobs_for_existing_span(self):
        def side_effect(query, parameters=None):
            assert "ch_update_time DESC" in query
            assert "FROM spans FINAL" not in query
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

    def test_latest_row_wins_when_span_reingested(self):
        """Asserts the dedup query shape and single-row pass-through.

        Newest-wins ordering is enforced by ClickHouse (ORDER BY ch_update_time
        DESC + LIMIT 1). The mock returns the single post-dedup row; the service
        must surface it without further modification.
        """
        call_count = {"n": 0}

        def side_effect(query, parameters=None):
            call_count["n"] += 1
            assert "ORDER BY ch_update_time DESC" in query
            assert "LIMIT 1" in query
            assert "FROM spans FINAL" not in query
            return _rows([("span-1", "abc123", "new-input", "new-output", "new-meta")])

        service, _ = _make_service(side_effect)
        result = service.get_span_io("proj", "abc123", "span-1")

        assert call_count["n"] == 1
        assert result["input"] == "new-input"
        assert result["output"] == "new-output"
        assert result["metadata"] == "new-meta"
