"""Tests for lifting the traceroot.source marker in otel_transform."""

import base64
import json

from worker.otel_transform import transform_otel_to_clickhouse


def _make_trace_id() -> str:
    """Return a base64-encoded 16-byte trace ID."""
    return base64.b64encode(b"\x01" * 16).decode()


def _make_span_id(byte: int = 0x02) -> str:
    """Return a base64-encoded 8-byte span ID."""
    return base64.b64encode(bytes([byte] * 8)).decode()


def _attr(key: str, value: str) -> dict:
    """Build an OTEL string attribute entry."""
    return {"key": key, "value": {"stringValue": value}}


def _otel_payload(span_attributes: list[dict], *, parent_span_id: str | None = None) -> dict:
    """Build a minimal OTEL payload with one span (root unless a parent is given)."""
    span = {
        "traceId": _make_trace_id(),
        "spanId": _make_span_id(),
        "name": "test-span",
        "kind": "SPAN_KIND_INTERNAL",
        "startTimeUnixNano": "1700000000000000000",
        "endTimeUnixNano": "1700000001000000000",
        "attributes": span_attributes,
        "status": {},
    }
    if parent_span_id is not None:
        span["parentSpanId"] = parent_span_id
    return {
        "resourceSpans": [
            {
                "resource": {"attributes": []},
                "scopeSpans": [{"scope": {"name": "test"}, "spans": [span]}],
            }
        ]
    }


def test_source_marker_lifted_onto_span_and_trace():
    """traceroot.source becomes the span and trace source field."""
    payload = _otel_payload([_attr("traceroot.source", "detector")])

    traces, spans = transform_otel_to_clickhouse(payload, project_id="proj-1")

    assert len(spans) == 1
    assert spans[0]["source"] == "detector"
    assert len(traces) == 1
    assert traces[0]["source"] == "detector"


def test_source_from_child_span_reaches_trace():
    """A batch without the root span still stamps source on the trace record.

    Every batch re-inserts a trace row and ReplacingMergeTree keeps the
    newest one, so a child-only batch that dropped the marker would flip
    an already-classified trace back to 'user'.
    """
    payload = _otel_payload(
        [_attr("traceroot.source", "detector")],
        parent_span_id=_make_span_id(0x03),
    )

    traces, _spans = transform_otel_to_clickhouse(payload, project_id="proj-1")

    assert traces[0]["source"] == "detector"


def test_source_marker_not_duplicated_into_metadata():
    """traceroot.source is a known attribute, so it stays out of the blob."""
    payload = _otel_payload(
        [
            _attr("traceroot.source", "detector"),
            _attr("my.custom.attr", "hello"),
        ]
    )

    traces, spans = transform_otel_to_clickhouse(payload, project_id="proj-1")

    span_metadata = json.loads(spans[0]["metadata"])
    assert span_metadata == {"my.custom.attr": "hello"}

    # Trace metadata only ever comes from traceroot.trace.metadata, so the
    # marker must not conjure one up.
    assert traces[0].get("metadata") is None


def test_records_without_marker_carry_no_source():
    """Spans without the marker leave source unset (insert defaults to user)."""
    payload = _otel_payload([])

    traces, spans = transform_otel_to_clickhouse(payload, project_id="proj-1")

    assert "source" not in spans[0]
    assert "source" not in traces[0]
