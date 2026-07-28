"""The transform never classifies traffic: it must not write `source` on any record,
whatever the payload declares. The secret-gated ingest route is the only writer."""

import base64
import json

import pytest

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


@pytest.mark.parametrize("declared", ["detector", "user", "anything-else", ""])
def test_transform_never_sets_source_whatever_the_payload_declares(declared):
    """The transform does not classify traffic — at all, for any caller.

    Classification is the ingest route's job: the secret-gated internal route stamps
    'detector' on what comes back, and every other row falls through to the column's
    written as 'user' by the insert helpers. Because no code path here reads it,
    a tenant cannot mark their own traffic as internal (which would hide it from
    their lists, dropdowns and metering) — the guarantee is structural rather than a
    coercion branch that a future caller could opt out of.
    """
    payload = _otel_payload([_attr("traceroot.source", declared)])

    traces, spans = transform_otel_to_clickhouse(payload, project_id="proj-1")

    assert "source" not in spans[0]
    assert "source" not in traces[0]


def test_transform_never_sets_source_from_a_child_only_batch():
    """Same for a batch carrying no root span — no lifting path exists either."""
    payload = _otel_payload(
        [_attr("traceroot.source", "detector")],
        parent_span_id=_make_span_id(0x03),
    )

    traces, spans = transform_otel_to_clickhouse(payload, project_id="proj-1")

    assert "source" not in spans[0]
    assert "source" not in traces[0]


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
