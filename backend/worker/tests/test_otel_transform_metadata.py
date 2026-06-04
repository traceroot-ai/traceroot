"""Tests for metadata extraction in otel_transform."""

import base64
import json

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


def test_explicit_metadata_extracted():
    """traceroot.span.metadata attribute is captured as span metadata."""
    meta = {"custom_key": "custom_value", "run_id": 42}
    payload = _otel_payload([_attr("traceroot.span.metadata", json.dumps(meta))])

    _traces, spans = transform_otel_to_clickhouse(payload, project_id="proj-1")

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

    _traces, spans = transform_otel_to_clickhouse(payload, project_id="proj-1")

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

    _traces, spans = transform_otel_to_clickhouse(payload, project_id="proj-1")

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

    traces, _spans = transform_otel_to_clickhouse(payload, project_id="proj-1")

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

    _traces, spans = transform_otel_to_clickhouse(payload, project_id="proj-1")

    assert len(spans) == 1
    assert "metadata" not in spans[0]


def test_cache_and_reasoning_tokens_persisted_as_columns():
    """Cache + reasoning token counts land in dedicated span columns, not metadata."""
    payload = _otel_payload(
        [
            _attr("llm.model_name", "claude-3-5-sonnet-20241022"),
            _attr("gen_ai.usage.input_tokens", 1000),
            _attr("gen_ai.usage.output_tokens", 200),
            _attr("gen_ai.usage.cache_read_input_tokens", 800),
            _attr("gen_ai.usage.cache_creation_input_tokens", 50),
            _attr("gen_ai.usage.reasoning_tokens", 120),
        ]
    )

    _traces, spans = transform_otel_to_clickhouse(payload, project_id="proj-1")

    assert len(spans) == 1
    span = spans[0]
    # Gross token columns are unchanged (display continuity).
    assert span["input_tokens"] == 1000
    assert span["output_tokens"] == 200
    # New first-class breakdown columns.
    assert span["cache_read_tokens"] == 800
    assert span["cache_write_tokens"] == 50
    assert span["reasoning_tokens"] == 120
    # The breakdown must NOT be duplicated into metadata.
    meta = json.loads(span["metadata"]) if span.get("metadata") else {}
    assert "gen_ai.usage.details.cache_read_tokens" not in meta
    assert "gen_ai.usage.details.cache_write_tokens" not in meta


def test_openinference_reasoning_key_persisted():
    """The first-priority OpenInference reasoning key populates reasoning_tokens."""
    payload = _otel_payload(
        [
            _attr("llm.model_name", "o1-2024-12-17"),
            _attr("gen_ai.usage.input_tokens", 500),
            _attr("gen_ai.usage.output_tokens", 300),
            # OpenInference completion-details key (leads the reasoning alias list).
            _attr("llm.token_count.completion_details.reasoning", 220),
        ]
    )

    _traces, spans = transform_otel_to_clickhouse(payload, project_id="proj-1")

    assert spans[0]["reasoning_tokens"] == 220


def test_reasoning_tokens_do_not_change_cost():
    """Reasoning is a subset of output, already priced at the output rate, so it
    must be display-only — the cost must be identical with and without it."""
    base_attrs = [
        _attr("llm.model_name", "claude-3-5-sonnet-20241022"),
        _attr("gen_ai.usage.input_tokens", 1000),
        _attr("gen_ai.usage.output_tokens", 200),
        _attr("gen_ai.usage.cache_read_input_tokens", 800),
        _attr("gen_ai.usage.cache_creation_input_tokens", 50),
    ]

    _t1, spans_without = transform_otel_to_clickhouse(
        _otel_payload(base_attrs), project_id="proj-1"
    )
    _t2, spans_with = transform_otel_to_clickhouse(
        _otel_payload(base_attrs + [_attr("gen_ai.usage.reasoning_tokens", 120)]),
        project_id="proj-1",
    )

    # Reasoning is recorded for display...
    assert spans_with[0]["reasoning_tokens"] == 120
    # ...but does not perturb the cost vs. the same span without reasoning.
    # (.get so the assertion holds whether or not pricing data is available —
    # both sides are equal either way; what matters is reasoning can't change it.)
    assert spans_with[0].get("cost") == spans_without[0].get("cost")


def test_cache_columns_are_stored_uncapped():
    """Cache is an additive bucket stored uncapped — even when it exceeds the
    reported input. Net/exclusive emitters (e.g. claude-agent-sdk) report a small
    input with large additive cache; the uncached input just floors to zero."""
    payload = _otel_payload(
        [
            _attr("llm.model_name", "claude-3-5-sonnet-20241022"),
            _attr("gen_ai.usage.input_tokens", 1000),
            _attr("gen_ai.usage.output_tokens", 200),
            _attr("gen_ai.usage.cache_read_input_tokens", 900),
            _attr("gen_ai.usage.cache_creation_input_tokens", 300),
        ]
    )
    _t, spans = transform_otel_to_clickhouse(payload, project_id="proj-1")
    s = spans[0]
    # Stored uncapped: the columns reflect exactly what the emitter reported.
    assert s["cache_read_tokens"] == 900
    assert s["cache_write_tokens"] == 300


def test_net_emitter_input_stored_as_reconstructed_gross():
    """A net/exclusive emitter (e.g. claude-agent-sdk) reports only the non-cached
    tokens in prompt, with cache as separate additive buckets — so the reported
    input alone (2) understates the true total. The stored input_tokens is the
    GROSS reconstructed from the disjoint buckets, so it reconciles with the cache
    breakdown (cache_read + cache_write + uncached) instead of looking tiny next to
    a large cache."""
    payload = _otel_payload(
        [
            _attr("llm.model_name", "claude-haiku-4-5-20251001"),
            _attr("llm.token_count.prompt", 2),  # exclusive / net input
            _attr("llm.token_count.completion", 2342),
            _attr("llm.token_count.prompt_details.cache_read", 29956),
            _attr("llm.token_count.prompt_details.cache_write", 2560),
        ]
    )
    _t, spans = transform_otel_to_clickhouse(payload, project_id="proj-1")
    s = spans[0]
    assert s["cache_read_tokens"] == 29956
    assert s["cache_write_tokens"] == 2560
    # input is the reconstructed gross (was understated at 2), reconciling with cache.
    assert s["input_tokens"] == 29956 + 2560
    assert s["total_tokens"] == s["input_tokens"] + 2342


def test_reasoning_capped_to_output():
    """Reasoning is a subset of output; a larger reported value is capped."""
    payload = _otel_payload(
        [
            _attr("llm.model_name", "o1-2024-12-17"),
            _attr("gen_ai.usage.input_tokens", 100),
            _attr("gen_ai.usage.output_tokens", 200),
            _attr("gen_ai.usage.reasoning_tokens", 500),
        ]
    )
    _t, spans = transform_otel_to_clickhouse(payload, project_id="proj-1")
    assert spans[0]["reasoning_tokens"] == 200


def test_cache_detail_key_without_model_is_not_persisted():
    """Cache columns require a priced LLM span; an orphan cache attr on a span
    with no model produces no cache columns (documented contract)."""
    payload = _otel_payload([_attr("gen_ai.usage.details.cache_read_tokens", 128)])
    _t, spans = transform_otel_to_clickhouse(payload, project_id="proj-1")
    assert spans[0].get("cache_read_tokens") is None
