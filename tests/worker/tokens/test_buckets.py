"""Unit tests for the scope-keyed token normalization layer."""

import logging

import pytest

import worker.tokens.buckets as buckets_mod
from worker.tokens.buckets import (
    TokenBuckets,
    normalize_token_usage,
    resolve_input_is_net,
)


@pytest.fixture(autouse=True)
def _reset_warned_scopes():
    buckets_mod._warned_scopes.clear()
    buckets_mod._warned_net_fallback_scopes.clear()
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


def test_input_clamped_at_zero_when_a_gross_input_is_inconsistent():
    # Defensive: a reporter that says its input is GROSS but reports more cache
    # than input never produces a negative uncached bucket.
    b = normalize_token_usage(
        "pydantic-ai",
        input_tokens=900,
        output_tokens=10,
        cache_read_tokens=900,
        cache_write_tokens=50,
        input_is_net=False,
    )
    assert b.input_uncached == 0


def test_cache_exceeding_input_is_provably_net():
    # A gross input contains its cache, so cache > input can only be a net
    # report. The input is kept as the uncached bucket instead of floored away.
    b = normalize_token_usage(
        "pydantic-ai",
        input_tokens=900,
        output_tokens=10,
        cache_read_tokens=900,
        cache_write_tokens=50,
    )
    assert b == TokenBuckets(input_uncached=900, output=10, cache_read=900, cache_write=50)


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
    # NOT be capped to the input — it is priced in full, and the reported input
    # is the uncached bucket.
    b = normalize_token_usage(
        "openinference.instrumentation.claude_agent_sdk",
        input_tokens=2,
        output_tokens=54,
        cache_read_tokens=15801,
        cache_write_tokens=4897,
    )
    assert b == TokenBuckets(input_uncached=2, output=54, cache_read=15801, cache_write=4897)


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


