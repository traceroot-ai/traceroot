"""Tests for OTEL → ClickHouse transformer.

Covers:
- Traceroot SDK attributes (traceroot.span.input, traceroot.llm.model, etc.)
- OpenInference attributes (input.value, output.value, llm.token_count.*, etc.)
- GenAI semantic convention attributes (gen_ai.usage.*, gen_ai.request.model, etc.)
- Span kind detection from openinference.span.kind
- Fallback priority between attribute sources
"""

import base64
import json
import os
import sys

import pytest

# Add backend root to path so `worker.*` imports resolve
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from worker.transformer import transform_otel_to_clickhouse


# =============================================================================
# Helpers to build OTEL JSON payloads
# =============================================================================

def _encode_id(hex_id: str) -> str:
    """Encode a hex ID string to base64, matching OTLP wire format."""
    return base64.b64encode(bytes.fromhex(hex_id)).decode()


def _make_attr(key: str, value) -> dict:
    """Build an OTEL attribute entry."""
    if isinstance(value, str):
        return {"key": key, "value": {"stringValue": value}}
    elif isinstance(value, bool):
        return {"key": key, "value": {"boolValue": value}}
    elif isinstance(value, int):
        return {"key": key, "value": {"intValue": str(value)}}
    elif isinstance(value, float):
        return {"key": key, "value": {"doubleValue": value}}
    else:
        return {"key": key, "value": {"stringValue": str(value)}}


def _make_otel_payload(spans: list[dict]) -> dict:
    """Wrap span dicts into a full OTEL resourceSpans payload."""
    return {
        "resourceSpans": [
            {
                "resource": {"attributes": []},
                "scopeSpans": [{"scope": {"name": "test"}, "spans": spans}],
            }
        ]
    }


def _make_span(
    trace_id: str = "0" * 32,
    span_id: str = "0" * 16,
    parent_span_id: str | None = None,
    name: str = "test-span",
    attributes: list[dict] | None = None,
    kind: str = "SPAN_KIND_INTERNAL",
) -> dict:
    """Build a single OTEL span dict."""
    span = {
        "traceId": _encode_id(trace_id),
        "spanId": _encode_id(span_id),
        "name": name,
        "kind": kind,
        "startTimeUnixNano": "1700000000000000000",
        "endTimeUnixNano": "1700000001000000000",
        "attributes": attributes or [],
        "status": {"code": 0},
    }
    if parent_span_id:
        span["parentSpanId"] = _encode_id(parent_span_id)
    return span


# =============================================================================
# Tests: Traceroot SDK attributes (baseline)
# =============================================================================

class TestTracerootAttributes:
    """Verify spans with traceroot.* attributes are processed correctly."""

    def test_traceroot_input_output(self):
        """traceroot.span.input and traceroot.span.output are extracted."""
        span = _make_span(attributes=[
            _make_attr("traceroot.span.input", '{"prompt": "hello"}'),
            _make_attr("traceroot.span.output", '{"response": "world"}'),
        ])
        _, spans = transform_otel_to_clickhouse(_make_otel_payload([span]), "proj-1")

        assert len(spans) == 1
        assert spans[0]["input"] == '{"prompt": "hello"}'
        assert spans[0]["output"] == '{"response": "world"}'

    def test_traceroot_llm_model(self):
        """traceroot.llm.model sets model_name on LLM spans."""
        span = _make_span(attributes=[
            _make_attr("traceroot.span.type", "llm"),
            _make_attr("traceroot.llm.model", "gpt-4o-mini"),
            _make_attr("traceroot.span.input", "test input"),
            _make_attr("traceroot.span.output", "test output"),
        ])
        _, spans = transform_otel_to_clickhouse(_make_otel_payload([span]), "proj-1")

        assert spans[0]["model_name"] == "gpt-4o-mini"
        assert spans[0]["span_kind"] == "LLM"

    def test_traceroot_span_type_detection(self):
        """traceroot.span.type correctly sets span_kind."""
        for span_type, expected_kind in [("llm", "LLM"), ("agent", "AGENT"), ("tool", "TOOL"), ("span", "SPAN")]:
            span = _make_span(attributes=[_make_attr("traceroot.span.type", span_type)])
            _, spans = transform_otel_to_clickhouse(_make_otel_payload([span]), "proj-1")
            assert spans[0]["span_kind"] == expected_kind, f"type={span_type}"


