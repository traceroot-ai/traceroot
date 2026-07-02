"""Unit tests for read-path cost derivation.

Pure logic — get_model_price is patched, so no DB/ClickHouse is needed.
"""

from datetime import UTC, datetime, timedelta, timezone
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


def _make_service(query_side_effect, **service_kwargs):
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
        service = TraceReaderService(**service_kwargs)
    return service, client


def _rows(rows):
    return SimpleNamespace(result_rows=rows)


class _FakeClock:
    def __init__(self):
        self.now = 0.0

    def __call__(self):
        return self.now

    def advance(self, seconds):
        self.now += seconds


def _trace_row(
    trace_id="abc123",
    project_id="proj",
    trace_start_time=datetime(2024, 1, 1),
    input_value="trace-in",
    output_value="trace-out",
    metadata="trace-meta",
):
    return (
        trace_id,
        project_id,
        "trace-name",
        trace_start_time,
        None,
        None,
        None,
        None,
        input_value,
        output_value,
        metadata,
    )


def _span_row(span_id="span-1", trace_id="abc123", name="root"):
    return (
        span_id,
        trace_id,
        None,
        name,
        "SPAN",
        datetime(2024, 1, 1),
        datetime(2024, 1, 1),
        "OK",
        None,
        None,
        None,
        None,
        None,
        None,
        {},
        "file.py",
        12,
        "fn",
    )


def _list_trace_row(
    trace_id="abc123",
    project_id="proj",
    trace_start_time=datetime(2024, 1, 1),
    input_value="trace-in",
    output_value="trace-out",
):
    return (
        trace_id,
        project_id,
        "trace-name",
        trace_start_time,
        None,
        None,
        1,
        42,
        0,
        input_value,
        output_value,
        10,
        20,
        0.01,
    )


