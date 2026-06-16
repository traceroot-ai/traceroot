"""E2E: text-based token estimation is LLM-kind only.

When an instrumentor reports no API token counts, the worker may estimate tokens
from the span's input/output text — but only for LLM (completion) spans. Wrapper
AGENT/CHAIN spans restate text their LLM children already account for, so
estimating them double-counts the trace. The ``traceroot.claude-agent-sdk`` scope
additionally leaves even its LLM spans deliberately unset and must be skipped.
"""

from __future__ import annotations

from tests.e2e.harness import now_nanos, rand_span_id, rand_trace_id
from tests.fixtures.otel_payloads import make_attr, make_otel_payload, make_span

MODEL = "claude-sonnet-4-6"
INPUT_TEXT = "Summarize the quarterly results and highlight the three biggest risks."
OUTPUT_TEXT = "Revenue grew 12%. Risks: supply chain, FX exposure, and key-customer concentration."


def _exists(span: dict) -> bool:
    return span is not None


def test_llm_span_estimates_tokens_from_text(client):
    """An LLM span with text but no API token counts gets estimated tokens."""
    trace_id = rand_trace_id()
    span_id = rand_span_id()
    start = now_nanos()

    span = make_span(
        trace_id_hex=trace_id,
        span_id_hex=span_id,
        name="llm.chat",
        start_nanos=start,
        end_nanos=start + 1_000_000_000,
        attributes=[
            make_attr("traceroot.span.type", "LLM"),
            make_attr("traceroot.llm.model", MODEL),
            make_attr("traceroot.span.input", INPUT_TEXT),
            make_attr("traceroot.span.output", OUTPUT_TEXT),
        ],
    )
    client.emit(make_otel_payload([span], scope_name="openinference.instrumentation.test"))

    got = client.poll_span(
        trace_id, span_id, lambda s: s.get("input_tokens") is not None, timeout=60.0
    )
    assert got is not None, "LLM span never ingested with estimated tokens"
    assert got["input_tokens"] > 0
    assert got["output_tokens"] > 0
    assert got["cost"] is not None and got["cost"] > 0


def test_non_llm_span_skips_estimation(client):
    """An AGENT span with a model + text but no token counts gets NO estimate."""
    trace_id = rand_trace_id()
    span_id = rand_span_id()
    start = now_nanos()

    span = make_span(
        trace_id_hex=trace_id,
        span_id_hex=span_id,
        name="agent.run",
        start_nanos=start,
        end_nanos=start + 1_000_000_000,
        attributes=[
            make_attr("traceroot.span.type", "AGENT"),
            make_attr("traceroot.llm.model", MODEL),
            make_attr("traceroot.span.input", INPUT_TEXT),
            make_attr("traceroot.span.output", OUTPUT_TEXT),
        ],
    )
    client.emit(make_otel_payload([span], scope_name="openinference.instrumentation.test"))

    # Wait for the span row to exist (transform computes tokens before insert,
    # so once present the decision is final), then assert it was left unset.
    got = client.poll_span(trace_id, span_id, _exists, timeout=60.0)
    assert got is not None, "AGENT span never ingested"
    assert got["span_kind"] == "AGENT"
    assert not got.get("input_tokens"), got.get("input_tokens")
    assert not got.get("output_tokens"), got.get("output_tokens")


def test_claude_agent_sdk_scope_skips_estimation(client):
    """An LLM span from the claude-agent-sdk scope is intentionally left unset."""
    trace_id = rand_trace_id()
    span_id = rand_span_id()
    start = now_nanos()

    span = make_span(
        trace_id_hex=trace_id,
        span_id_hex=span_id,
        name="llm.chat",
        start_nanos=start,
        end_nanos=start + 1_000_000_000,
        attributes=[
            make_attr("traceroot.span.type", "LLM"),
            make_attr("traceroot.llm.model", MODEL),
            make_attr("traceroot.span.input", INPUT_TEXT),
            make_attr("traceroot.span.output", OUTPUT_TEXT),
        ],
    )
    client.emit(make_otel_payload([span], scope_name="traceroot.claude-agent-sdk"))

    got = client.poll_span(trace_id, span_id, _exists, timeout=60.0)
    assert got is not None, "claude-agent-sdk span never ingested"
    assert got["span_kind"] == "LLM"
    assert not got.get("input_tokens"), got.get("input_tokens")
