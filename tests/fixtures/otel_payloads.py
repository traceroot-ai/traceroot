"""Reusable OTEL payload builders for tests.

These builders create valid OTEL JSON structures (camelCase format)
matching what the transformer expects.
"""

import base64


def encode_id(hex_id: str) -> str:
    """Encode hex ID to base64 (OTLP wire format)."""
    return base64.b64encode(bytes.fromhex(hex_id)).decode()


def make_attr(key: str, value) -> dict:
    """Build an OTEL attribute entry."""
    if isinstance(value, bool):
        return {"key": key, "value": {"boolValue": value}}
    elif isinstance(value, str):
        return {"key": key, "value": {"stringValue": value}}
    elif isinstance(value, int):
        return {"key": key, "value": {"intValue": str(value)}}
    elif isinstance(value, float):
        return {"key": key, "value": {"doubleValue": value}}
    return {"key": key, "value": {"stringValue": str(value)}}


def make_span(
    trace_id_hex: str,
    span_id_hex: str,
    name: str = "test-span",
    parent_span_id_hex: str | None = None,
    start_nanos: int = 1705320000000000000,
    end_nanos: int = 1705320001000000000,
    attributes: list[dict] | None = None,
    status_code: int = 0,
) -> dict:
    """Build a single OTEL span dict."""
    span = {
        "traceId": encode_id(trace_id_hex),
        "spanId": encode_id(span_id_hex),
        "name": name,
        "startTimeUnixNano": str(start_nanos),
        "endTimeUnixNano": str(end_nanos),
        "attributes": attributes or [],
        "status": {"code": status_code},
    }
    if parent_span_id_hex:
        span["parentSpanId"] = encode_id(parent_span_id_hex)
    return span


def make_otel_payload(spans: list[dict]) -> dict:
    """Wrap span dicts into a full OTEL resourceSpans payload."""
    return {
        "resourceSpans": [
            {
                "resource": {"attributes": []},
                "scopeSpans": [{"scope": {"name": "test"}, "spans": spans}],
            }
        ]
    }