class TestTraceReadCache:
    def test_list_traces_reuses_identical_query_within_ttl(self):
        clock = _FakeClock()

        def side_effect(query, parameters=None):
            if "count(DISTINCT t.trace_id)" in query:
                return _rows([(1,)])
            return _rows([_list_trace_row()])

        service, client = _make_service(
            side_effect,
            cache_ttl_seconds=10.0,
            clock=clock,
        )

        first = service.list_traces("proj", limit=5, search_query="trace", use_cache=True)
        first["data"][0]["trace_url"] = "caller mutation"
        second = service.list_traces("proj", limit=5, search_query="trace", use_cache=True)
        second["data"][0]["trace_url"] = "cached-return mutation"
        third = service.list_traces("proj", limit=5, search_query="trace", use_cache=True)

        assert client.query.call_count == 2
        assert second["data"][0]["trace_id"] == "abc123"
        assert "trace_url" not in third["data"][0]

    def test_list_traces_cache_key_distinguishes_filters(self):
        cases = [
            ({"project_id": "proj-a"}, {"project_id": "proj-b"}),
            ({"page": 0}, {"page": 1}),
            ({"limit": 5}, {"limit": 10}),
            ({"name": "first"}, {"name": "second"}),
            ({"user_id": "user-a"}, {"user_id": "user-b"}),
            ({"search_query": "first"}, {"search_query": "second"}),
            (
                {"end_before": datetime(2024, 1, 1, 12, 0, tzinfo=UTC)},
                {"end_before": datetime(2024, 1, 1, 12, 1, tzinfo=UTC)},
            ),
        ]

        for first_kwargs, second_kwargs in cases:
            client = MagicMock()

            def side_effect(query, parameters=None):
                if "count(DISTINCT t.trace_id)" in query:
                    return _rows([(1,)])
                return _rows([_list_trace_row(project_id=parameters["project_id"])])

            client.query.side_effect = side_effect
            with patch("rest.services.trace_reader.get_clickhouse_client", return_value=client):
                from rest.services.trace_reader import TraceReaderService

                service = TraceReaderService()

            service.list_traces(
                **{"project_id": "proj", "limit": 5, "use_cache": True, **first_kwargs}
            )
            service.list_traces(
                **{"project_id": "proj", "limit": 5, "use_cache": True, **second_kwargs}
            )

            assert client.query.call_count == 4

    @pytest.mark.parametrize("filter_name", ["name", "user_id", "search_query"])
    def test_list_traces_empty_filter_cache_key_matches_omitted_filter(self, filter_name):
        def side_effect(query, parameters=None):
            if "count(DISTINCT t.trace_id)" in query:
                return _rows([(1,)])
            return _rows([_list_trace_row()])

        service, client = _make_service(side_effect)

        service.list_traces("proj", use_cache=True, **{filter_name: ""})
        service.list_traces("proj", use_cache=True)

        assert client.query.call_count == 2

    def test_list_traces_bypasses_cache_when_requested(self):
        def side_effect(query, parameters=None):
            if "count(DISTINCT t.trace_id)" in query:
                return _rows([(1,)])
            return _rows([_list_trace_row()])

        service, client = _make_service(side_effect)

        service.list_traces("proj", limit=5, use_cache=False)
        service.list_traces("proj", limit=5, use_cache=False)

        assert client.query.call_count == 4

    def test_list_traces_bypass_does_not_build_cache_key(self):
        def side_effect(query, parameters=None):
            if "count(DISTINCT t.trace_id)" in query:
                return _rows([(1,)])
            return _rows([_list_trace_row()])

        service, client = _make_service(side_effect)

        with patch.object(service, "_cache_key_string", side_effect=AssertionError):
            result = service.list_traces("proj", limit=5, use_cache=False)

        assert result["data"][0]["trace_id"] == "abc123"
        assert client.query.call_count == 2

    def test_list_traces_defaults_to_fresh_reads(self):
        def side_effect(query, parameters=None):
            if "count(DISTINCT t.trace_id)" in query:
                return _rows([(1,)])
            return _rows([_list_trace_row()])

        service, client = _make_service(side_effect)

        service.list_traces("proj", limit=5)
        service.list_traces("proj", limit=5)

        assert client.query.call_count == 4

    def test_list_traces_bypass_does_not_seed_empty_cache(self):
        trace_rows = iter(
            [
                _list_trace_row(input_value="fresh-bypass"),
                _list_trace_row(input_value="cacheable"),
            ]
        )

        def side_effect(query, parameters=None):
            if "count(DISTINCT t.trace_id)" in query:
                return _rows([(1,)])
            return _rows([next(trace_rows)])

        service, client = _make_service(side_effect)

        fresh_bypass = service.list_traces("proj", limit=5, use_cache=False)
        cacheable = service.list_traces("proj", limit=5, use_cache=True)
        cached_again = service.list_traces("proj", limit=5, use_cache=True)

        assert fresh_bypass["data"][0]["input"] == "fresh-bypass"
        assert cacheable["data"][0]["input"] == "cacheable"
        assert cached_again["data"][0]["input"] == "cacheable"
        assert client.query.call_count == 4

    def test_list_traces_bypass_does_not_update_existing_cache_entry(self):
        trace_rows = iter(
            [
                _list_trace_row(input_value="cached"),
                _list_trace_row(input_value="fresh-bypass"),
            ]
        )

        def side_effect(query, parameters=None):
            if "count(DISTINCT t.trace_id)" in query:
                return _rows([(1,)])
            return _rows([next(trace_rows)])

        service, client = _make_service(side_effect)

        cached_seed = service.list_traces("proj", limit=5, use_cache=True)
        fresh_bypass = service.list_traces("proj", limit=5, use_cache=False)
        cached_again = service.list_traces("proj", limit=5, use_cache=True)

        assert cached_seed["data"][0]["input"] == "cached"
        assert fresh_bypass["data"][0]["input"] == "fresh-bypass"
        assert cached_again["data"][0]["input"] == "cached"
        assert client.query.call_count == 4

    def test_list_traces_cache_expires_after_ttl(self):
        clock = _FakeClock()

        def side_effect(query, parameters=None):
            if "count(DISTINCT t.trace_id)" in query:
                return _rows([(1,)])
            return _rows([_list_trace_row()])

        service, client = _make_service(
            side_effect,
            cache_ttl_seconds=10.0,
            clock=clock,
        )

        service.list_traces("proj", limit=5, use_cache=True)
        clock.advance(10.1)
        service.list_traces("proj", limit=5, use_cache=True)

        assert client.query.call_count == 4

    @pytest.mark.parametrize("datetime_filter", ["start_after", "end_before"])
    def test_list_traces_datetime_cache_key_matches_query_precision(self, datetime_filter):
        def side_effect(query, parameters=None):
            if "count(DISTINCT t.trace_id)" in query:
                return _rows([(1,)])
            return _rows([_list_trace_row()])

        service, client = _make_service(side_effect)
        first_value = datetime(2024, 1, 1, 12, 0, 0, 123400, tzinfo=UTC)
        same_millisecond_value = datetime(
            2024,
            1,
            1,
            4,
            0,
            0,
            123499,
            tzinfo=timezone(timedelta(hours=-8)),
        )
        adjacent_millisecond_value = datetime(2024, 1, 1, 12, 0, 0, 124000, tzinfo=UTC)

        service.list_traces("proj", use_cache=True, **{datetime_filter: first_value})
        service.list_traces("proj", use_cache=True, **{datetime_filter: same_millisecond_value})
        service.list_traces("proj", use_cache=True, **{datetime_filter: adjacent_millisecond_value})

        assert client.query.call_count == 4

    def test_list_traces_records_cache_fetch_time_before_clickhouse_queries(self):
        clock = _FakeClock()

        def side_effect(query, parameters=None):
            clock.advance(5.0)
            if "count(DISTINCT t.trace_id)" in query:
                return _rows([(1,)])
            return _rows([_list_trace_row()])

        service, _ = _make_service(side_effect, clock=clock)
        original_write_cache = service._write_cache
        captured = {}

        def capture_write_cache(key, value, *, fetched_at=None):
            captured["fetched_at"] = fetched_at
            original_write_cache(key, value, fetched_at=fetched_at)

        with patch.object(service, "_write_cache", side_effect=capture_write_cache):
            service.list_traces("proj", use_cache=True)

        assert captured["fetched_at"] == 0.0

    def test_list_traces_cache_evicts_oldest_entry_at_capacity(self):
        def side_effect(query, parameters=None):
            if "count(DISTINCT t.trace_id)" in query:
                return _rows([(1,)])
            return _rows([_list_trace_row()])

        service, client = _make_service(side_effect, cache_max_entries=2)

        service.list_traces("proj", search_query="first", use_cache=True)
        service.list_traces("proj", search_query="second", use_cache=True)
        service.list_traces("proj", search_query="third", use_cache=True)
        service.list_traces("proj", search_query="second", use_cache=True)
        service.list_traces("proj", search_query="first", use_cache=True)
        service.list_traces("proj", search_query="third", use_cache=True)

        assert client.query.call_count == 10

    def test_list_traces_skips_entries_over_size_cap(self):
        def side_effect(query, parameters=None):
            if "count(DISTINCT t.trace_id)" in query:
                return _rows([(1,)])
            return _rows([_list_trace_row(input_value="x" * 2048)])

        service, client = _make_service(side_effect, cache_max_entry_bytes=512)

        service.list_traces("proj", limit=5, use_cache=True)
        service.list_traces("proj", limit=5, use_cache=True)

        assert client.query.call_count == 4

    def test_cache_rejects_oversized_entry_before_deepcopy(self, monkeypatch):
        def side_effect(query, parameters=None):
            return _rows([])

        service, _ = _make_service(side_effect, cache_max_entry_bytes=1)

        def fail_deepcopy(value):
            raise AssertionError("oversized cache values must be rejected before deepcopy")

        monkeypatch.setattr("rest.services.trace_reader.deepcopy", fail_deepcopy)

        service._write_cache(("oversized",), {"payload": "x" * 2048})

        assert service._trace_read_cache == {}

    def test_cache_evicts_oldest_entry_when_total_byte_cap_is_exceeded(self):
        clock = _FakeClock()

        def side_effect(query, parameters=None):
            return _rows([])

        service, _ = _make_service(side_effect, clock=clock)
        from rest.services.trace_reader import _CACHE_MISS

        first_key = ("first",)
        second_key = ("second",)
        first_payload = {"payload": "a" * 128}
        second_payload = {"payload": "b" * 128}
        first_size = service._cache_value_size(first_key) + service._cache_value_size(first_payload)
        second_size = service._cache_value_size(second_key) + service._cache_value_size(
            second_payload
        )
        service._cache_max_bytes = first_size + second_size - 1

        service._write_cache(first_key, first_payload, fetched_at=1.0)
        service._write_cache(second_key, second_payload, fetched_at=2.0)

        assert service._read_cache(first_key) is _CACHE_MISS
        assert service._read_cache(second_key) == second_payload
        assert service._trace_read_cache_bytes == second_size

    def test_cache_budget_counts_key_bytes_and_hashes_user_filter_key_strings(self):
        short_search_query = "secret@example.com"
        long_search_query = "x" * 100_000

        def side_effect(query, parameters=None):
            if "count(DISTINCT t.trace_id)" in query:
                return _rows([(0,)])
            return _rows([])

        service, _ = _make_service(side_effect)

        service.list_traces("proj", search_query=short_search_query, use_cache=True)
        service.list_traces("proj", search_query=long_search_query, use_cache=True)

        cache_keys = list(service._trace_read_cache.keys())
        assert len(cache_keys) == 2
        for cache_key in cache_keys:
            assert "proj" not in cache_key
            assert short_search_query not in cache_key
            assert long_search_query not in cache_key
            assert service._trace_read_cache_bytes >= service._cache_value_size(cache_key)

    def test_cache_does_not_overwrite_newer_snapshot_with_older_write(self):
        clock = _FakeClock()

        def side_effect(query, parameters=None):
            return _rows([])

        service, _ = _make_service(side_effect, clock=clock)
        key = ("get_trace", "proj", "abc123")

        service._write_cache(key, {"version": "newer"}, fetched_at=2.0)
        service._write_cache(key, {"version": "older"}, fetched_at=1.0)

        cached = service._read_cache(key)
        assert cached == {"version": "newer"}

    def test_cache_does_not_overwrite_snapshot_with_equal_fetch_time(self):
        clock = _FakeClock()

        def side_effect(query, parameters=None):
            return _rows([])

        service, _ = _make_service(side_effect, clock=clock)
        key = ("get_trace", "proj", "abc123")

        service._write_cache(key, {"version": "first"}, fetched_at=1.0)
        service._write_cache(key, {"version": "same-tick-second"}, fetched_at=1.0)

        cached = service._read_cache(key)
        assert cached == {"version": "first"}

    def test_cache_skips_result_when_fetch_already_exceeded_ttl(self):
        clock = _FakeClock()

        def side_effect(query, parameters=None):
            return _rows([])

        service, _ = _make_service(side_effect, cache_ttl_seconds=10.0, clock=clock)
        key = ("get_trace", "proj", "abc123")

        clock.advance(10.1)
        service._write_cache(key, {"version": "too-old"}, fetched_at=0.0)

        from rest.services.trace_reader import _CACHE_MISS

        assert service._read_cache(key) is _CACHE_MISS

    def test_get_trace_reuses_skeleton_within_ttl_without_sharing_mutations(self):
        def side_effect(query, parameters=None):
            if "FROM traces" in query and "FROM spans" not in query:
                return _rows([_trace_row()])
            return _rows([_span_row()])

        service, client = _make_service(side_effect)

        first = service.get_trace("proj", "abc123", use_cache=True)
        first["spans"][0]["input"] = "hydrated by caller"
        first["spans"].append({"span_id": "caller-added"})
        second = service.get_trace("proj", "abc123", use_cache=True)
        second["spans"][0]["input"] = "mutated cached return"
        third = service.get_trace("proj", "abc123", use_cache=True)

        assert client.query.call_count == 2
        assert len(second["spans"]) == 1
        assert len(third["spans"]) == 1
        assert "input" not in third["spans"][0]
        assert third["spans"][0]["span_id"] == "span-1"

    def test_get_trace_cache_survives_projection_hydration_without_pollution(self):
        def side_effect(query, parameters=None):
            if "FROM traces" in query and "FROM spans" not in query:
                return _rows([_trace_row()])
            return _rows([_span_row()])

        service, client = _make_service(side_effect)
        from rest.projection import FULL, SKELETON, hydrate_span_io

        hydrated = service.get_trace("proj", "abc123", use_cache=True)
        with patch.object(
            service,
            "get_trace_spans_io",
            return_value={"span-1": {"input": "the-in", "output": "the-out", "metadata": "m"}},
        ):
            hydrate_span_io(
                service,
                hydrated,
                project_id="proj",
                trace_id="abc123",
                groups=FULL,
            )

        skeleton = service.get_trace("proj", "abc123", use_cache=True)
        hydrate_span_io(service, skeleton, project_id="proj", trace_id="abc123", groups=SKELETON)

        assert client.query.call_count == 2
        assert "input" not in skeleton["spans"][0]
        assert "output" not in skeleton["spans"][0]
        assert "metadata" not in skeleton["spans"][0]

    def test_get_trace_cache_key_distinguishes_project_and_trace(self):
        def side_effect(query, parameters=None):
            if "FROM traces" in query and "FROM spans" not in query:
                return _rows(
                    [
                        _trace_row(
                            trace_id=parameters["trace_id"],
                            project_id=parameters["project_id"],
                        )
                    ]
                )
            return _rows(
                [
                    _span_row(
                        trace_id=parameters["trace_id"],
                        name=f"root-{parameters['project_id']}",
                    )
                ]
            )

        service, client = _make_service(side_effect)

        project_a = service.get_trace("proj-a", "abc123", use_cache=True)
        project_b = service.get_trace("proj-b", "abc123", use_cache=True)
        trace_b = service.get_trace("proj-a", "trace-b", use_cache=True)

        assert client.query.call_count == 6
        assert project_a["project_id"] == "proj-a"
        assert project_b["project_id"] == "proj-b"
        assert trace_b["trace_id"] == "trace-b"

    def test_get_trace_cache_key_hashes_project_and_trace_strings(self):
        def side_effect(query, parameters=None):
            if "FROM traces" in query and "FROM spans" not in query:
                return _rows(
                    [
                        _trace_row(
                            trace_id=parameters["trace_id"],
                            project_id=parameters["project_id"],
                        )
                    ]
                )
            return _rows([_span_row(trace_id=parameters["trace_id"])])

        service, _ = _make_service(side_effect)

        service.get_trace("secret-project", "secret-trace-id", use_cache=True)

        [cache_key] = service._trace_read_cache.keys()
        assert "secret-project" not in cache_key
        assert "secret-trace-id" not in cache_key
        assert service._trace_read_cache_bytes >= service._cache_value_size(cache_key)

    def test_get_trace_cache_expires_after_ttl(self):
        clock = _FakeClock()

        def side_effect(query, parameters=None):
            if "FROM traces" in query and "FROM spans" not in query:
                return _rows([_trace_row()])
            return _rows([_span_row()])

        service, client = _make_service(
            side_effect,
            cache_ttl_seconds=10.0,
            clock=clock,
        )

        service.get_trace("proj", "abc123", use_cache=True)
        clock.advance(10.1)
        service.get_trace("proj", "abc123", use_cache=True)

        assert client.query.call_count == 4

    def test_get_trace_records_cache_fetch_time_before_clickhouse_queries(self):
        clock = _FakeClock()

        def side_effect(query, parameters=None):
            clock.advance(5.0)
            if "FROM traces" in query and "FROM spans" not in query:
                return _rows([_trace_row()])
            return _rows([_span_row()])

        service, _ = _make_service(side_effect, clock=clock)
        original_write_cache = service._write_cache
        captured = {}

        def capture_write_cache(key, value, *, fetched_at=None):
            captured["fetched_at"] = fetched_at
            original_write_cache(key, value, fetched_at=fetched_at)

        with patch.object(service, "_write_cache", side_effect=capture_write_cache):
            service.get_trace("proj", "abc123", use_cache=True)

        assert captured["fetched_at"] == 0.0

    def test_get_trace_bypasses_cache_when_requested(self):
        def side_effect(query, parameters=None):
            if "FROM traces" in query and "FROM spans" not in query:
                return _rows([_trace_row()])
            return _rows([_span_row()])

        service, client = _make_service(side_effect)

        service.get_trace("proj", "abc123", use_cache=False)
        service.get_trace("proj", "abc123", use_cache=False)

        assert client.query.call_count == 4

    def test_get_trace_bypass_does_not_build_cache_key(self):
        def side_effect(query, parameters=None):
            if "FROM traces" in query and "FROM spans" not in query:
                return _rows([_trace_row()])
            return _rows([_span_row()])

        service, client = _make_service(side_effect)

        with patch.object(service, "_cache_key_string", side_effect=AssertionError):
            result = service.get_trace("proj", "abc123", use_cache=False)

        assert result["trace_id"] == "abc123"
        assert client.query.call_count == 2

    def test_get_trace_defaults_to_fresh_reads(self):
        def side_effect(query, parameters=None):
            if "FROM traces" in query and "FROM spans" not in query:
                return _rows([_trace_row()])
            return _rows([_span_row()])

        service, client = _make_service(side_effect)

        service.get_trace("proj", "abc123")
        service.get_trace("proj", "abc123")

        assert client.query.call_count == 4

    def test_get_trace_bypass_does_not_seed_empty_cache(self):
        trace_rows = iter(
            [
                _trace_row(input_value="fresh-bypass"),
                _trace_row(input_value="cacheable"),
            ]
        )

        def side_effect(query, parameters=None):
            if "FROM traces" in query and "FROM spans" not in query:
                return _rows([next(trace_rows)])
            return _rows([_span_row()])

        service, client = _make_service(side_effect)

        fresh_bypass = service.get_trace("proj", "abc123", use_cache=False)
        cacheable = service.get_trace("proj", "abc123", use_cache=True)
        cached_again = service.get_trace("proj", "abc123", use_cache=True)

        assert fresh_bypass["input"] == "fresh-bypass"
        assert cacheable["input"] == "cacheable"
        assert cached_again["input"] == "cacheable"
        assert client.query.call_count == 4

    def test_get_trace_bypass_does_not_update_existing_cache_entry(self):
        trace_rows = iter(
            [
                _trace_row(input_value="cached"),
                _trace_row(input_value="fresh-bypass"),
            ]
        )

        def side_effect(query, parameters=None):
            if "FROM traces" in query and "FROM spans" not in query:
                return _rows([next(trace_rows)])
            return _rows([_span_row()])

        service, client = _make_service(side_effect)

        cached_seed = service.get_trace("proj", "abc123", use_cache=True)
        fresh_bypass = service.get_trace("proj", "abc123", use_cache=False)
        cached_again = service.get_trace("proj", "abc123", use_cache=True)

        assert cached_seed["input"] == "cached"
        assert fresh_bypass["input"] == "fresh-bypass"
        assert cached_again["input"] == "cached"
        assert client.query.call_count == 4

    def test_get_trace_skips_entries_over_size_cap(self):
        def side_effect(query, parameters=None):
            if "FROM traces" in query and "FROM spans" not in query:
                return _rows([_trace_row(input_value="x" * 2048)])
            return _rows([_span_row()])

        service, client = _make_service(side_effect, cache_max_entry_bytes=512)

        service.get_trace("proj", "abc123", use_cache=True)
        service.get_trace("proj", "abc123", use_cache=True)

        assert client.query.call_count == 4

    def test_get_trace_missing_result_is_not_cached(self):
        def side_effect(query, parameters=None):
            return _rows([])

        service, client = _make_service(side_effect)

        assert service.get_trace("proj", "missing", use_cache=True) is None
        assert service.get_trace("proj", "missing", use_cache=True) is None

        assert client.query.call_count == 2


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
