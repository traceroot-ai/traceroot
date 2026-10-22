"""Trace-level metadata follows user_id/session_id from child spans (#2688).

``update_current_trace(metadata=...)`` stamps ``traceroot.trace.metadata`` on the
*current* span, which inside a nested ``@observe`` function is a child span. The
transform lifted ``user_id``/``session_id`` from any span onto the trace row, but
metadata was read only from the root span, so a trace whose metadata arrived on a
child span (same batch or an earlier one) stored none.
"""

import base64
import json

from worker.otel_transform import transform_otel_to_clickhouse


def _tid(byte: int = 0x07) -> str:
    return base64.b64encode(bytes([byte] * 16)).decode()


def _sid(byte: int = 0x02) -> str:
    return base64.b64encode(bytes([byte] * 8)).decode()


def _str_attr(key: str, value: str) -> dict:
    return {"key": key, "value": {"stringValue": value}}


def _span(
    name: str,
    *,
    trace_id: str,
    span_id: str,
    parent_span_id: str | None = None,
    attributes: list[dict] | None = None,
) -> dict:
    s = {
        "traceId": trace_id,
        "spanId": span_id,
        "name": name,
        "kind": "SPAN_KIND_INTERNAL",
        "startTimeUnixNano": "1700000000000000000",
        "endTimeUnixNano": "1700000001000000000",
        "attributes": attributes or [],
        "status": {},
    }
    if parent_span_id is not None:
        s["parentSpanId"] = parent_span_id
    return s


def _payload(*spans: dict) -> dict:
    return {
        "resourceSpans": [
            {
                "resource": {"attributes": []},
                "scopeSpans": [{"scope": {"name": "test"}, "spans": list(spans)}],
            }
        ]
    }


def test_trace_metadata_on_a_child_span_reaches_the_trace_row():
    # update_current_trace() called inside a nested @observe function: the
    # attrs live on the child, the root carries none.
    child = _span(
        "load_user",
        trace_id=_tid(),
        span_id=_sid(0x02),
        parent_span_id=_sid(0x01),
        attributes=[
            _str_attr("traceroot.span.type", "SPAN"),
            _str_attr("traceroot.trace.user_id", "u-42"),
            _str_attr("traceroot.trace.session_id", "sess-1"),
            _str_attr("traceroot.trace.metadata", json.dumps({"plan": "pro"})),
        ],
    )
    root = _span(
        "handle_request",
        trace_id=_tid(),
        span_id=_sid(0x01),
        attributes=[_str_attr("traceroot.span.type", "AGENT")],
    )

    traces, _spans = transform_otel_to_clickhouse(_payload(child, root), "p")

    row = traces[0]
    assert row["user_id"] == "u-42"
    assert row["session_id"] == "sess-1"
    assert json.loads(row["metadata"]) == {"plan": "pro"}


def test_child_metadata_works_when_the_root_is_in_a_later_batch():
    # BatchSpanProcessor order: the child is exported first, alone.
    child = _span(
        "load_user",
        trace_id=_tid(),
        span_id=_sid(0x02),
        parent_span_id=_sid(0x01),
        attributes=[
            _str_attr("traceroot.span.type", "SPAN"),
            _str_attr("traceroot.trace.metadata", json.dumps({"plan": "pro"})),
        ],
    )

    traces, _spans = transform_otel_to_clickhouse(_payload(child), "p")

    assert json.loads(traces[0]["metadata"]) == {"plan": "pro"}


def test_root_metadata_still_wins_over_a_child_value():
    child = _span(
        "load_user",
        trace_id=_tid(),
        span_id=_sid(0x02),
        parent_span_id=_sid(0x01),
        attributes=[
            _str_attr("traceroot.span.type", "SPAN"),
            _str_attr("traceroot.trace.metadata", json.dumps({"plan": "child"})),
        ],
    )
    root = _span(
        "handle_request",
        trace_id=_tid(),
        span_id=_sid(0x01),
        attributes=[
            _str_attr("traceroot.span.type", "AGENT"),
            _str_attr("traceroot.trace.metadata", json.dumps({"plan": "root"})),
        ],
    )

    traces, _spans = transform_otel_to_clickhouse(_payload(child, root), "p")

    assert json.loads(traces[0]["metadata"]) == {"plan": "root"}


def test_a_trace_without_metadata_anywhere_stays_without_it():
    root = _span(
        "handle_request",
        trace_id=_tid(),
        span_id=_sid(0x01),
        attributes=[_str_attr("traceroot.span.type", "AGENT")],
    )

    traces, _spans = transform_otel_to_clickhouse(_payload(root), "p")

    assert "metadata" not in traces[0] or traces[0].get("metadata") is None