# =============================================================================
# Tests: OpenInference attributes (from OpenAIAgentsInstrumentor etc.)
# =============================================================================

class TestOpenInferenceAttributes:
    """Verify spans with OpenInference attributes are processed correctly.

    These attributes are set by openinference-instrumentation-openai-agents,
    openinference-instrumentation-openai, and similar instrumentors.
    """

    def test_input_value_output_value(self):
        """input.value and output.value are extracted as span input/output."""
        span = _make_span(attributes=[
            _make_attr("input.value", '{"role": "user", "content": "What is AI?"}'),
            _make_attr("output.value", '{"role": "assistant", "content": "AI is..."}'),
        ])
        _, spans = transform_otel_to_clickhouse(_make_otel_payload([span]), "proj-1")

        assert spans[0]["input"] == '{"role": "user", "content": "What is AI?"}'
        assert spans[0]["output"] == '{"role": "assistant", "content": "AI is..."}'

    def test_traceroot_attrs_take_priority_over_openinference(self):
        """traceroot.span.input takes priority over input.value."""
        span = _make_span(attributes=[
            _make_attr("traceroot.span.input", "traceroot input"),
            _make_attr("input.value", "openinference input"),
            _make_attr("traceroot.span.output", "traceroot output"),
            _make_attr("output.value", "openinference output"),
        ])
        _, spans = transform_otel_to_clickhouse(_make_otel_payload([span]), "proj-1")

        assert spans[0]["input"] == "traceroot input"
        assert spans[0]["output"] == "traceroot output"

    def test_openinference_span_kind(self):
        """openinference.span.kind maps to correct span_kind."""
        for oi_kind, expected in [("LLM", "LLM"), ("AGENT", "AGENT"), ("TOOL", "TOOL"), ("CHAIN", "SPAN")]:
            span = _make_span(attributes=[_make_attr("openinference.span.kind", oi_kind)])
            _, spans = transform_otel_to_clickhouse(_make_otel_payload([span]), "proj-1")
            assert spans[0]["span_kind"] == expected, f"openinference.span.kind={oi_kind}"

    def test_llm_token_count_attributes(self):
        """llm.token_count.* attributes provide accurate token usage."""
        span = _make_span(attributes=[
            _make_attr("openinference.span.kind", "LLM"),
            _make_attr("llm.model_name", "gpt-4o-mini"),
            _make_attr("llm.token_count.prompt", 150),
            _make_attr("llm.token_count.completion", 200),
            _make_attr("llm.token_count.total", 350),
            _make_attr("input.value", "some input"),
            _make_attr("output.value", "some output"),
        ])
        _, spans = transform_otel_to_clickhouse(_make_otel_payload([span]), "proj-1")

        assert spans[0]["input_tokens"] == 150
        assert spans[0]["output_tokens"] == 200
        assert spans[0]["total_tokens"] == 350

    def test_token_counts_preferred_over_text_estimation(self):
        """API token counts should be used instead of tiktoken estimation."""
        span = _make_span(attributes=[
            _make_attr("openinference.span.kind", "LLM"),
            _make_attr("llm.model_name", "gpt-4o-mini"),
            _make_attr("llm.token_count.prompt", 42),
            _make_attr("llm.token_count.completion", 73),
            # input.value text would yield different token count if estimated
            _make_attr("input.value", "a " * 500),
            _make_attr("output.value", "b " * 500),
        ])
        _, spans = transform_otel_to_clickhouse(_make_otel_payload([span]), "proj-1")

        # Should use API counts (42, 73), NOT text estimation
        assert spans[0]["input_tokens"] == 42
        assert spans[0]["output_tokens"] == 73
        assert spans[0]["total_tokens"] == 42 + 73

    def test_cost_calculated_from_api_token_counts(self):
        """Cost should be calculated from API-provided token counts."""
        span = _make_span(attributes=[
            _make_attr("openinference.span.kind", "LLM"),
            _make_attr("llm.model_name", "gpt-4o-mini"),
            _make_attr("llm.token_count.prompt", 1000000),  # 1M input tokens
            _make_attr("llm.token_count.completion", 1000000),  # 1M output tokens
        ])
        _, spans = transform_otel_to_clickhouse(_make_otel_payload([span]), "proj-1")

        # gpt-4o-mini: $0.15/1M input, $0.60/1M output
        assert spans[0]["cost"] == pytest.approx(0.15 + 0.60, abs=0.001)

    def test_llm_model_name_fallback(self):
        """llm.model_name is used when traceroot.llm.model is not set."""
        span = _make_span(attributes=[
            _make_attr("openinference.span.kind", "LLM"),
            _make_attr("llm.model_name", "gpt-4o"),
            _make_attr("input.value", "hello"),
        ])
        _, spans = transform_otel_to_clickhouse(_make_otel_payload([span]), "proj-1")

        assert spans[0]["model_name"] == "gpt-4o"

    def test_agent_span_with_model_and_tokens(self):
        """AGENT spans with model/token attrs should still extract tokens.

        OpenAIAgentsInstrumentor sets openinference.span.kind=AGENT on
        ResponseSpanData, but these spans carry llm.model_name and
        llm.token_count.* from the API response. The transformer must
        NOT gate token extraction on span_kind == "LLM".
        """
        span = _make_span(
            name="Optimist",
            attributes=[
                _make_attr("openinference.span.kind", "AGENT"),  # NOT "LLM"
                _make_attr("llm.model_name", "gpt-4o-mini"),
                _make_attr("llm.token_count.prompt", 100),
                _make_attr("llm.token_count.completion", 80),
                _make_attr("llm.token_count.total", 180),
                _make_attr("input.value", "Give your perspective"),
                _make_attr("output.value", "AI is great..."),
            ],
        )
        _, spans = transform_otel_to_clickhouse(_make_otel_payload([span]), "proj-1")

        s = spans[0]
        assert s["span_kind"] == "AGENT"
        assert s["model_name"] == "gpt-4o-mini"
        assert s["input_tokens"] == 100
        assert s["output_tokens"] == 80
        assert s["total_tokens"] == 180
        assert s["cost"] is not None and s["cost"] > 0
        assert s["input"] == "Give your perspective"
        assert s["output"] == "AI is great..."

    def test_chain_span_with_model_and_tokens(self):
        """CHAIN/SPAN kind spans with model attrs should also extract tokens."""
        span = _make_span(attributes=[
            _make_attr("openinference.span.kind", "CHAIN"),
            _make_attr("llm.model_name", "gpt-4o"),
            _make_attr("llm.token_count.prompt", 50),
            _make_attr("llm.token_count.completion", 60),
        ])
        _, spans = transform_otel_to_clickhouse(_make_otel_payload([span]), "proj-1")

        assert spans[0]["span_kind"] == "SPAN"
        assert spans[0]["model_name"] == "gpt-4o"
        assert spans[0]["input_tokens"] == 50
        assert spans[0]["output_tokens"] == 60

    def test_full_openinference_llm_span(self):
        """Full OpenInference LLM span with all attributes."""
        span = _make_span(
            name="Optimist",
            attributes=[
                _make_attr("openinference.span.kind", "LLM"),
                _make_attr("llm.model_name", "gpt-4o-mini"),
                _make_attr("llm.token_count.prompt", 85),
                _make_attr("llm.token_count.completion", 120),
                _make_attr("llm.token_count.total", 205),
                _make_attr("input.value", json.dumps([{"role": "user", "content": "Give your perspective on AI"}])),
                _make_attr("output.value", json.dumps({"role": "assistant", "content": "AI is transformative..."})),
            ],
        )
        _, spans = transform_otel_to_clickhouse(_make_otel_payload([span]), "proj-1")

        s = spans[0]
        assert s["name"] == "Optimist"
        assert s["span_kind"] == "LLM"
        assert s["model_name"] == "gpt-4o-mini"
        assert s["input_tokens"] == 85
        assert s["output_tokens"] == 120
        assert s["total_tokens"] == 205
        assert s["cost"] is not None and s["cost"] > 0
        assert "AI" in s["input"]
        assert "transformative" in s["output"]


