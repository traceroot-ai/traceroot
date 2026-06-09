"""Tests for metadata extraction in otel_transform."""

import base64
import sys
import json
from types import SimpleNamespace

from worker.otel_transform import transform_otel_to_clickhouse


def _make_trace_id() -> str:
    """Return a base64-encoded 16-byte trace ID."""
    return base64.b64encode(b"\x01" * 16).decode()


def _make_span_id(byte: int = 0x02) -> str:
    """Return a base64-encoded 8-byte span ID."""
    return base64.b64encode(bytes([byte] * 8)).decode()


def _attr(key: str, value) -> dict:
    """Build an OTEL attribute entry."""
    if isinstance(value, str):
        return {"key": key, "value": {"stringValue": value}}
    if isinstance(value, bool):
        return {"key": key, "value": {"boolValue": value}}
    if isinstance(value, int):
        return {"key": key, "value": {"intValue": str(value)}}
    if isinstance(value, float):
        return {"key": key, "value": {"doubleValue": value}}
    # Fall back to stringValue for dicts serialised as JSON
    return {
        "key": key,
        "value": {"stringValue": json.dumps(value) if not isinstance(value, str) else value},
    }


def _otel_payload(span_attributes: list[dict], *, parent_span_id: str | None = None) -> dict:
    """Build a minimal OTEL payload with one resource span containing one span."""
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


# ── Tests ──────────────────────────────────────────────────────────


def _transform_without_cost(payload: dict) -> tuple[list[dict], list[dict]]:
    fake_tokens = SimpleNamespace(calculate_cost=lambda *args, **kwargs: {"input_tokens": None, "output_tokens": None, "total_tokens": None, "cost": None})
    original = sys.modules.get("worker.tokens")
    sys.modules["worker.tokens"] = fake_tokens
    try:
        return transform_otel_to_clickhouse(payload, project_id="proj-1")
    finally:
        if original is None:
            sys.modules.pop("worker.tokens", None)
        else:
            sys.modules["worker.tokens"] = original


def test_explicit_metadata_extracted():
    """traceroot.span.metadata attribute is captured as span metadata."""
    meta = {"custom_key": "custom_value", "run_id": 42}
    payload = _otel_payload([_attr("traceroot.span.metadata", json.dumps(meta))])

    _traces, spans = _transform_without_cost(payload)

    assert len(spans) == 1
    assert "metadata" in spans[0]
    assert json.loads(spans[0]["metadata"]) == meta


def test_extra_attributes_become_metadata():
    """Custom attributes not in the known set appear as metadata."""
    payload = _otel_payload(
        [
            _attr("my.custom.attr", "hello"),
            _attr("another.thing", "world"),
        ]
    )

    _traces, spans = _transform_without_cost(payload)

    assert len(spans) == 1
    meta = json.loads(spans[0]["metadata"])
    assert meta["my.custom.attr"] == "hello"
    assert meta["another.thing"] == "world"


def test_known_attributes_excluded_from_metadata():
    """Known attributes (traceroot.span.input, gen_ai.*, etc.) do NOT leak into metadata."""
    payload = _otel_payload(
        [
            _attr("traceroot.span.input", "some input"),
            _attr("gen_ai.system", "openai"),
            _attr("llm.model_name", "gpt-4"),
            _attr("input.value", "hi"),
            _attr("openinference.span.kind", "LLM"),
            _attr("session.id", "s-1"),
            _attr("user.id", "u-1"),
            _attr("llm.input_messages.0.message.role", "user"),
            _attr("llm.input_messages.0.message.content", "hello"),
            _attr("llm.output_messages.0.message.role", "assistant"),
            _attr("llm.output_messages.0.message.content", "hi there"),
            # One unknown attribute so we can verify metadata dict exists but excludes known keys
            _attr("my.custom.flag", "yes"),
        ]
    )

    _traces, spans = _transform_without_cost(payload)

    meta = json.loads(spans[0]["metadata"])
    assert "my.custom.flag" in meta
    # None of the known keys should be present
    for key in (
        "traceroot.span.input",
        "gen_ai.system",
        "llm.model_name",
        "input.value",
        "openinference.span.kind",
        "session.id",
        "user.id",
        "llm.input_messages.0.message.role",
        "llm.input_messages.0.message.content",
        "llm.output_messages.0.message.role",
        "llm.output_messages.0.message.content",
    ):
        assert key not in meta, f"{key} should not appear in metadata"


def test_trace_metadata_extracted():
    """traceroot.trace.metadata on root span populates the trace record."""
    trace_meta = {"experiment": "v2", "dataset": "eval-100"}
    payload = _otel_payload(
        [
            _attr("traceroot.trace.metadata", json.dumps(trace_meta)),
        ]
    )

    traces, _spans = _transform_without_cost(payload)

    assert len(traces) == 1
    assert "metadata" in traces[0]
    assert json.loads(traces[0]["metadata"]) == trace_meta


def test_no_metadata_when_no_extra_attributes():
    """When only known attributes exist, metadata is not set on the span."""
    payload = _otel_payload(
        [
            _attr("traceroot.span.input", "hello"),
            _attr("traceroot.span.output", "world"),
            _attr("traceroot.span.type", "LLM"),
        ]
    )

    _traces, spans = _transform_without_cost(payload)

    assert len(spans) == 1
    assert "metadata" not in spans[0]


def test_git_repo_ref_populate_from_child_before_root():
    """Trace-level git fields should populate from child spans before the root arrives."""
    trace_id = _make_trace_id()
    root_span_id = _make_span_id(0x10)

    child = {
        "traceId": trace_id,
        "spanId": _make_span_id(0x11),
        "parentSpanId": root_span_id,
        "name": "child",
        "kind": "SPAN_KIND_INTERNAL",
        "startTimeUnixNano": "1700000000000000000",
        "endTimeUnixNano": "1700000001000000000",
        "attributes": [
            _attr("traceroot.git.repo", "owner/repo"),
            _attr("traceroot.git.ref", "main"),
        ],
        "status": {},
    }

    traces, _spans = transform_otel_to_clickhouse(
        {
            "resourceSpans": [
                {
                    "resource": {"attributes": []},
                    "scopeSpans": [{"scope": {"name": "test"}, "spans": [child]}],
                }
            ]
        },
        project_id="proj-1",
    )

    assert len(traces) == 1
    assert traces[0]["git_repo"] == "owner/repo"
    assert traces[0]["git_ref"] == "main"
