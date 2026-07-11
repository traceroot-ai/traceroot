"""Tests for trace naming logic in otel_transform.

Covers the corner cases introduced during live-trace-streaming work:
  - Eager trace name should use traceroot.span.path[0], not the span's own name
  - When a batch has spans at multiple depths, the shallowest span's path[0] wins
  - traceroot.span.path / traceroot.span.ids_path must be extracted to dedicated columns
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


def test_span_path_extracted_to_dedicated_columns():
    """After fix: traceroot.span.path/ids_path go to dedicated fields, not metadata.

    enrichSpansWithPending reads from dedicated fields with metadata fallback for
    backward compatibility, so the fields must be accessible via span_record columns.
    """
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
    # Core assertion: path attrs must be in dedicated fields
    assert spans[0]["path"] == path[:-1], (
        f"traceroot.span.path must be in dedicated 'path' field, got {spans[0].get('path')}"
    )
    assert spans[0]["ids_path"] == ids_path, (
        f"traceroot.span.ids_path must be in dedicated 'ids_path' field, got {spans[0].get('ids_path')}"
    )
    # Verify they don't leak into metadata
    if "metadata" in spans[0]:
        meta = json.loads(spans[0]["metadata"])
        assert "traceroot.span.path" not in meta, (
            "path must not be in metadata (now in dedicated field)"
        )
        assert "traceroot.span.ids_path" not in meta, (
            "ids_path must not be in metadata (now in dedicated field)"
        )


def test_sdk_name_version_preserved_in_metadata():
    """traceroot.sdk.* attributes are preserved in metadata for visibility."""
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
    assert meta.get("traceroot.sdk.name") == "traceroot-py"
    assert meta.get("traceroot.sdk.version") == "1.2.3"
    assert meta.get("my.custom.attr") == "keep-me"


# ── Issue #1498: Dedicated path/ids_path columns (not dropped when metadata present) ──


def test_ids_path_extracted_to_dedicated_field_with_explicit_metadata():
    """Regression: ids_path/path MUST be extracted even when explicit metadata is set.

    Before fix: explicit traceroot.span.metadata caused path attrs to be skipped (only
    in fallback branch). After fix: path attrs go to dedicated fields unconditionally,
    so they're never lost. Core regression test for issue #1498.
    """
    tid = _tid(0x06)
    path = ["research", "model_call", "ChatAnthropic"]
    ids_path = ["aabbccdd11223344", "aabbccdd11223345"]
    user_metadata = {"session_id": "user-session-123", "retry_count": 2}

    child = _span(
        "ChatAnthropic",
        trace_id=tid,
        span_id=_sid(0x02),
        parent_span_id=_sid(0x10),
        attributes=[
            _arr_attr("traceroot.span.path", path),
            _arr_attr("traceroot.span.ids_path", ids_path),
            # Explicit user metadata: this used to suppress path attr extraction.
            # Serialized from `user_metadata` so the fixture and the assertions
            # below can never drift apart.
            {
                "key": "traceroot.span.metadata",
                "value": {"stringValue": json.dumps(user_metadata)},
            },
        ],
    )

    _, spans = transform_otel_to_clickhouse(_payload(child), project_id="proj-1")

    assert len(spans) == 1
    span_record = spans[0]

    # Core assertion: ids_path/path MUST be in dedicated fields
    assert span_record["ids_path"] == ids_path, (
        f"ids_path must be extracted to dedicated field, got {span_record.get('ids_path')}"
    )
    assert span_record["path"] == path[:-1], (
        f"path must be extracted to dedicated field, got {span_record.get('path')}"
    )

    # Verify user metadata is intact and path attrs are NOT leaked into it
    assert "metadata" in span_record, "span should have metadata field"
    meta = json.loads(span_record["metadata"])
    assert meta.get("session_id") == user_metadata["session_id"], (
        "user-provided session_id should be in metadata"
    )
    assert meta.get("retry_count") == user_metadata["retry_count"], (
        "user-provided retry_count should be in metadata"
    )
    assert "traceroot.span.path" not in meta, (
        "traceroot.span.path must NOT leak into metadata (now in dedicated column)"
    )
    assert "traceroot.span.ids_path" not in meta, (
        "traceroot.span.ids_path must NOT leak into metadata (now in dedicated column)"
    )


def test_ids_path_extracted_without_explicit_metadata():
    """Regression guard: path attrs extraction must work when NO explicit metadata.

    Before fix, this case already worked (via the fallback branch after metadata).
    After fix, the unconditional extraction code path must not break this case.
    """
    tid = _tid(0x07)
    path = ["agent_session", "tool_call", "search"]
    ids_path = ["deadbeef00000001", "deadbeef00000002"]
    other_attr = "some_custom_value"

    child = _span(
        "search",
        trace_id=tid,
        span_id=_sid(0x03),
        parent_span_id=_sid(0x10),
        attributes=[
            _arr_attr("traceroot.span.path", path),
            _arr_attr("traceroot.span.ids_path", ids_path),
            # No explicit traceroot.span.metadata; only custom attrs
            _str_attr("my.custom.attr", other_attr),
        ],
    )

    _, spans = transform_otel_to_clickhouse(_payload(child), project_id="proj-1")

    assert len(spans) == 1
    span_record = spans[0]

    # Path attrs must still reach dedicated fields
    assert span_record["ids_path"] == ids_path, (
        f"ids_path must be extracted to dedicated field, got {span_record.get('ids_path')}"
    )
    assert span_record["path"] == path[:-1], (
        f"path must be extracted to dedicated field, got {span_record.get('path')}"
    )

    # Custom attrs should be in metadata (they're not known attributes)
    if "metadata" in span_record:
        meta = json.loads(span_record["metadata"])
        assert meta.get("my.custom.attr") == other_attr, (
            "custom attributes should be preserved in metadata"
        )


def test_ids_path_and_path_capped_at_max_depth():
    """Regression: an oversized ids_path/path must be truncated, not stored whole.

    Security hardening for #1498: a malformed or adversarial OTel payload
    shouldn't be able to force an unbounded array into ClickHouse or balloon
    worker memory during the transform. See MAX_SPAN_PATH_DEPTH.
    """
    from worker.otel_transform import MAX_SPAN_PATH_DEPTH

    tid = _tid(0x08)
    oversized_path = [f"frame-{i}" for i in range(MAX_SPAN_PATH_DEPTH + 51)]
    oversized_ids_path = [f"id-{i}" for i in range(MAX_SPAN_PATH_DEPTH + 50)]

    child = _span(
        "deep_leaf",
        trace_id=tid,
        span_id=_sid(0x04),
        parent_span_id=_sid(0x11),
        attributes=[
            _arr_attr("traceroot.span.path", oversized_path),
            _arr_attr("traceroot.span.ids_path", oversized_ids_path),
        ],
    )

    _, spans = transform_otel_to_clickhouse(_payload(child), project_id="proj-1")

    assert len(spans) == 1
    span_record = spans[0]
    assert len(span_record["path"]) == MAX_SPAN_PATH_DEPTH
    assert len(span_record["ids_path"]) == MAX_SPAN_PATH_DEPTH
    # Truncation drops the root-most prefix from both arrays, preserving the
    # immediate-parent side that live tree repair needs while keeping indexes aligned.
    assert span_record["path"] == oversized_path[-(MAX_SPAN_PATH_DEPTH + 1) : -1]
    assert span_record["ids_path"] == oversized_ids_path[-MAX_SPAN_PATH_DEPTH:]