# =============================================================================
# Tests: GenAI semantic convention attributes
# =============================================================================

class TestGenAIAttributes:
    """Verify spans with gen_ai.* attributes work correctly."""

    def test_gen_ai_request_model(self):
        """gen_ai.request.model is used as model_name fallback."""
        span = _make_span(attributes=[
            _make_attr("openinference.span.kind", "LLM"),
            _make_attr("gen_ai.request.model", "gpt-4o"),
            _make_attr("input.value", "test"),
        ])
        _, spans = transform_otel_to_clickhouse(_make_otel_payload([span]), "proj-1")

        assert spans[0]["model_name"] == "gpt-4o"

    def test_gen_ai_usage_token_counts(self):
        """gen_ai.usage.* attributes provide token counts."""
        span = _make_span(attributes=[
            _make_attr("openinference.span.kind", "LLM"),
            _make_attr("llm.model_name", "gpt-4o-mini"),
            _make_attr("gen_ai.usage.input_tokens", 100),
            _make_attr("gen_ai.usage.output_tokens", 50),
        ])
        _, spans = transform_otel_to_clickhouse(_make_otel_payload([span]), "proj-1")

        assert spans[0]["input_tokens"] == 100
        assert spans[0]["output_tokens"] == 50
        assert spans[0]["total_tokens"] == 150

    def test_gen_ai_usage_prompt_completion_tokens(self):
        """gen_ai.usage.prompt_tokens / completion_tokens also work."""
        span = _make_span(attributes=[
            _make_attr("openinference.span.kind", "LLM"),
            _make_attr("llm.model_name", "gpt-4o-mini"),
            _make_attr("gen_ai.usage.prompt_tokens", 200),
            _make_attr("gen_ai.usage.completion_tokens", 300),
            _make_attr("gen_ai.usage.total_tokens", 500),
        ])
        _, spans = transform_otel_to_clickhouse(_make_otel_payload([span]), "proj-1")

        assert spans[0]["input_tokens"] == 200
        assert spans[0]["output_tokens"] == 300
        assert spans[0]["total_tokens"] == 500


