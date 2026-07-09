"""Unit tests for the scope-keyed token normalization layer."""

import logging

import pytest

import worker.tokens.buckets as buckets_mod
from worker.tokens.buckets import TokenBuckets, normalize_token_usage


@pytest.fixture(autouse=True)
def _reset_warned_scopes():
    buckets_mod._warned_scopes.clear()
    yield


def test_inclusive_scope_subtracts_cache_from_input():
    # OpenInference/pydantic-ai emit a GROSS input that already contains cache.
    b = normalize_token_usage(
        "openinference.instrumentation.anthropic",
        input_tokens=1000,
        output_tokens=50,
        cache_read_tokens=900,
        cache_write_tokens=40,
    )
    assert b == TokenBuckets(input_uncached=60, output=50, cache_read=900, cache_write=40)


def test_buckets_reconcile_to_gross_input():
    b = normalize_token_usage(
        "openinference.instrumentation.openai",
        input_tokens=1000,
        output_tokens=0,
        cache_read_tokens=900,
        cache_write_tokens=0,
    )
    # gross_input == input_uncached + cache_read + cache_write
    assert b.input_uncached + b.cache_read + b.cache_write == 1000


def test_input_clamped_at_zero_when_cache_exceeds_input():
    # Defensive: never go negative even if counts are inconsistent.
    b = normalize_token_usage(
        "pydantic-ai",
        input_tokens=900,
        output_tokens=10,
        cache_read_tokens=900,
        cache_write_tokens=50,
    )
    assert b.input_uncached == 0


def test_unknown_scope_warns_but_still_subtracts(caplog):
    with caplog.at_level(logging.WARNING):
        b = normalize_token_usage(
            "com.acme.someNewInstrumentor",
            input_tokens=1000,
            output_tokens=0,
            cache_read_tokens=300,
            cache_write_tokens=0,
        )
    # Safe default: treat unknown emitters as inclusive (the dominant convention).
    assert b.input_uncached == 700
    assert any("unknown instrumentation scope" in r.message.lower() for r in caplog.records)


def test_missing_scope_does_not_crash(caplog):
    with caplog.at_level(logging.WARNING):
        b = normalize_token_usage(
            None,
            input_tokens=100,
            output_tokens=20,
            cache_read_tokens=0,
            cache_write_tokens=0,
        )
    assert b == TokenBuckets(input_uncached=100, output=20, cache_read=0, cache_write=0)
    assert any("unknown instrumentation scope" in r.message.lower() for r in caplog.records)


def test_non_string_scope_does_not_crash():
    # scope.name comes from untrusted OTLP; a malformed non-string value must be
    # guarded (treated as unknown) rather than crashing ingestion on .lower().
    b = normalize_token_usage(
        123,  # type: ignore[arg-type]
        input_tokens=100,
        output_tokens=10,
        cache_read_tokens=0,
        cache_write_tokens=0,
    )
    assert b == TokenBuckets(input_uncached=100, output=10, cache_read=0, cache_write=0)


def test_cache_exceeding_input_is_kept_uncapped_for_net_emitters():
    # NET/exclusive emitters (e.g. claude-agent-sdk, whose instrumentor passes
    # Anthropic's exclusive input straight through) report a small input with the
    # cache as separate ADDITIVE buckets that legitimately exceed it. Cache must
    # NOT be capped to the input — it is priced in full; only the uncached bucket
    # floors to zero.
    b = normalize_token_usage(
        "openinference.instrumentation.claude_agent_sdk",
        input_tokens=2,
        output_tokens=54,
        cache_read_tokens=15801,
        cache_write_tokens=4897,
    )
    assert b == TokenBuckets(input_uncached=0, output=54, cache_read=15801, cache_write=4897)


def test_inclusive_cache_subtracts_as_a_subset():
    # GROSS emitters: cache is a subset of the input and subtracts out cleanly,
    # leaving the uncached remainder.
    b = normalize_token_usage(
        "openinference.instrumentation.openai",
        input_tokens=1000,
        output_tokens=1,
        cache_read_tokens=900,
        cache_write_tokens=40,
    )
    assert b == TokenBuckets(input_uncached=60, output=1, cache_read=900, cache_write=40)


def test_warned_scopes_set_is_bounded():
    # Unknown scope names must not grow the dedup set without bound.
    for i in range(buckets_mod._MAX_WARNED_SCOPES + 50):
        normalize_token_usage(
            f"unknown.scope.{i}",
            input_tokens=10,
            output_tokens=0,
            cache_read_tokens=0,
            cache_write_tokens=0,
        )
    assert len(buckets_mod._warned_scopes) <= buckets_mod._MAX_WARNED_SCOPES


