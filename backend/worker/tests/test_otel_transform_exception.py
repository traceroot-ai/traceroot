"""Tests for exception event extraction in otel_transform."""

import base64

from worker.otel_transform import transform_otel_to_clickhouse


def _tid(byte: int = 0x01) -> str:
    return base64.b64encode(bytes([byte] * 16)).decode()


def _sid(byte: int = 0x02) -> str:
    return base64.b64encode(bytes([byte] * 8)).decode()


def _str_attr(key: str, value: str) -> dict:
    return {"key": key, "value": {"stringValue": value}}


def _span(
    name: str,
    *,
    status_code: int = 0,
    events: list[dict] | None = None,
) -> dict:
    s = {
        "traceId": _tid(),
        "spanId": _sid(),
        "name": name,
        "kind": "SPAN_KIND_INTERNAL",
        "startTimeUnixNano": "1700000000000000000",
        "endTimeUnixNano": "1700000001000000000",
        "attributes": [],
        "status": {"code": status_code},
    }
    if events is not None:
        s["events"] = events
    return s


def _payload(span: dict) -> dict:
    return {
        "resourceSpans": [
            {
                "resource": {"attributes": []},
                "scopeSpans": [{"scope": {"name": "test"}, "spans": [span]}],
            }
        ]
    }


def test_error_span_with_exception_type():
    """An ERROR span with an exception event extracts exception.type."""
    span = _span(
        "failing_tool",
        status_code=2,  # ERROR
        events=[
            {
                "name": "exception",
                "attributes": [_str_attr("exception.type", "ValueError")],
            }
        ],
    )

    _, spans = transform_otel_to_clickhouse(_payload(span), project_id="proj-1")

    assert len(spans) == 1
    assert spans[0]["status"] == "ERROR"
    assert spans[0]["error_type"] == "ValueError"


def test_error_span_with_exception_event_but_no_type():
    """An ERROR span with an exception event but no type attribute falls back to 'unknown'."""
    span = _span(
        "failing_tool",
        status_code=2,  # ERROR
        events=[
            {
                "name": "exception",
                "attributes": [_str_attr("other.attr", "some_value")],
            }
        ],
    )

    _, spans = transform_otel_to_clickhouse(_payload(span), project_id="proj-1")

    assert len(spans) == 1
    assert spans[0]["status"] == "ERROR"
    assert spans[0]["error_type"] == "unknown"


def test_error_span_without_exception_event():
    """An ERROR span without any exception event falls back to 'unknown'."""
    span = _span(
        "failing_tool",
        status_code=2,  # ERROR
        events=[
            {
                "name": "some_other_event",
                "attributes": [],
            }
        ],
    )

    _, spans = transform_otel_to_clickhouse(_payload(span), project_id="proj-1")

    assert len(spans) == 1
    assert spans[0]["status"] == "ERROR"
    assert spans[0]["error_type"] == "unknown"


def test_ok_span_ignores_exception():
    """An OK span stores an empty string for error_type, even if it has an exception event."""
    span = _span(
        "successful_tool",
        status_code=0,  # UNSET (effectively OK)
        events=[
            {
                "name": "exception",
                "attributes": [_str_attr("exception.type", "HandledError")],
            }
        ],
    )

    _, spans = transform_otel_to_clickhouse(_payload(span), project_id="proj-1")

    assert len(spans) == 1
    assert spans[0]["status"] == "OK"
    assert spans[0]["error_type"] == ""


def test_error_span_multiple_exceptions_first_has_no_type():
    """If the first exception has no type, it scans until it finds one."""
    span = _span(
        "failing_tool",
        status_code=2,  # ERROR
        events=[
            {
                "name": "exception",
                "attributes": [_str_attr("other.attr", "some_value")],
            },
            {
                "name": "exception",
                "attributes": [_str_attr("exception.type", "ValueError")],
            },
        ],
    )

    _, spans = transform_otel_to_clickhouse(_payload(span), project_id="proj-1")

    assert len(spans) == 1
    assert spans[0]["status"] == "ERROR"
    assert spans[0]["error_type"] == "ValueError"