# =============================================================================
# Tests: Fallback to text estimation when no API token counts
# =============================================================================

class TestTextEstimationFallback:
    """Verify text-based token estimation works when API counts aren't available."""

    def test_falls_back_to_text_estimation(self):
        """Without API token counts, tokens are estimated from input/output text."""
        span = _make_span(attributes=[
            _make_attr("traceroot.span.type", "llm"),
            _make_attr("traceroot.llm.model", "gpt-4o-mini"),
            _make_attr("traceroot.span.input", "Hello, how are you?"),
            _make_attr("traceroot.span.output", "I am doing well, thank you!"),
        ])
        _, spans = transform_otel_to_clickhouse(_make_otel_payload([span]), "proj-1")

        # Should have non-zero tokens from text estimation
        assert spans[0]["input_tokens"] > 0
        assert spans[0]["output_tokens"] > 0

    def test_no_input_output_yields_zero_tokens_on_fallback(self):
        """With no input/output and no API counts, tokens should be zero."""
        span = _make_span(attributes=[
            _make_attr("traceroot.span.type", "llm"),
            _make_attr("traceroot.llm.model", "gpt-4o-mini"),
        ])
        _, spans = transform_otel_to_clickhouse(_make_otel_payload([span]), "proj-1")

        assert spans[0]["input_tokens"] == 0
        assert spans[0]["output_tokens"] == 0


# =============================================================================
# Tests: Trace-level input/output from root span
# =============================================================================

class TestTraceInputOutput:
    """Verify trace-level records get input/output from root span."""

    def test_root_span_openinference_input_output_propagates_to_trace(self):
        """input.value/output.value on root span should set trace input/output."""
        root_span = _make_span(
            trace_id="a" * 32,
            span_id="1" * 16,
            name="my-trace",
            attributes=[
                _make_attr("input.value", "trace input text"),
                _make_attr("output.value", "trace output text"),
            ],
        )
        traces, _ = transform_otel_to_clickhouse(_make_otel_payload([root_span]), "proj-1")

        assert len(traces) == 1
        assert traces[0]["input"] == "trace input text"
        assert traces[0]["output"] == "trace output text"
