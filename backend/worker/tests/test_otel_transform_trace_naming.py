"""Tests for trace naming logic in otel_transform.

Covers the corner cases introduced during live-trace-streaming work:
  - Eager trace name should use traceroot.span.path[0], not the span's own name
  - When a batch has spans at multiple depths, the shallowest span's path[0] wins
  - traceroot.span.path / traceroot.span.ids_path must be preserved in span metadata
    (enrichSpansWithPending on the frontend reads them to create phantom ancestor spans)
"""

import base64
import json

from worker.otel_transform import transform_otel_to_clickhouse

# ── Helpers ────────────────────────────────────────────────────────────────────


def _tid(byte: int = 0x01) -> str:
    return base64.b64encode(bytes([byte] * 16)).decode()


def _sid(byte: int = 0x02) -> str:
    return base64.b64encode(bytes([byte] * 8)).decode()


def _str_attr(key: str, value: str) -> dict:
    return {"key": key, "value": {"stringValue": value}}


def _arr_attr(key: str, values: list[str]) -> dict:
    return {
        "key": key,
        "value": {"arrayValue": {"values": [{"stringValue": v} for v in values]}},
    }


def _span(
    name: str,
    *,
    trace_id: str,
    span_id: str,
    parent_span_id: str | None = None,
    attributes: list[dict] | None = None,
    start_ns: str = "1700000000000000000",
    end_ns: str = "1700000001000000000",
) -> dict:
    s = {
        "traceId": trace_id,
        "spanId": span_id,
        "name": name,
        "kind": "SPAN_KIND_INTERNAL",
        "startTimeUnixNano": start_ns,
        "endTimeUnixNano": end_ns,
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


# ── Eager trace naming ─────────────────────────────────────────────────────────


def test_eager_trace_uses_path0_not_span_name():
    """When the first span in a batch is a child, trace name = path[0], not span name."""
    tid = _tid(0x01)
    parent_sid = _sid(0x10)  # phantom parent not in batch

    child = _span(
        "ChatAnthropic",
        trace_id=tid,
        span_id=_sid(0x02),
        parent_span_id=parent_sid,
        attributes=[
            _arr_attr("traceroot.span.path", ["research_session", "model", "ChatAnthropic"]),
            _arr_attr(
                "traceroot.span.ids_path",
                [_sid(0x10).encode().hex()[:16], _sid(0x11).encode().hex()[:16]],
            ),
        ],
    )

    traces, _ = transform_otel_to_clickhouse(_payload(child), project_id="proj-1")

    assert len(traces) == 1
    assert traces[0]["name"] == "research_session", (
        f"Expected 'research_session' from path[0], got {traces[0]['name']!r}"
    )


def test_eager_trace_falls_back_to_span_name_when_no_path():
    """When path attribute is absent, trace name falls back to the span's own name."""
    tid = _tid(0x01)
    parent_sid = _sid(0x10)

    child = _span(
        "SomeChildSpan",
        trace_id=tid,
        span_id=_sid(0x02),
        parent_span_id=parent_sid,
    )

    traces, _ = transform_otel_to_clickhouse(_payload(child), project_id="proj-1")

    assert traces[0]["name"] == "SomeChildSpan"


def test_root_span_always_sets_trace_name():
    """Root span (no parent) overrides any eager name from path[0]."""
    tid = _tid(0x01)

    root = _span(
        "actual_root",
        trace_id=tid,
        span_id=_sid(0x01),
        # root span may also carry a path attribute — its own name still wins
        attributes=[
            _arr_attr("traceroot.span.path", ["actual_root"]),
            _arr_attr("traceroot.span.ids_path", []),
        ],
    )

    traces, _ = transform_otel_to_clickhouse(_payload(root), project_id="proj-1")

    assert traces[0]["name"] == "actual_root"


# ── Shallowest-span-wins (batch contains multiple depths) ──────────────────────


def test_shallowest_span_wins_when_deep_span_arrives_first():
    """Even if a deep span is first in the batch, the shallowest span's path[0] is used."""
    tid = _tid(0x02)
    root_sid_hex = base64.b64decode(_sid(0x10)).hex()
    mid_sid_hex = base64.b64decode(_sid(0x11)).hex()

    # Depth-3 span arrives first
    deep = _span(
        "ChatAnthropic",
        trace_id=tid,
        span_id=_sid(0x03),
        parent_span_id=_sid(0x11),
        start_ns="1700000000100000000",
        attributes=[
            _arr_attr("traceroot.span.path", ["research_session", "model", "ChatAnthropic"]),
            _arr_attr("traceroot.span.ids_path", [root_sid_hex, mid_sid_hex]),
        ],
    )
    # Depth-1 span arrives second
    shallow = _span(
        "model",
        trace_id=tid,
        span_id=_sid(0x11),
        parent_span_id=_sid(0x10),
        start_ns="1700000000000000000",
        attributes=[
            _arr_attr("traceroot.span.path", ["research_session", "model"]),
            _arr_attr("traceroot.span.ids_path", [root_sid_hex]),
        ],
    )

    traces, _ = transform_otel_to_clickhouse(_payload(deep, shallow), project_id="proj-1")

    assert len(traces) == 1
    assert traces[0]["name"] == "research_session", (
        f"Expected shallowest span's path[0], got {traces[0]['name']!r}"
    )


def test_batch_with_root_span_uses_root_name():
    """When the root span is present in a batch, its name is always used."""
    tid = _tid(0x03)

    deep = _span(
        "ChatAnthropic",
        trace_id=tid,
        span_id=_sid(0x03),
        parent_span_id=_sid(0x02),
        attributes=[
            _arr_attr("traceroot.span.path", ["research_session", "model", "ChatAnthropic"]),
            _arr_attr("traceroot.span.ids_path", [_sid(0x01), _sid(0x02)]),
        ],
    )
    root = _span(
        "research_session",
        trace_id=tid,
        span_id=_sid(0x01),
        # no parent → this is the root
    )

    traces, _ = transform_otel_to_clickhouse(_payload(deep, root), project_id="proj-1")

    assert traces[0]["name"] == "research_session"


# ── path / ids_path preserved in metadata ──────────────────────────────────────


def test_span_path_preserved_in_metadata():
    """traceroot.span.path must NOT be stripped — enrichSpansWithPending reads it."""
    tid = _tid(0x04)
    path = ["research_session", "model", "ChatAnthropic"]
    ids_path = ["aabbccdd11223344", "aabbccdd11223345"]

    child = _span(
        "ChatAnthropic",
        trace_id=tid,
        span_id=_sid(0x02),
        parent_span_id=_sid(0x10),
        attributes=[
            _arr_attr("traceroot.span.path", path),
            _arr_attr("traceroot.span.ids_path", ids_path),
        ],
    )

    _, spans = transform_otel_to_clickhouse(_payload(child), project_id="proj-1")

    assert len(spans) == 1
    assert "metadata" in spans[0], "span should have metadata when path attrs are present"
    meta = json.loads(spans[0]["metadata"])
    assert meta.get("traceroot.span.path") == path, (
        "traceroot.span.path must be preserved in metadata for enrichSpansWithPending"
    )
    assert meta.get("traceroot.span.ids_path") == ids_path, (
        "traceroot.span.ids_path must be preserved in metadata for enrichSpansWithPending"
    )


def test_sdk_name_version_stripped_from_metadata():
    """traceroot.sdk.* attributes ARE stripped — they're internal bookkeeping."""
    tid = _tid(0x05)

    span = _span(
        "my-span",
        trace_id=tid,
        span_id=_sid(0x02),
        parent_span_id=_sid(0x10),
        attributes=[
            _str_attr("traceroot.sdk.name", "traceroot-py"),
            _str_attr("traceroot.sdk.version", "1.2.3"),
            _str_attr("my.custom.attr", "keep-me"),
        ],
    )

    _, spans = transform_otel_to_clickhouse(_payload(span), project_id="proj-1")

    meta = json.loads(spans[0]["metadata"])
    assert "traceroot.sdk.name" not in meta
    assert "traceroot.sdk.version" not in meta
    assert meta.get("my.custom.attr") == "keep-me"
