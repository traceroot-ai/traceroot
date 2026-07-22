"""Unit tests for OTEL span-event capture (exception records + breadcrumbs).

Covers `extract_span_events` normalization, the persisted `events` blob on span
records, and the ERROR status_message fallback derived from exception events —
the path that makes error spans carry their stack trace instead of dropping it.
"""

import json

from tests.fixtures.otel_payloads import (
    PYTHON_STACKTRACE,
    make_attr,
    make_event,
    make_exception_event,
    make_otel_payload,
    make_span,
)
from worker.otel_transform import (
    _MAX_SPAN_EVENTS,
    extract_span_events,
    transform_otel_to_clickhouse,
)

TRACE_ID = "0af7651916cd43dd8448eb211c80319c"
SPAN_ID = "b7ad6b7169203331"


def _span_with_events(events: list[dict], status_code: int = 0, **kwargs) -> dict:
    span = make_span(TRACE_ID, SPAN_ID, status_code=status_code, **kwargs)
    span["events"] = events
    return span


def _transform_single(span: dict) -> dict:
    _, spans = transform_otel_to_clickhouse(make_otel_payload([span]), "proj-1")
    assert len(spans) == 1
    return spans[0]


class TestExtractSpanEvents:
    def test_exception_event_normalized(self):
        span = _span_with_events([make_exception_event()])
        events = extract_span_events(span)
        assert len(events) == 1
        event = events[0]
        assert event["name"] == "exception"
        # timeUnixNano decoded to ISO-8601, not passed through as a nano string.
        assert event["timestamp"] == "2024-01-15T12:00:00.500000"
        assert event["attributes"]["exception.type"] == "ZeroDivisionError"
        assert event["attributes"]["exception.message"] == "division by zero"
        assert event["attributes"]["exception.stacktrace"] == PYTHON_STACKTRACE

    def test_custom_event_preserved(self):
        span = _span_with_events(
            [make_event("cache.miss", attributes=[make_attr("cache.key", "user:42")])]
        )
        events = extract_span_events(span)
        assert events == [
            {
                "name": "cache.miss",
                "timestamp": "2024-01-15T12:00:00.500000",
                "attributes": {"cache.key": "user:42"},
            }
        ]

    def test_payload_order_preserved(self):
        span = _span_with_events(
            [
                make_event("first", time_nanos=1705320000100000000),
                make_exception_event(time_nanos=1705320000200000000),
                make_event("last", time_nanos=1705320000300000000),
            ]
        )
        assert [e["name"] for e in extract_span_events(span)] == ["first", "exception", "last"]

    def test_no_events_key(self):
        assert extract_span_events(make_span(TRACE_ID, SPAN_ID)) == []

    def test_empty_and_non_list_events(self):
        assert extract_span_events(_span_with_events([])) == []
        assert extract_span_events({"events": "not-a-list"}) == []
        assert extract_span_events({"events": {"name": "exception"}}) == []

    def test_malformed_entries_skipped_valid_kept(self):
        span = _span_with_events(
            [
                "not-a-dict",
                {"name": "no-time-or-attrs"},  # minimal but valid: all fields optional
                {"timeUnixNano": "not-a-number", "name": "bad-time"},
                make_exception_event(),
            ]
        )
        events = extract_span_events(span)
        names = [e["name"] for e in events]
        # The string entry and the unparsable-time entry are dropped; the
        # minimal dict normalizes with None timestamp; the exception survives.
        assert names == ["no-time-or-attrs", "exception"]
        assert events[0]["timestamp"] is None
        assert events[0]["attributes"] == {}

    def test_missing_name_normalizes_to_empty_string(self):
        span = _span_with_events([{"timeUnixNano": "1705320000500000000"}])
        assert extract_span_events(span)[0]["name"] == ""

    def test_capped_at_max_events(self):
        span = _span_with_events([make_event(f"e{i}") for i in range(_MAX_SPAN_EVENTS + 10)])
        events = extract_span_events(span)
        assert len(events) == _MAX_SPAN_EVENTS
        assert events[-1]["name"] == f"e{_MAX_SPAN_EVENTS - 1}"


class TestTransformPersistsEvents:
    def test_events_stored_as_json_blob(self):
        record = _transform_single(_span_with_events([make_exception_event()]))
        stored = json.loads(record["events"])
        assert stored[0]["name"] == "exception"
        assert stored[0]["attributes"]["exception.stacktrace"] == PYTHON_STACKTRACE

    def test_no_events_leaves_column_unset(self):
        # Event-less spans (the overwhelming majority) must not carry an empty
        # blob — the column stays NULL, exactly like input/output/metadata.
        record = _transform_single(make_span(TRACE_ID, SPAN_ID))
        assert "events" not in record

    def test_events_survive_alongside_explicit_metadata(self):
        span = _span_with_events([make_exception_event()])
        span["attributes"] = [make_attr("traceroot.span.metadata", '{"k": "v"}')]
        record = _transform_single(span)
        assert json.loads(record["events"])[0]["name"] == "exception"
        assert json.loads(record["metadata"]) == {"k": "v"}


class TestErrorMessageDerivation:
    def test_error_without_message_derived_from_exception(self):
        # The TS SDK always sets ERROR without a message; the exception event
        # is the only place the reason exists. It must surface.
        record = _transform_single(_span_with_events([make_exception_event()], status_code=2))
        assert record["status"] == "ERROR"
        assert record["status_message"] == "ZeroDivisionError: division by zero"

    def test_explicit_status_message_wins(self):
        span = _span_with_events([make_exception_event()], status_code=2)
        span["status"]["message"] = "explicit reason"
        record = _transform_single(span)
        assert record["status_message"] == "explicit reason"

    def test_newest_exception_wins(self):
        # With retries a span can record several exceptions; the last one is
        # the one that made it fail.
        record = _transform_single(
            _span_with_events(
                [
                    make_exception_event("TimeoutError", "attempt 1 timed out"),
                    make_exception_event("ValueError", "bad tool output"),
                ],
                status_code=2,
            )
        )
        assert record["status_message"] == "ValueError: bad tool output"

    def test_partial_exception_attrs(self):
        event = make_event(
            "exception", attributes=[make_attr("exception.message", "only a message")]
        )
        record = _transform_single(_span_with_events([event], status_code=2))
        assert record["status_message"] == "only a message"

    def test_error_with_no_exception_event_keeps_null_message(self):
        record = _transform_single(_span_with_events([make_event("retry")], status_code=2))
        assert record["status"] == "ERROR"
        assert record["status_message"] is None

    def test_ok_span_with_exception_event_stays_ok(self):
        # A caught-and-handled exception is a breadcrumb, not a failure: keep
        # the event but never flip status or invent a status_message.
        record = _transform_single(_span_with_events([make_exception_event()]))
        assert record["status"] == "OK"
        assert "status_message" not in record
        assert json.loads(record["events"])[0]["name"] == "exception"

    def test_string_status_code_error_also_derives(self):
        span = _span_with_events([make_exception_event()])
        span["status"] = {"code": "STATUS_CODE_ERROR"}
        record = _transform_single(span)
        assert record["status_message"] == "ZeroDivisionError: division by zero"
