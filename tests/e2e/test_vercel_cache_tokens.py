"""E2E: Vercel AI SDK cache-token recognition + the LLM-kind gross gate.

Vercel's SDK exposes cache/reasoning detail only under its raw ``ai.usage.*``
namespace, which OpenInference never normalizes. The fix reads those keys as
lowest-priority fallbacks so the cache breakdown persists, and — critically —
only trusts the gross ``ai.usage`` totals on LLM-kind spans, since the same totals
also sit on the ``ai.generateText`` AGENT wrapper where they merely restate the
sum of the wrapper's LLM children (double-count if counted twice).

Span shape taken from an observed production span: 3 uncached + 22041 cache-read
+ 6422 cache-write = 28466 gross input.
"""

from __future__ import annotations

import pytest

from tests.e2e.harness import (
    expected_cost,
    model_prices,
    now_nanos,
    rand_span_id,
    rand_trace_id,
    usage,
)
from tests.fixtures.otel_payloads import make_attr, make_otel_payload, make_span

MODEL = "claude-sonnet-4-6"  # present in standard-model-prices.json with cache rates

# (3 uncached) + 22041 read + 6422 write = 28466 gross
GROSS_INPUT = 28466
CACHE_READ = 22041
CACHE_WRITE = 6422
OUTPUT = 411


def _has_tokens(span: dict) -> bool:
    return span.get("input_tokens") is not None


def test_llm_span_persists_vercel_cache_breakdown(client):
    """An LLM ``doGenerate`` span keeps its full read/write cache split + cost."""
    trace_id = rand_trace_id()
    span_id = rand_span_id()
    start = now_nanos()

    span = make_span(
        trace_id_hex=trace_id,
        span_id_hex=span_id,
        name="ai.generateText.doGenerate",
        start_nanos=start,
        end_nanos=start + 1_000_000_000,
        attributes=[
            make_attr("traceroot.span.type", "LLM"),
            make_attr("gen_ai.request.model", MODEL),
            make_attr("ai.usage.inputTokens", GROSS_INPUT),
            make_attr("ai.usage.inputTokenDetails.cacheReadTokens", CACHE_READ),
            make_attr("ai.usage.inputTokenDetails.cacheWriteTokens", CACHE_WRITE),
            make_attr("ai.usage.outputTokens", OUTPUT),
        ],
    )
    client.emit(make_otel_payload([span], scope_name="ai"))

    got = client.poll_span(trace_id, span_id, _has_tokens, timeout=60.0)
    assert got is not None, "span never ingested"

    u = usage(got)
    assert u["cache_read_tokens"] == CACHE_READ
    assert u["cache_write_tokens"] == CACHE_WRITE
    # Stored input is GROSS, reconstructed from the disjoint buckets.
    assert got["input_tokens"] == GROSS_INPUT
    assert got["output_tokens"] == OUTPUT

    prices = model_prices(MODEL)
    assert prices is not None, f"{MODEL} missing from price catalog"
    want = expected_cost(
        prices,
        input_uncached=GROSS_INPUT - CACHE_READ - CACHE_WRITE,
        cache_read=CACHE_READ,
        cache_write=CACHE_WRITE,
        output=OUTPUT,
    )
    assert got["cost"] == pytest.approx(want, rel=1e-3)

    # The whole point of the cache split: it must be cheaper than pricing the
    # entire input at the uncached rate.
    all_uncached = expected_cost(
        prices, input_uncached=GROSS_INPUT, cache_read=0, cache_write=0, output=OUTPUT
    )
    assert got["cost"] < all_uncached


