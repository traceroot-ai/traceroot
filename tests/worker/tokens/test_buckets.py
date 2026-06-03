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