def test_vercel_gen_ai_scope_is_known_inclusive_no_warning(caplog):
    # The Vercel AI SDK's semconv emitter uses tracer scope exactly "gen_ai".
    # Its gen_ai.usage.input_tokens comes from the same GROSS usage source as
    # the legacy "ai" scope, so the standard subtraction applies silently.
    with caplog.at_level(logging.WARNING):
        b = normalize_token_usage(
            "gen_ai",
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


def test_npm_scoped_traceroot_emitters_are_known_no_warning(caplog):
    # "@traceroot-ai/pi-extension" (and the other @traceroot-ai/* scopes) start
    # with "@", so the bare "traceroot" prefix never matched them and every
    # process logged a spurious unknown-emitter warning for our own SDKs.
    with caplog.at_level(logging.WARNING):
        b = normalize_token_usage(
            "@traceroot-ai/pi-extension",
            input_tokens=3,
            output_tokens=224,
            cache_read_tokens=0,
            cache_write_tokens=3326,
        )
    # Pi reports input NET of cache, so its 3 input tokens are the uncached bucket.
    assert b == TokenBuckets(input_uncached=3, output=224, cache_read=0, cache_write=3326)
    assert not any("unknown instrumentation scope" in r.message.lower() for r in caplog.records)


# ── Input convention: NET vs GROSS (#2392) ──────────────────────────────────
#
# Anthropic and Bedrock Converse report input_tokens NET of cache. An emitter
# that passes that through must not have the cache subtracted from it, or every
# uncached token is floored away and never priced.


class TestNetInputEmitterTable:
    def test_js_openinference_bedrock_is_net_even_when_cache_is_smaller_than_input(self):
        # InvokeModel on Claude and Nova passes the provider's net input through.
        b = normalize_token_usage(
            "@arizeai/openinference-instrumentation-bedrock",
            input_tokens=1000,
            output_tokens=10,
            cache_read_tokens=300,
            cache_write_tokens=100,
            scope_version="0.5.1",
        )
        assert b == TokenBuckets(input_uncached=1000, output=10, cache_read=300, cache_write=100)

    def test_js_openinference_bedrock_without_cache_is_unchanged(self):
        # Its Converse path emits no cache attributes: net and gross agree.
        b = normalize_token_usage(
            "@arizeai/openinference-instrumentation-bedrock",
            input_tokens=1000,
            output_tokens=10,
            cache_read_tokens=0,
            cache_write_tokens=0,
        )
        assert b == TokenBuckets(input_uncached=1000, output=10, cache_read=0, cache_write=0)

    def test_python_openinference_bedrock_is_not_in_the_table(self):
        # One scope, two conventions. InvokeModel on Claude sums the three
        # fields (gross), so a scope-level net entry would price cache twice.
        scope = "openinference.instrumentation.bedrock"
        invoke_model_claude = normalize_token_usage(
            scope,
            input_tokens=1400,  # 1000 uncached + 300 read + 100 write, already summed
            output_tokens=10,
            cache_read_tokens=300,
            cache_write_tokens=100,
        )
        assert invoke_model_claude.input_uncached == 1000

        # Converse passes the net inputTokens through. It is only recognized
        # when the cache exceeds the input.
        converse_provably_net = normalize_token_usage(
            scope,
            input_tokens=14,
            output_tokens=10,
            cache_read_tokens=1613,
            cache_write_tokens=0,
        )
        assert converse_provably_net.input_uncached == 14

    @pytest.mark.parametrize(
        "scope",
        ["@traceroot-ai/pi-extension", "@traceroot-ai/pi-coding-agent"],
    )
    def test_pi_emitters_are_net_even_when_cache_is_smaller_than_input(self, scope):
        # cache <= input is not provably net, so only the table can get this right.
        b = normalize_token_usage(
            scope,
            input_tokens=1000,
            output_tokens=10,
            cache_read_tokens=300,
            cache_write_tokens=100,
        )
        assert b == TokenBuckets(input_uncached=1000, output=10, cache_read=300, cache_write=100)

    def test_scope_name_match_is_case_insensitive(self):
        b = normalize_token_usage(
            "@TraceRoot-AI/Pi-Extension",
            input_tokens=1000,
            output_tokens=0,
            cache_read_tokens=300,
            cache_write_tokens=0,
        )
        assert b.input_uncached == 1000

    @pytest.mark.parametrize("version", ["0.27.0", "0.26.3", "0.9.0", "v0.27.0", "0.27.0-beta.1"])
    def test_traceloop_anthropic_up_to_0_27_0_is_net(self, version):
        b = normalize_token_usage(
            "@traceloop/instrumentation-anthropic",
            input_tokens=1000,
            output_tokens=10,
            cache_read_tokens=300,
            cache_write_tokens=0,
            scope_version=version,
        )
        assert b.input_uncached == 1000

    @pytest.mark.parametrize("version", ["0.27.1", "0.28.0", "1.0.0", "0.28.0-rc.1"])
    def test_traceloop_anthropic_after_0_27_0_is_gross(self, version):
        b = normalize_token_usage(
            "@traceloop/instrumentation-anthropic",
            input_tokens=1000,
            output_tokens=10,
            cache_read_tokens=300,
            cache_write_tokens=0,
            scope_version=version,
        )
        assert b.input_uncached == 700

    @pytest.mark.parametrize("version", [None, "", "latest", "0.27", "1.2.3.4", 27, "0.x.0"])
    def test_traceloop_anthropic_without_a_usable_version_is_not_guessed(self, version):
        # "0.27" parses as 0.27.0 and is net; everything else here is unusable
        # and stays gross, because cache <= input is not provably net.
        b = normalize_token_usage(
            "@traceloop/instrumentation-anthropic",
            input_tokens=1000,
            output_tokens=10,
            cache_read_tokens=300,
            cache_write_tokens=0,
            scope_version=version,  # type: ignore[arg-type]
        )
        assert b.input_uncached == (1000 if version == "0.27" else 700)

    @pytest.mark.parametrize(
        "scope",
        [
            "@traceroot-ai/claude-agent-sdk",
            "openinference.instrumentation.anthropic",
            "opentelemetry.instrumentation.anthropic",  # Traceloop Python
            "pydantic-ai",
            "@traceloop/instrumentation-openai",
            "ai",
            "gen_ai",
        ],
    )
    def test_gross_emitters_are_unchanged(self, scope):
        # These sum the three Anthropic fields before emitting. Treating them as
        # net would price the cache twice.
        b = normalize_token_usage(
            scope,
            input_tokens=7468,
            output_tokens=120,
            cache_read_tokens=5187,
            cache_write_tokens=0,
            scope_version="0.1.0",
        )
        assert b == TokenBuckets(input_uncached=2281, output=120, cache_read=5187, cache_write=0)

    def test_traceloop_js_scope_is_known_no_warning(self, caplog):
        with caplog.at_level(logging.WARNING):
            normalize_token_usage(
                "@traceloop/instrumentation-anthropic",
                input_tokens=10,
                output_tokens=1,
                cache_read_tokens=0,
                cache_write_tokens=0,
                scope_version="0.27.0",
            )
        assert not any("unknown instrumentation scope" in r.message.lower() for r in caplog.records)


class TestExplicitInputIsNet:
    def test_explicit_net_wins_over_a_gross_scope(self):
        b = normalize_token_usage(
            "traceroot",
            input_tokens=1000,
            output_tokens=10,
            cache_read_tokens=300,
            cache_write_tokens=100,
            input_is_net=True,
        )
        assert b == TokenBuckets(input_uncached=1000, output=10, cache_read=300, cache_write=100)

    def test_explicit_gross_wins_over_a_net_scope(self):
        b = normalize_token_usage(
            "@traceroot-ai/pi-extension",
            input_tokens=1000,
            output_tokens=10,
            cache_read_tokens=300,
            cache_write_tokens=100,
            input_is_net=False,
        )
        assert b == TokenBuckets(input_uncached=600, output=10, cache_read=300, cache_write=100)

    def test_explicit_gross_wins_over_the_provable_net_fallback(self, caplog):
        with caplog.at_level(logging.WARNING):
            b = normalize_token_usage(
                "traceroot",
                input_tokens=2,
                output_tokens=10,
                cache_read_tokens=900,
                cache_write_tokens=0,
                input_is_net=False,
            )
        assert b.input_uncached == 0
        assert not any("net of cache" in r.message.lower() for r in caplog.records)

    def test_non_bool_explicit_value_is_ignored(self):
        # Only a real bool is an override; anything else falls through to the table.
        b = normalize_token_usage(
            "traceroot",
            input_tokens=1000,
            output_tokens=0,
            cache_read_tokens=300,
            cache_write_tokens=0,
            input_is_net="true",  # type: ignore[arg-type]
        )
        assert b.input_uncached == 700


class TestProvableNetFallback:
    # Captured in #2392: three Sonnet 4.6 calls with a 2,281-token cached system
    # prompt, one hand-made span per call copying Anthropic's usage verbatim.
    @pytest.mark.parametrize(
        ("input_tokens", "cache_read", "cache_write", "gross"),
        [
            (29, 0, 2281, 2310),
            (157, 2281, 0, 2438),
            (288, 2281, 0, 2569),
        ],
    )
    def test_hand_made_anthropic_spans_keep_their_uncached_tokens(
        self, input_tokens, cache_read, cache_write, gross
    ):
        b = normalize_token_usage(
            "repro-net-input",
            input_tokens=input_tokens,
            output_tokens=150,
            cache_read_tokens=cache_read,
            cache_write_tokens=cache_write,
        )
        assert b.input_uncached == input_tokens
        assert b.cache_read == cache_read
        assert b.cache_write == cache_write
        assert b.input_uncached + b.cache_read + b.cache_write == gross

    def test_warns_once_per_scope(self, caplog):
        with caplog.at_level(logging.WARNING):
            for _ in range(3):
                normalize_token_usage(
                    "traceroot",
                    input_tokens=2,
                    output_tokens=1,
                    cache_read_tokens=900,
                    cache_write_tokens=0,
                )
        warnings = [r for r in caplog.records if "net of cache" in r.message.lower()]
        assert len(warnings) == 1

    def test_table_scopes_do_not_warn(self, caplog):
        with caplog.at_level(logging.WARNING):
            normalize_token_usage(
                "@traceroot-ai/pi-extension",
                input_tokens=3,
                output_tokens=1,
                cache_read_tokens=3581,
                cache_write_tokens=834,
            )
        assert not any("net of cache" in r.message.lower() for r in caplog.records)

    def test_equal_cache_and_input_stays_gross(self):
        # A gross emitter whose whole prompt was a cache hit reports cache == input.
        b = normalize_token_usage(
            "openinference.instrumentation.openai",
            input_tokens=1000,
            output_tokens=1,
            cache_read_tokens=1000,
            cache_write_tokens=0,
        )
        assert b.input_uncached == 0

    def test_warned_scope_set_is_bounded(self):
        for i in range(buckets_mod._MAX_WARNED_SCOPES + 50):
            normalize_token_usage(
                f"scope-{i}",
                input_tokens=1,
                output_tokens=0,
                cache_read_tokens=5,
                cache_write_tokens=0,
            )
        assert len(buckets_mod._warned_net_fallback_scopes) == buckets_mod._MAX_WARNED_SCOPES

    def test_malformed_scope_name_does_not_crash(self):
        assert (
            resolve_input_is_net(
                123,  # type: ignore[arg-type]
                {"v": 1},  # type: ignore[arg-type]
                input_tokens=10,
                cache_read_tokens=0,
                cache_write_tokens=0,
            )
            is False
        )
