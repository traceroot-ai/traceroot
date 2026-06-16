"""E2E for the token-bucket clamping / NET-emitter path (backend/worker/tokens/buckets.py).

``normalize_token_usage`` derives the uncached bucket as
``max(input - cache_read - cache_write, 0)`` and keeps cache uncapped. For a NET
(cache-exclusive) emitter — e.g. claude-agent-sdk passes Anthropic's exclusive
``input_tokens`` straight through with cache as separate additive buckets — the cache
*exceeds* the reported input, so the uncached bucket must floor to 0 while the
additive cache is still priced in full. The stored GROSS input then reconstructs to
``cache_read + cache_write`` rather than going negative or collapsing to the small
reported value.

No live provider we ingest reports NET usage with cache > input, so this path is only
reachable synthetically. Uses the verified OpenInference ``llm.token_count.*`` family.
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

MODEL = "claude-sonnet-4-6"
CACHE_READ = 22041
CACHE_WRITE = 6422
OUTPUT = 100
GROSS = CACHE_READ + CACHE_WRITE  # 28463 — uncached floors to 0, so this is the total


def _has_tokens(span: dict) -> bool:
    return span.get("input_tokens") is not None


@pytest.mark.parametrize(
    "label,net_input",
    [
        # NET emitter: reported input is the cache-exclusive count, far below the
        # cache total → uncached must floor to 0 (not go negative).
        ("net_input_below_cache", 2),
        # Boundary: reported input exactly equals the cache total → uncached == 0.
        ("input_equals_cache_total", GROSS),
    ],
)
def test_uncached_bucket_floors_to_zero(client, label, net_input):
    """cache_read + cache_write >= input → input_uncached clamps to 0; gross reconstructs."""
    trace_id = rand_trace_id()
    span_id = rand_span_id()
    start = now_nanos()

    span = make_span(
        trace_id_hex=trace_id,
        span_id_hex=span_id,
        name=f"llm.chat[{label}]",
        start_nanos=start,
        end_nanos=start + 1_000_000_000,
        attributes=[
            make_attr("traceroot.span.type", "LLM"),
            make_attr("llm.model_name", MODEL),
            make_attr("llm.token_count.prompt", net_input),
            make_attr("llm.token_count.prompt_details.cache_read", CACHE_READ),
            make_attr("llm.token_count.prompt_details.cache_write", CACHE_WRITE),
            make_attr("llm.token_count.completion", OUTPUT),
        ],
    )
    client.emit(make_otel_payload([span], scope_name="openinference.instrumentation.test"))

    got = client.poll_span(trace_id, span_id, _has_tokens, timeout=60.0)
    assert got is not None, f"[{label}] span never ingested"

    u = usage(got)
    assert u["cache_read_tokens"] == CACHE_READ, label
    assert u["cache_write_tokens"] == CACHE_WRITE, label
    # Uncached floored to 0 → stored GROSS input is exactly the cache sum,
    # regardless of the (smaller or equal) reported net input. Never negative.
    assert got["input_tokens"] == GROSS, label
    assert got["input_tokens"] >= 0, label
    assert got["output_tokens"] == OUTPUT, label
    assert got["total_tokens"] == GROSS + OUTPUT, label

    prices = model_prices(MODEL)
    assert prices is not None
    # Uncached priced at 0; cache priced in full.
    want = expected_cost(
        prices, input_uncached=0, cache_read=CACHE_READ, cache_write=CACHE_WRITE, output=OUTPUT
    )
    assert got["cost"] == pytest.approx(want, rel=1e-3), label