def test_js_openinference_scope_is_known_inclusive_no_warning(caplog):
    # The JS/TS OpenInference instrumentors emit under the "@arizeai/openinference-*"
    # scope, which must be recognized as cache-inclusive (same as Python's
    # "openinference.*") so TS traces are priced explicitly and without a warning.
    with caplog.at_level(logging.WARNING):
        b = normalize_token_usage(
            "@arizeai/openinference-instrumentation-openai",
            input_tokens=1000,
            output_tokens=50,
            cache_read_tokens=900,
            cache_write_tokens=40,
        )
    assert b == TokenBuckets(input_uncached=60, output=50, cache_read=900, cache_write=40)
    assert not any("unknown instrumentation scope" in r.message.lower() for r in caplog.records)


def test_vercel_ai_scope_is_known_inclusive_no_warning(caplog):
    # The Vercel AI SDK tracer scope is exactly "ai"; its inputTokens total is
    # GROSS (noCache + cacheRead + cacheWrite components), so the standard
    # subtraction applies and no unknown-scope warning should fire.
    with caplog.at_level(logging.WARNING):
        b = normalize_token_usage(
            "ai",
            input_tokens=28466,
            output_tokens=120,
            cache_read_tokens=22041,
            cache_write_tokens=6422,
        )
    assert b == TokenBuckets(input_uncached=3, output=120, cache_read=22041, cache_write=6422)
    assert not any("unknown instrumentation scope" in r.message.lower() for r in caplog.records)


def test_ai_prefixed_scope_still_warns(caplog):
    # "ai" is matched exactly, not as a prefix — an unrelated ai*-named scope
    # must still surface the unknown-emitter warning.
    with caplog.at_level(logging.WARNING):
        normalize_token_usage(
            "aiohttp.client",
            input_tokens=10,
            output_tokens=1,
            cache_read_tokens=0,
            cache_write_tokens=0,
        )
    assert any("unknown instrumentation scope" in r.message.lower() for r in caplog.records)


def test_token_buckets_fields_default_to_zero():
    # Defaults make future token categories (reasoning/audio) purely additive.
    assert TokenBuckets() == TokenBuckets(input_uncached=0, output=0, cache_read=0, cache_write=0)
    assert TokenBuckets(output=5).cache_read == 0


# ---------------------------------------------------------------------------
# Cache-write 1-hour portion: a SUB-PARTITION of the cache_write total, not a new
# disjoint bucket. cache_write_1h <= cache_write; the remainder prices at cacheWrite.
# ---------------------------------------------------------------------------


def test_cache_write_1h_portion_is_carried_through():
    b = normalize_token_usage(
        "openinference.instrumentation.anthropic",
        input_tokens=1000,
        output_tokens=10,
        cache_read_tokens=200,
        cache_write_tokens=300,
        cache_write_1h_tokens=180,
    )
    # The portion is carried; the cache_write TOTAL and the uncached reconstruction
    # are unaffected by it.
    assert b.cache_write == 300
    assert b.cache_write_1h == 180
    assert b.input_uncached == 500  # 1000 - 200 (read) - 300 (write)


def test_cache_write_1h_caps_to_total():
    # An emitter over-reporting the 1-hour portion must never exceed the write total.
    b = normalize_token_usage(
        "pydantic-ai",
        input_tokens=0,
        output_tokens=0,
        cache_read_tokens=0,
        cache_write_tokens=100,
        cache_write_1h_tokens=180,  # > 100
    )
    assert b.cache_write_1h == 100  # capped to the write total
    assert b.cache_write_1h <= b.cache_write


def test_cache_write_1h_clamps_negative():
    b = normalize_token_usage(
        "pydantic-ai",
        input_tokens=0,
        output_tokens=0,
        cache_read_tokens=0,
        cache_write_tokens=100,
        cache_write_1h_tokens=-50,
    )
    assert b.cache_write_1h == 0


def test_cache_write_1h_absent_defaults_to_zero():
    # The dominant path today: no 1-hour portion reported -> it is zero and the write
    # total is intact, so pricing is unchanged.
    b = normalize_token_usage(
        "openinference.instrumentation.anthropic",
        input_tokens=1000,
        output_tokens=10,
        cache_read_tokens=200,
        cache_write_tokens=300,
    )
    assert b.cache_write_1h == 0
    assert b.cache_write == 300


def test_reconcile_cache_write_1h_is_a_valid_partition():
    from worker.tokens.buckets import reconcile_cache_write_1h

    assert reconcile_cache_write_1h(100, 30) == 30
    assert reconcile_cache_write_1h(100, 180) == 100  # capped to total
    assert reconcile_cache_write_1h(100, -5) == 0  # clamped non-negative
    assert reconcile_cache_write_1h(0, 10) == 0  # no writes
    assert reconcile_cache_write_1h(-50, 10) == 0  # negative total clamped
    assert reconcile_cache_write_1h(50, 999) <= 50


def test_token_buckets_1h_field_defaults_to_zero():
    assert TokenBuckets().cache_write_1h == 0
    assert TokenBuckets(cache_write=5).cache_write_1h == 0