def test_gross_totals_gated_to_llm_spans_no_double_count(client):
    """The AGENT wrapper carrying the same ``ai.usage.*`` totals must NOT be priced.

    Emits the real two-span shape — an ``ai.generateText`` AGENT wrapper (root) and
    its ``ai.generateText.doGenerate`` LLM child, both carrying the identical gross
    totals. Only the LLM child should be counted; the wrapper restates the child's
    usage and counting it too would double the trace.
    """
    trace_id = rand_trace_id()
    wrapper_id = rand_span_id()
    child_id = rand_span_id()
    start = now_nanos()

    ai_usage_attrs = [
        make_attr("gen_ai.request.model", MODEL),
        make_attr("ai.usage.inputTokens", GROSS_INPUT),
        make_attr("ai.usage.inputTokenDetails.cacheReadTokens", CACHE_READ),
        make_attr("ai.usage.inputTokenDetails.cacheWriteTokens", CACHE_WRITE),
        make_attr("ai.usage.outputTokens", OUTPUT),
    ]
    wrapper = make_span(
        trace_id_hex=trace_id,
        span_id_hex=wrapper_id,
        name="ai.generateText",
        start_nanos=start,
        end_nanos=start + 2_000_000_000,
        attributes=[make_attr("traceroot.span.type", "AGENT"), *ai_usage_attrs],
    )
    child = make_span(
        trace_id_hex=trace_id,
        span_id_hex=child_id,
        parent_span_id_hex=wrapper_id,
        name="ai.generateText.doGenerate",
        start_nanos=start + 100_000_000,
        end_nanos=start + 1_900_000_000,
        attributes=[make_attr("traceroot.span.type", "LLM"), *ai_usage_attrs],
    )
    client.emit(make_otel_payload([wrapper, child], scope_name="ai"))

    got_child = client.poll_span(trace_id, child_id, _has_tokens, timeout=60.0)
    assert got_child is not None, "LLM child never ingested"
    assert got_child["input_tokens"] == GROSS_INPUT

    got_wrapper = client.get_span(trace_id, wrapper_id)
    assert got_wrapper is not None, "wrapper span missing"
    # Gated out: ai.usage gross totals are ignored off the LLM span, and text
    # estimation is LLM-only, so the wrapper carries no token counts at all.
    assert not got_wrapper.get("input_tokens"), got_wrapper.get("input_tokens")
    assert not got_wrapper.get("cost"), got_wrapper.get("cost")


@pytest.mark.parametrize(
    "label,extra_attrs,want_read,want_write",
    [
        (
            "v6_full_split",
            [
                make_attr("ai.usage.inputTokenDetails.cacheReadTokens", CACHE_READ),
                make_attr("ai.usage.inputTokenDetails.cacheWriteTokens", CACHE_WRITE),
            ],
            CACHE_READ,
            CACHE_WRITE,
        ),
        (
            "v5_cache_read_only",
            [make_attr("ai.usage.cachedInputTokens", CACHE_READ)],
            CACHE_READ,
            0,
        ),
        ("v4_totals_only", [], 0, 0),
    ],
)
def test_sdk_version_cache_degradation(client, label, extra_attrs, want_read, want_write):
    """The fix degrades gracefully across SDK majors (v4 totals → v6 full split)."""
    trace_id = rand_trace_id()
    span_id = rand_span_id()
    start = now_nanos()

    span = make_span(
        trace_id_hex=trace_id,
        span_id_hex=span_id,
        name=f"ai.generateText.doGenerate[{label}]",
        start_nanos=start,
        end_nanos=start + 1_000_000_000,
        attributes=[
            make_attr("traceroot.span.type", "LLM"),
            make_attr("gen_ai.request.model", MODEL),
            make_attr("ai.usage.inputTokens", GROSS_INPUT),
            make_attr("ai.usage.outputTokens", OUTPUT),
            *extra_attrs,
        ],
    )
    client.emit(make_otel_payload([span], scope_name="ai"))

    got = client.poll_span(trace_id, span_id, _has_tokens, timeout=60.0)
    assert got is not None, f"[{label}] span never ingested"
    u = usage(got)
    assert u["cache_read_tokens"] == want_read, label
    assert u["cache_write_tokens"] == want_write, label
    assert got["input_tokens"] == GROSS_INPUT, label
