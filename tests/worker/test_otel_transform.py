"""Unit tests for OTEL → ClickHouse transformation logic."""

import base64
from datetime import datetime

import pytest

from tests.fixtures.otel_payloads import make_attr, make_otel_payload, make_span
from worker.otel_transform import (
    attributes_to_dict,
    decode_otel_id,
    extract_attribute_value,
    first_present_number,
    get_span_kind,
    int_or_zero,
    nanos_to_datetime,
    transform_otel_to_clickhouse,
)


class TestFirstPresentNumber:
    """A malformed high-priority token attr must not suppress a valid fallback."""

    def test_malformed_high_priority_falls_through_to_valid_fallback(self):
        # "" (present-but-empty) and "abc" (non-numeric) must be skipped so the
        # valid lower-priority key is used — otherwise the cache/token count is
        # silently undercounted and the cost is wrong.
        attrs = {"high": "", "mid": "abc", "low": 1000}
        assert first_present_number(attrs, ["high", "mid", "low"]) == 1000

    def test_valid_zero_is_not_skipped(self):
        # 0 is a legitimate token count and must win over lower-priority keys.
        attrs = {"high": 0, "low": 500}
        assert first_present_number(attrs, ["high", "low"]) == 0

    def test_all_missing_or_malformed_returns_none(self):
        attrs = {"high": "", "mid": None, "low": "x"}
        assert first_present_number(attrs, ["high", "mid", "low"]) is None

    def test_numeric_string_is_usable(self):
        assert first_present_number({"k": "4528"}, ["k"]) == "4528"


class TestIntOrZero:
    """int_or_zero must never crash ingestion on present-but-non-numeric values."""

    def test_none_and_missing_become_zero(self):
        assert int_or_zero(None) == 0

    def test_empty_string_becomes_zero(self):
        # first_present returns "" for a present-but-empty attribute; int("") would raise.
        assert int_or_zero("") == 0

    def test_non_numeric_string_becomes_zero(self):
        assert int_or_zero("abc") == 0

    def test_numeric_string_parses(self):
        assert int_or_zero("4528") == 4528

    def test_ints_and_floats_parse(self):
        assert int_or_zero(42) == 42
        assert int_or_zero(3.9) == 3


# ── decode_otel_id ──────────────────────────────────────────────────────


class TestDecodeOtelId:
    def test_valid_16_byte_trace_id(self):
        hex_id = "0123456789abcdef0123456789abcdef"
        b64 = base64.b64encode(bytes.fromhex(hex_id)).decode()
        assert decode_otel_id(b64) == hex_id

    def test_valid_8_byte_span_id(self):
        hex_id = "0123456789abcdef"
        b64 = base64.b64encode(bytes.fromhex(hex_id)).decode()
        assert decode_otel_id(b64) == hex_id

    def test_none_returns_none(self):
        assert decode_otel_id(None) is None

    def test_empty_string_returns_none(self):
        assert decode_otel_id("") is None

    def test_invalid_base64_returns_raw(self):
        raw = "not-valid-base64!!!"
        assert decode_otel_id(raw) == raw

    def test_all_zero_span_id_returns_none(self):
        # Some emitters send zero-filled bytes for "no parent"; OTLP treats
        # all-zero IDs as absent.
        b64 = base64.b64encode(bytes(8)).decode()
        assert decode_otel_id(b64) is None

    def test_all_zero_trace_id_returns_none(self):
        b64 = base64.b64encode(bytes(16)).decode()
        assert decode_otel_id(b64) is None


# ── nanos_to_datetime ───────────────────────────────────────────────────


class TestNanosToDatetime:
    def test_int_nanos(self):
        # 2024-01-15 12:00:00 UTC
        nanos = 1705320000000000000
        result = nanos_to_datetime(nanos)
        assert result == datetime(2024, 1, 15, 12, 0, 0)

    def test_string_nanos(self):
        result = nanos_to_datetime("1705320000000000000")
        assert result == datetime(2024, 1, 15, 12, 0, 0)

    def test_none_returns_none(self):
        assert nanos_to_datetime(None) is None

    def test_empty_string_returns_none(self):
        assert nanos_to_datetime("") is None

    def test_zero_returns_epoch(self):
        result = nanos_to_datetime(0)
        assert result == datetime(1970, 1, 1, 0, 0, 0)


# ── extract_attribute_value ─────────────────────────────────────────────


class TestExtractAttributeValue:
    def test_string_value(self):
        assert extract_attribute_value({"stringValue": "hello"}) == "hello"

    def test_int_value(self):
        assert extract_attribute_value({"intValue": "42"}) == 42

    def test_bool_value(self):
        assert extract_attribute_value({"boolValue": True}) is True

    def test_double_value(self):
        assert extract_attribute_value({"doubleValue": 3.14}) == 3.14

    def test_array_value(self):
        result = extract_attribute_value(
            {"arrayValue": {"values": [{"stringValue": "a"}, {"stringValue": "b"}]}}
        )
        assert result == ["a", "b"]

    def test_kvlist_value(self):
        result = extract_attribute_value(
            {"kvlistValue": {"values": [{"key": "k1", "value": {"stringValue": "v1"}}]}}
        )
        assert result == {"k1": "v1"}

    def test_unknown_returns_none(self):
        assert extract_attribute_value({}) is None


# ── attributes_to_dict ──────────────────────────────────────────────────


class TestAttributesToDict:
    def test_mixed_attrs(self):
        attrs = [
            {"key": "foo", "value": {"stringValue": "bar"}},
            {"key": "count", "value": {"intValue": "42"}},
            {"key": "active", "value": {"boolValue": True}},
        ]
        result = attributes_to_dict(attrs)
        assert result == {"foo": "bar", "count": 42, "active": True}

    def test_empty_list(self):
        assert attributes_to_dict([]) == {}


# ── get_span_kind ───────────────────────────────────────────────────────


class TestGetSpanKind:
    def test_explicit_traceroot_llm(self):
        assert get_span_kind({"traceroot.span.type": "LLM"}, None) == "LLM"

    def test_explicit_traceroot_agent(self):
        assert get_span_kind({"traceroot.span.type": "agent"}, None) == "AGENT"

    def test_openinference_agent(self):
        assert get_span_kind({"openinference.span.kind": "AGENT"}, None) == "AGENT"

    def test_openinference_tool(self):
        assert get_span_kind({"openinference.span.kind": "TOOL"}, None) == "TOOL"

    def test_chain_maps_to_span(self):
        assert get_span_kind({"openinference.span.kind": "CHAIN"}, None) == "SPAN"

    def test_infer_from_gen_ai_system(self):
        assert get_span_kind({"gen_ai.system": "openai"}, None) == "LLM"

    def test_infer_from_llm_model_name(self):
        assert get_span_kind({"llm.model_name": "gpt-4"}, None) == "LLM"

    def test_infer_from_traceroot_llm_model(self):
        assert get_span_kind({"traceroot.llm.model": "gpt-4o"}, None) == "LLM"

    def test_default_is_span(self):
        assert get_span_kind({}, None) == "SPAN"


# ── transform_otel_to_clickhouse ────────────────────────────────────────


class TestTransformOtelToClickhouse:
    def test_empty_payload(self):
        traces, spans = transform_otel_to_clickhouse({"resourceSpans": []}, "proj-1")
        assert traces == []
        assert spans == []

    def test_empty_resource_spans_key(self):
        traces, spans = transform_otel_to_clickhouse({}, "proj-1")
        assert traces == []
        assert spans == []

    def test_single_root_span(self):
        """Root span (no parent) creates both trace and span records."""
        trace_hex = "aa" * 16
        span_hex = "bb" * 8
        payload = make_otel_payload([make_span(trace_hex, span_hex, name="my-trace")])
        traces, spans = transform_otel_to_clickhouse(payload, "proj-1")

        assert len(traces) == 1
        assert len(spans) == 1
        assert traces[0]["trace_id"] == trace_hex
        assert traces[0]["project_id"] == "proj-1"
        assert traces[0]["name"] == "my-trace"
        assert spans[0]["span_id"] == span_hex
        assert spans[0]["trace_id"] == trace_hex
        assert spans[0]["parent_span_id"] is None
        assert spans[0]["span_kind"] == "SPAN"
        assert spans[0]["status"] == "OK"

    def test_zero_filled_parent_span_id_treated_as_root(self):
        """A zero-byte parentSpanId must normalize to None so the span is a root."""
        trace_hex = "aa" * 16
        span_hex = "bb" * 8
        payload = make_otel_payload(
            [make_span(trace_hex, span_hex, name="root", parent_span_id_hex="00" * 8)]
        )
        traces, spans = transform_otel_to_clickhouse(payload, "proj-1")

        assert spans[0]["parent_span_id"] is None
        assert len(traces) == 1
        assert traces[0]["name"] == "root"

    def test_child_span_does_not_create_trace(self):
        """Child span creates span record but not trace record."""
        trace_hex = "aa" * 16
        root_hex = "bb" * 8
        child_hex = "cc" * 8
        payload = make_otel_payload(
            [
                make_span(trace_hex, root_hex, name="root"),
                make_span(trace_hex, child_hex, name="child", parent_span_id_hex=root_hex),
            ]
        )
        traces, spans = transform_otel_to_clickhouse(payload, "proj-1")

        assert len(traces) == 1  # Only root creates trace
        assert len(spans) == 2
        assert traces[0]["name"] == "root"

    def test_root_span_input_output_propagates_to_trace(self):
        trace_hex = "aa" * 16
        span_hex = "bb" * 8
        payload = make_otel_payload(
            [
                make_span(
                    trace_hex,
                    span_hex,
                    attributes=[
                        make_attr("traceroot.span.input", "hello"),
                        make_attr("traceroot.span.output", "world"),
                    ],
                )
            ]
        )
        traces, spans = transform_otel_to_clickhouse(payload, "proj-1")

        assert traces[0]["input"] == "hello"
        assert traces[0]["output"] == "world"
        assert spans[0]["input"] == "hello"
        assert spans[0]["output"] == "world"

    def test_user_session_from_root_span(self):
        trace_hex = "aa" * 16
        span_hex = "bb" * 8
        payload = make_otel_payload(
            [
                make_span(
                    trace_hex,
                    span_hex,
                    attributes=[
                        make_attr("traceroot.trace.user_id", "user-123"),
                        make_attr("traceroot.trace.session_id", "sess-456"),
                    ],
                )
            ]
        )
        traces, _ = transform_otel_to_clickhouse(payload, "proj-1")

        assert traces[0]["user_id"] == "user-123"
        assert traces[0]["session_id"] == "sess-456"

    def test_user_session_from_child_when_root_has_none(self):
        trace_hex = "aa" * 16
        root_hex = "bb" * 8
        child_hex = "cc" * 8
        payload = make_otel_payload(
            [
                make_span(trace_hex, root_hex, name="root"),
                make_span(
                    trace_hex,
                    child_hex,
                    parent_span_id_hex=root_hex,
                    attributes=[make_attr("user.id", "child-user")],
                ),
            ]
        )
        traces, _ = transform_otel_to_clickhouse(payload, "proj-1")

        assert traces[0]["user_id"] == "child-user"

    def test_git_metadata_from_child_before_root_arrives(self):
        """Repo/ref should be available during live streaming, not only at trace end."""
        trace_hex = "aa" * 16
        root_hex = "bb" * 8
        child_hex = "cc" * 8
        payload = make_otel_payload(
            [
                make_span(
                    trace_hex,
                    child_hex,
                    name="llm-call",
                    parent_span_id_hex=root_hex,
                    attributes=[
                        make_attr("traceroot.git.repo", "https://github.com/acme/agent"),
                        make_attr("traceroot.git.ref", "feature/live-debug"),
                    ],
                )
            ]
        )

        traces, _ = transform_otel_to_clickhouse(payload, "proj-1")

        assert len(traces) == 1
        assert traces[0]["git_repo"] == "https://github.com/acme/agent"
        assert traces[0]["git_ref"] == "feature/live-debug"

    def test_root_git_metadata_overrides_child_candidate(self):
        """If root and child disagree, root remains the authoritative trace value."""
        trace_hex = "aa" * 16
        root_hex = "bb" * 8
        child_hex = "cc" * 8
        payload = make_otel_payload(
            [
                make_span(
                    trace_hex,
                    child_hex,
                    name="tool-call",
                    parent_span_id_hex=root_hex,
                    attributes=[
                        make_attr("traceroot.git.repo", "https://github.com/acme/stale-agent"),
                        make_attr("traceroot.git.ref", "stale-ref"),
                    ],
                ),
                make_span(
                    trace_hex,
                    root_hex,
                    name="agent-run",
                    attributes=[
                        make_attr("traceroot.git.repo", "https://github.com/acme/agent"),
                        make_attr("traceroot.git.ref", "main"),
                    ],
                ),
            ]
        )

        traces, _ = transform_otel_to_clickhouse(payload, "proj-1")

        assert len(traces) == 1
        assert traces[0]["git_repo"] == "https://github.com/acme/agent"
        assert traces[0]["git_ref"] == "main"

    def test_child_git_metadata_survives_when_root_has_none(self):
        """Older or partial root spans should not clear git metadata from child spans."""
        trace_hex = "aa" * 16
        root_hex = "bb" * 8
        child_hex = "cc" * 8
        payload = make_otel_payload(
            [
                make_span(
                    trace_hex,
                    child_hex,
                    name="tool-call",
                    parent_span_id_hex=root_hex,
                    attributes=[
                        make_attr("traceroot.git.repo", "https://github.com/acme/agent"),
                        make_attr("traceroot.git.ref", "main"),
                    ],
                ),
                make_span(trace_hex, root_hex, name="agent-run"),
            ]
        )

        traces, _ = transform_otel_to_clickhouse(payload, "proj-1")

        assert len(traces) == 1
        assert traces[0]["git_repo"] == "https://github.com/acme/agent"
        assert traces[0]["git_ref"] == "main"

    def test_skip_span_with_missing_ids(self):
        """Spans without traceId/spanId are skipped."""
        payload = {
            "resourceSpans": [
                {
                    "resource": {"attributes": []},
                    "scopeSpans": [
                        {
                            "scope": {"name": "test"},
                            "spans": [{"name": "bad-span", "attributes": []}],
                        }
                    ],
                }
            ]
        }
        traces, spans = transform_otel_to_clickhouse(payload, "proj-1")
        assert traces == []
        assert spans == []

    def test_error_status(self):
        trace_hex = "aa" * 16
        span_hex = "bb" * 8
        payload = make_otel_payload([make_span(trace_hex, span_hex, status_code=2)])
        _, spans = transform_otel_to_clickhouse(payload, "proj-1")

        assert spans[0]["status"] == "ERROR"

    def test_error_status_string_code(self):
        trace_hex = "aa" * 16
        span_hex = "bb" * 8
        span = make_span(trace_hex, span_hex)
        span["status"] = {"code": "STATUS_CODE_ERROR", "message": "something failed"}
        payload = make_otel_payload([span])
        _, spans = transform_otel_to_clickhouse(payload, "proj-1")

        assert spans[0]["status"] == "ERROR"
        assert spans[0]["status_message"] == "something failed"

    def test_multiple_traces(self):
        trace1 = "aa" * 16
        trace2 = "bb" * 16
        span1 = "11" * 8
        span2 = "22" * 8
        payload = make_otel_payload(
            [
                make_span(trace1, span1, name="trace-one"),
                make_span(trace2, span2, name="trace-two"),
            ]
        )
        traces, spans = transform_otel_to_clickhouse(payload, "proj-1")

        assert len(traces) == 2
        assert len(spans) == 2
        trace_names = {t["name"] for t in traces}
        assert trace_names == {"trace-one", "trace-two"}

    def test_traceroot_span_type_attribute(self):
        trace_hex = "aa" * 16
        span_hex = "bb" * 8
        payload = make_otel_payload(
            [
                make_span(
                    trace_hex,
                    span_hex,
                    attributes=[make_attr("traceroot.span.type", "LLM")],
                )
            ]
        )
        _, spans = transform_otel_to_clickhouse(payload, "proj-1")
        assert spans[0]["span_kind"] == "LLM"

    def test_openinference_span_kind_attribute(self):
        trace_hex = "aa" * 16
        span_hex = "bb" * 8
        payload = make_otel_payload(
            [
                make_span(
                    trace_hex,
                    span_hex,
                    attributes=[make_attr("openinference.span.kind", "AGENT")],
                )
            ]
        )
        _, spans = transform_otel_to_clickhouse(payload, "proj-1")
        assert spans[0]["span_kind"] == "AGENT"

    def test_genai_model_extracts_model_name(self):
        trace_hex = "aa" * 16
        span_hex = "bb" * 8
        payload = make_otel_payload(
            [
                make_span(
                    trace_hex,
                    span_hex,
                    attributes=[make_attr("gen_ai.request.model", "gpt-4o")],
                )
            ]
        )
        _, spans = transform_otel_to_clickhouse(payload, "proj-1")
        assert spans[0]["model_name"] == "gpt-4o"

    def test_api_tokens_preferred_over_estimation(self):
        """API-provided token counts should be used over text-based estimation."""
        from unittest.mock import patch

        trace_hex = "aa" * 16
        span_hex = "bb" * 8
        payload = make_otel_payload(
            [
                make_span(
                    trace_hex,
                    span_hex,
                    attributes=[
                        make_attr("gen_ai.request.model", "gpt-4o"),
                        make_attr("gen_ai.usage.input_tokens", 100),
                        make_attr("gen_ai.usage.output_tokens", 50),
                    ],
                )
            ]
        )
        mock_prices = {"input": 0.0000025, "output": 0.00001}
        with patch("worker.tokens.pricing.get_model_price", return_value=mock_prices):
            _, spans = transform_otel_to_clickhouse(payload, "proj-1")

        assert spans[0]["input_tokens"] == 100
        assert spans[0]["output_tokens"] == 50
        assert spans[0]["total_tokens"] == 150
        assert spans[0]["cost"] is not None

    @pytest.mark.parametrize(
        ("scope_name", "input_attr", "cache_read_attr", "cache_write_attr"),
        [
            # OpenInference Anthropic — the verified dominant path. Cache is under
            # llm.token_count.prompt_details.* and the prompt is GROSS.
            (
                "openinference.instrumentation.anthropic",
                "llm.token_count.prompt",
                "llm.token_count.prompt_details.cache_read",
                "llm.token_count.prompt_details.cache_write",
            ),
            # pydantic-ai native gen_ai.usage.* keys.
            (
                "pydantic-ai",
                "gen_ai.usage.input_tokens",
                "gen_ai.usage.cache_read.input_tokens",
                "gen_ai.usage.cache_creation.input_tokens",
            ),
            # pydantic-ai version variants whose cache key names differ — must
            # still be detected so cache isn't silently missed (then overcharged).
            (
                "pydantic-ai",
                "gen_ai.usage.input_tokens",
                "gen_ai.usage.cache_read_tokens",
                "gen_ai.usage.details.cache_creation_input_tokens",
            ),
            (
                "pydantic-ai",
                "gen_ai.usage.input_tokens",
                "gen_ai.usage.details.cache_read_input_tokens",
                "gen_ai.usage.details.cache_write_tokens",
            ),
            # Vercel AI SDK: gen_ai totals are emitted natively on doGenerate
            # spans, but cache detail exists only under the raw ai.* namespace.
            (
                "ai",
                "gen_ai.usage.input_tokens",
                "ai.usage.cachedInputTokens",
                "ai.usage.inputTokenDetails.cacheWriteTokens",
            ),
            (
                "ai",
                "gen_ai.usage.input_tokens",
                "ai.usage.inputTokenDetails.cacheReadTokens",
                "ai.usage.inputTokenDetails.cacheWriteTokens",
            ),
        ],
    )
    def test_cache_heavy_span_subtracts_before_pricing(
        self, scope_name, input_attr, cache_read_attr, cache_write_attr
    ):
        """Cost must price each token once: gross input is reduced by cache."""
        from unittest.mock import patch

        prices = {
            "input": 0.000003,
            "output": 0.000015,
            "cacheRead": 0.0000003,
            "cacheWrite": 0.00000375,
        }
        # gross input = 1000, of which 900 cache-read + 50 cache-write => 50 uncached
        payload = make_otel_payload(
            [
                make_span(
                    "aa" * 16,
                    "bb" * 8,
                    attributes=[
                        make_attr("gen_ai.request.model", "claude-3-5-sonnet"),
                        make_attr(input_attr, 1000),
                        make_attr("llm.token_count.completion", 0)
                        if input_attr.startswith("llm.")
                        else make_attr("gen_ai.usage.output_tokens", 0),
                        make_attr(cache_read_attr, 900),
                        make_attr(cache_write_attr, 50),
                    ],
                )
            ],
            scope_name=scope_name,
        )
        with patch("worker.tokens.pricing.get_model_price", return_value=prices):
            _, spans = transform_otel_to_clickhouse(payload, "proj-1")

        expected = (
            50 * prices["input"]
            + 0 * prices["output"]
            + 900 * prices["cacheRead"]
            + 50 * prices["cacheWrite"]
        )
        assert spans[0]["cost"] == pytest.approx(expected)
        # Stored input_tokens stays GROSS (display continuity; PR B revisits).
        assert spans[0]["input_tokens"] == 1000

    def test_vercel_do_generate_cache_details_persist_to_usage_details(self):
        """Vercel AI SDK doGenerate spans emit gen_ai.* totals but expose the
        cache and reasoning split only under the raw ai.usage.* namespace; the
        split must land in usage_details rather than zero out."""
        from unittest.mock import patch

        prices = {
            "input": 0.000003,
            "output": 0.000015,
            "cacheRead": 0.0000003,
            "cacheWrite": 0.00000375,
        }
        payload = make_otel_payload(
            [
                make_span(
                    "aa" * 16,
                    "bb" * 8,
                    name="ai.generateText.doGenerate",
                    attributes=[
                        make_attr("gen_ai.request.model", "claude-sonnet-4-5"),
                        make_attr("gen_ai.usage.input_tokens", 28466),
                        make_attr("gen_ai.usage.output_tokens", 120),
                        make_attr("ai.usage.cachedInputTokens", 22041),
                        make_attr("ai.usage.inputTokenDetails.cacheReadTokens", 22041),
                        make_attr("ai.usage.inputTokenDetails.cacheWriteTokens", 6422),
                        make_attr("ai.usage.inputTokenDetails.noCacheTokens", 3),
                        make_attr("ai.usage.outputTokenDetails.reasoningTokens", 64),
                    ],
                )
            ],
            scope_name="ai",
        )
        with patch("worker.tokens.pricing.get_model_price", return_value=prices):
            _, spans = transform_otel_to_clickhouse(payload, "proj-1")

        assert spans[0]["usage_details"]["cache_read_tokens"] == 22041
        assert spans[0]["usage_details"]["cache_write_tokens"] == 6422
        assert spans[0]["usage_details"]["reasoning_tokens"] == 64
        # Gross input reconciles with the breakdown: 3 + 22041 + 6422.
        assert spans[0]["input_tokens"] == 28466
        assert spans[0]["output_tokens"] == 120
        # Cache-discounted cost, not the whole input at the uncached rate.
        expected = (
            3 * prices["input"]
            + 120 * prices["output"]
            + 22041 * prices["cacheRead"]
            + 6422 * prices["cacheWrite"]
        )
        assert spans[0]["cost"] == pytest.approx(expected)

    def test_vercel_agent_wrapper_raw_totals_not_double_counted(self):
        """The ai.generateText AGENT wrapper carries ai.usage.* GROSS totals that
        restate the SUM of its LLM doGenerate children (the SDK aggregates them
        onto the wrapper). The wrapper must NOT be priced from those totals, or
        the trace is charged twice. Only the LLM children — which carry the
        normalized llm.*/gen_ai.* keys — count.

        Span shapes are taken verbatim from a live ai@6 +
        @arizeai/openinference-vercel run: wrapper in/out = 203/178 = sum of the
        two children (67/46 + 136/132)."""
        from unittest.mock import patch

        prices = {"input": 0.000003, "output": 0.000015, "cacheRead": 0.0, "cacheWrite": 0.0}

        def llm_child(span_id_hex, prompt, completion):
            return make_span(
                "aa" * 16,
                span_id_hex,
                name="ai.generateText.doGenerate",
                parent_span_id_hex="bb" * 8,
                attributes=[
                    make_attr("openinference.span.kind", "LLM"),
                    make_attr("llm.model_name", "gpt-4o-mini"),
                    make_attr("llm.token_count.prompt", prompt),
                    make_attr("llm.token_count.completion", completion),
                    # Vercel stamps its raw totals on the LLM span too; the
                    # normalized keys above take priority, so these are redundant.
                    make_attr("ai.usage.inputTokens", prompt),
                    make_attr("ai.usage.outputTokens", completion),
                ],
            )

        payload = make_otel_payload(
            [
                # AGENT wrapper: openinference.span.kind=AGENT (set by the vercel
                # processor by function name) and ONLY raw ai.usage.* aggregates.
                make_span(
                    "aa" * 16,
                    "bb" * 8,
                    name="ai.generateText",
                    attributes=[
                        make_attr("openinference.span.kind", "AGENT"),
                        make_attr("llm.model_name", "gpt-4o-mini"),
                        make_attr("ai.usage.inputTokens", 203),
                        make_attr("ai.usage.outputTokens", 178),
                    ],
                ),
                llm_child("cc" * 8, 67, 46),
                llm_child("dd" * 8, 136, 132),
            ],
            scope_name="ai",
        )
        with patch("worker.tokens.pricing.get_model_price", return_value=prices):
            _, spans = transform_otel_to_clickhouse(payload, "proj-1")

        by_id = {s["span_id"]: s for s in spans}
        wrapper = next(s for s in spans if s["name"] == "ai.generateText")
        children = [s for s in spans if s["name"] == "ai.generateText.doGenerate"]

        # Wrapper contributes nothing — its ai.usage.* aggregate is ignored.
        assert (wrapper.get("input_tokens") or 0) == 0
        assert (wrapper.get("output_tokens") or 0) == 0
        assert (wrapper.get("cost") or 0) == 0
        # Each LLM child is priced from its own (normalized) counts.
        assert sorted(c["input_tokens"] for c in children) == [67, 136]
        # Trace totals equal the children alone (203 in / 178 out), not 2x.
        assert sum((s.get("input_tokens") or 0) for s in spans) == 203
        assert sum((s.get("output_tokens") or 0) for s in spans) == 178
        assert by_id  # spans were keyed by id without collision

    def test_vercel_do_generate_raw_totals_used_when_normalized_absent(self):
        """On an LLM doGenerate span that exposes ONLY the raw ai.usage.* totals
        (no normalized llm.*/gen_ai.* keys), those totals are still adopted —
        the LLM-kind gate keeps the fallback alive where it is the sole source."""
        from unittest.mock import patch

        prices = {"input": 0.000003, "output": 0.000015, "cacheRead": 0.0, "cacheWrite": 0.0}
        payload = make_otel_payload(
            [
                make_span(
                    "aa" * 16,
                    "bb" * 8,
                    name="ai.generateText.doGenerate",
                    attributes=[
                        make_attr("openinference.span.kind", "LLM"),
                        make_attr("llm.model_name", "claude-sonnet-4-5"),
                        make_attr("ai.usage.inputTokens", 28466),
                        make_attr("ai.usage.outputTokens", 120),
                        make_attr("ai.usage.cachedInputTokens", 22041),
                        make_attr("ai.usage.inputTokenDetails.cacheWriteTokens", 6422),
                    ],
                )
            ],
            scope_name="ai",
        )
        with patch("worker.tokens.pricing.get_model_price", return_value=prices):
            _, spans = transform_otel_to_clickhouse(payload, "proj-1")

        assert spans[0]["input_tokens"] == 28466
        assert spans[0]["output_tokens"] == 120
        assert spans[0]["usage_details"]["cache_read_tokens"] == 22041
        assert spans[0]["usage_details"]["cache_write_tokens"] == 6422

    def test_vercel_gross_totals_dropped_on_non_llm_span(self):
        """A non-LLM span (AGENT or CHAIN→SPAN) that carries ONLY the Vercel raw
        ai.usage.* gross totals must contribute nothing. The gross-total keys are
        consulted on LLM spans only, so api_input/output stay None → the
        API-count branch is skipped, and the estimation branch is LLM-only too."""
        from unittest.mock import patch

        prices = {"input": 0.000003, "output": 0.000015, "cacheRead": 0.0, "cacheWrite": 0.0}
        for oi_kind in ("AGENT", "CHAIN"):
            payload = make_otel_payload(
                [
                    make_span(
                        "aa" * 16,
                        "bb" * 8,
                        name="ai.someWrapper",
                        attributes=[
                            make_attr("openinference.span.kind", oi_kind),
                            make_attr("llm.model_name", "gpt-4o-mini"),
                            make_attr("ai.usage.inputTokens", 1234),
                            make_attr("ai.usage.outputTokens", 567),
                            make_attr("ai.usage.promptTokens", 1234),
                            make_attr("ai.usage.completionTokens", 567),
                        ],
                    )
                ],
                scope_name="ai",
            )
            with patch("worker.tokens.pricing.get_model_price", return_value=prices):
                _, spans = transform_otel_to_clickhouse(payload, "proj-1")
            s = spans[0]
            assert (s.get("input_tokens") or 0) == 0, f"oi_kind={oi_kind}"
            assert (s.get("output_tokens") or 0) == 0, f"oi_kind={oi_kind}"
            assert (s.get("cost") or 0) == 0, f"oi_kind={oi_kind}"

    def test_normalized_api_counts_dropped_on_explicit_non_llm_span(self):
        """An explicitly non-LLM wrapper with a model name and normalized usage
        must not be priced from those counts. Future instrumentors may add model
        names to AGENT/CHAIN wrappers that already carry aggregate gen_ai/llm
        usage; accepting those counts would price wrapper totals as real calls."""
        from unittest.mock import patch

        prices = {"input": 0.000003, "output": 0.000015, "cacheRead": 0.0, "cacheWrite": 0.0}
        for oi_kind in ("AGENT", "CHAIN"):
            payload = make_otel_payload(
                [
                    make_span(
                        "aa" * 16,
                        "bb" * 8,
                        name="future.wrapper",
                        attributes=[
                            make_attr("openinference.span.kind", oi_kind),
                            make_attr("llm.model_name", "gpt-4o-mini"),
                            make_attr("llm.token_count.prompt", 1234),
                            make_attr("gen_ai.usage.output_tokens", 567),
                        ],
                    )
                ],
                scope_name="future.instrumentor",
            )
            with patch("worker.tokens.pricing.get_model_price", return_value=prices):
                _, spans = transform_otel_to_clickhouse(payload, "proj-1")

            s = spans[0]
            assert (s.get("input_tokens") or 0) == 0, f"oi_kind={oi_kind}"
            assert (s.get("output_tokens") or 0) == 0, f"oi_kind={oi_kind}"
            assert (s.get("cost") or 0) == 0, f"oi_kind={oi_kind}"

    def test_normalized_non_llm_wrapper_does_not_double_count_llm_child(self):
        """If a wrapper rolls child usage up into normalized token keys, trace
        totals must still come only from the LLM child span."""
        from unittest.mock import patch

        prices = {"input": 0.000003, "output": 0.000015, "cacheRead": 0.0, "cacheWrite": 0.0}
        payload = make_otel_payload(
            [
                make_span(
                    "aa" * 16,
                    "bb" * 8,
                    name="future.agent_wrapper",
                    attributes=[
                        make_attr("openinference.span.kind", "AGENT"),
                        make_attr("llm.model_name", "gpt-4o-mini"),
                        make_attr("llm.token_count.prompt", 203),
                        make_attr("llm.token_count.completion", 178),
                    ],
                ),
                make_span(
                    "aa" * 16,
                    "cc" * 8,
                    name="future.llm_call",
                    parent_span_id_hex="bb" * 8,
                    attributes=[
                        make_attr("openinference.span.kind", "LLM"),
                        make_attr("llm.model_name", "gpt-4o-mini"),
                        make_attr("llm.token_count.prompt", 203),
                        make_attr("llm.token_count.completion", 178),
                    ],
                ),
            ],
            scope_name="future.instrumentor",
        )
        with patch("worker.tokens.pricing.get_model_price", return_value=prices):
            _, spans = transform_otel_to_clickhouse(payload, "proj-1")

        wrapper = next(s for s in spans if s["name"] == "future.agent_wrapper")
        child = next(s for s in spans if s["name"] == "future.llm_call")
        assert (wrapper.get("input_tokens") or 0) == 0
        assert (wrapper.get("output_tokens") or 0) == 0
        assert child["input_tokens"] == 203
        assert child["output_tokens"] == 178
        assert sum((s.get("input_tokens") or 0) for s in spans) == 203
        assert sum((s.get("output_tokens") or 0) for s in spans) == 178

    def test_vercel_generate_object_legacy_spellings_priced_on_llm_child_only(self):
        """generateObject emits only the legacy ai.usage.promptTokens /
        completionTokens spellings. The AGENT wrapper (ai.generateObject) and its
        LLM child (ai.generateObject.doGenerate) both carry them, but only the
        LLM child may be priced — the wrapper would double-count."""
        from unittest.mock import patch

        prices = {"input": 0.000003, "output": 0.000015, "cacheRead": 0.0, "cacheWrite": 0.0}
        payload = make_otel_payload(
            [
                make_span(
                    "aa" * 16,
                    "bb" * 8,
                    name="ai.generateObject",
                    attributes=[
                        make_attr("openinference.span.kind", "AGENT"),
                        make_attr("llm.model_name", "gpt-4o"),
                        make_attr("ai.usage.promptTokens", 500),
                        make_attr("ai.usage.completionTokens", 80),
                    ],
                ),
                make_span(
                    "aa" * 16,
                    "cc" * 8,
                    name="ai.generateObject.doGenerate",
                    parent_span_id_hex="bb" * 8,
                    attributes=[
                        make_attr("openinference.span.kind", "LLM"),
                        make_attr("llm.model_name", "gpt-4o"),
                        make_attr("ai.usage.promptTokens", 500),
                        make_attr("ai.usage.completionTokens", 80),
                    ],
                ),
            ],
            scope_name="ai",
        )
        with patch("worker.tokens.pricing.get_model_price", return_value=prices):
            _, spans = transform_otel_to_clickhouse(payload, "proj-1")

        wrapper = next(s for s in spans if s["name"] == "ai.generateObject")
        child = next(s for s in spans if s["name"] == "ai.generateObject.doGenerate")
        # Legacy spellings adopted on the LLM child.
        assert child["input_tokens"] == 500
        assert child["output_tokens"] == 80
        # AGENT wrapper not priced from the same totals.
        assert (wrapper.get("input_tokens") or 0) == 0
        assert sum((s.get("input_tokens") or 0) for s in spans) == 500

    def test_malformed_high_priority_token_attr_falls_through_to_valid_key(self):
        """A present-but-malformed high-priority token attr must not suppress a
        valid lower-priority fallback (else usage is undercounted and cost wrong)."""
        from unittest.mock import patch

        prices = {"input": 0.000003, "output": 0.000015, "cacheRead": 0.0, "cacheWrite": 0.0}
        payload = make_otel_payload(
            [
                make_span(
                    "aa" * 16,
                    "bb" * 8,
                    attributes=[
                        make_attr("gen_ai.request.model", "claude-3-5-sonnet"),
                        # high-priority key present but malformed (empty string)...
                        make_attr("llm.token_count.prompt", ""),
                        # ...valid count only on a lower-priority fallback key.
                        make_attr("gen_ai.usage.input_tokens", 1000),
                        make_attr("gen_ai.usage.output_tokens", 200),
                    ],
                )
            ],
            scope_name="openinference.instrumentation.anthropic",
        )
        with patch("worker.tokens.pricing.get_model_price", return_value=prices):
            _, spans = transform_otel_to_clickhouse(payload, "proj-1")
        # The fallback's 1000 (not 0) must be used.
        assert spans[0]["input_tokens"] == 1000
        assert spans[0]["cost"] == pytest.approx(1000 * prices["input"] + 200 * prices["output"])

    def test_cache_heavy_costs_less_than_uncached_equivalent(self):
        """Monotonicity: caching must DISCOUNT, never surcharge."""
        from unittest.mock import patch

        prices = {
            "input": 0.000003,
            "output": 0.000015,
            "cacheRead": 0.0000003,
            "cacheWrite": 0.00000375,
        }

        def cost_for(attrs):
            payload = make_otel_payload(
                [make_span("aa" * 16, "bb" * 8, attributes=attrs)],
                scope_name="openinference.instrumentation.anthropic",
            )
            with patch("worker.tokens.pricing.get_model_price", return_value=prices):
                _, spans = transform_otel_to_clickhouse(payload, "proj-1")
            return spans[0]["cost"]

        base = [
            make_attr("gen_ai.request.model", "claude-3-5-sonnet"),
            make_attr("llm.token_count.prompt", 1000),
            make_attr("llm.token_count.completion", 0),
        ]
        cached = base + [
            make_attr("llm.token_count.prompt_details.cache_read", 950),
        ]
        assert cost_for(cached) < cost_for(base)

    def test_cache_write_1h_portion_is_extracted_and_priced(self):
        """When an emitter reports the 1-hour write portion, it is priced at its own
        rate (1h = 2x input), the remainder at cacheWrite, and the breakdown persists."""
        from unittest.mock import patch

        prices = {
            "input": 0.000005,
            "output": 0.000025,
            "cacheRead": 0.0000005,
            "cacheWrite": 0.00000625,  # 5-minute / default rate
            "cacheWrite1h": 0.00001,  # 1h rate (2x input)
        }
        # gross input 1000 = 100 uncached + 900 write; of the 900: 600 @1h, 300 remainder.
        payload = make_otel_payload(
            [
                make_span(
                    "aa" * 16,
                    "bb" * 8,
                    attributes=[
                        make_attr("gen_ai.request.model", "claude-opus-4-7"),
                        make_attr("llm.token_count.prompt", 1000),
                        make_attr("llm.token_count.completion", 0),
                        make_attr("llm.token_count.prompt_details.cache_write", 900),
                        make_attr("gen_ai.usage.cache_creation.ephemeral_1h_input_tokens", 600),
                    ],
                )
            ],
            scope_name="openinference.instrumentation.anthropic",
        )
        with patch("worker.tokens.pricing.get_model_price", return_value=prices):
            _, spans = transform_otel_to_clickhouse(payload, "proj-1")

        ud = spans[0]["usage_details"]
        assert ud["cache_write_tokens"] == 900
        assert ud["cache_write_1h_tokens"] == 600
        expected = 100 * prices["input"] + 300 * prices["cacheWrite"] + 600 * prices["cacheWrite1h"]
        assert spans[0]["cost"] == pytest.approx(expected)

    def test_no_1h_portion_omits_key_and_prices_at_combined_rate(self):
        """Regression guard: a span with no 1-hour portion keeps an identical
        usage_details map (key absent, not zero) and the whole write total prices at
        cacheWrite."""
        from unittest.mock import patch

        prices = {
            "input": 0.000005,
            "output": 0.000025,
            "cacheRead": 0.0000005,
            "cacheWrite": 0.00000625,
            "cacheWrite1h": 0.00001,
        }
        payload = make_otel_payload(
            [
                make_span(
                    "aa" * 16,
                    "bb" * 8,
                    attributes=[
                        make_attr("gen_ai.request.model", "claude-opus-4-7"),
                        make_attr("llm.token_count.prompt", 1000),
                        make_attr("llm.token_count.completion", 0),
                        make_attr("llm.token_count.prompt_details.cache_write", 900),
                    ],
                )
            ],
            scope_name="openinference.instrumentation.anthropic",
        )
        with patch("worker.tokens.pricing.get_model_price", return_value=prices):
            _, spans = transform_otel_to_clickhouse(payload, "proj-1")

        ud = spans[0]["usage_details"]
        assert "cache_write_1h_tokens" not in ud
        expected = 100 * prices["input"] + 900 * prices["cacheWrite"]
        assert spans[0]["cost"] == pytest.approx(expected)

    def test_text_estimation_fallback(self):
        """Falls back to text-based token estimation when no API counts."""
        from unittest.mock import patch

        trace_hex = "aa" * 16
        span_hex = "bb" * 8
        payload = make_otel_payload(
            [
                make_span(
                    trace_hex,
                    span_hex,
                    attributes=[
                        make_attr("gen_ai.request.model", "gpt-4o"),
                        make_attr("traceroot.span.input", "Hello world"),
                        make_attr("traceroot.span.output", "Hi there"),
                    ],
                )
            ]
        )
        mock_prices = {"input": 0.0000025, "output": 0.00001}
        with patch("worker.tokens.pricing.get_model_price", return_value=mock_prices):
            _, spans = transform_otel_to_clickhouse(payload, "proj-1")

        # Text estimation should produce some token count
        assert spans[0].get("input_tokens") is not None
        assert spans[0].get("output_tokens") is not None

    def test_openinference_input_output(self):
        trace_hex = "aa" * 16
        span_hex = "bb" * 8
        payload = make_otel_payload(
            [
                make_span(
                    trace_hex,
                    span_hex,
                    attributes=[
                        make_attr("input.value", "oi-input"),
                        make_attr("output.value", "oi-output"),
                    ],
                )
            ]
        )
        _, spans = transform_otel_to_clickhouse(payload, "proj-1")
        assert spans[0]["input"] == "oi-input"
        assert spans[0]["output"] == "oi-output"


# ── get_span_kind: GenAI semconv (pydantic-ai) ──────────────────────────


class TestGetSpanKindGenAI:
    def test_gen_ai_operation_name_chat_is_llm(self):
        assert get_span_kind({"gen_ai.operation.name": "chat"}, None) == "LLM"

    def test_gen_ai_operation_name_text_completion_is_llm(self):
        assert get_span_kind({"gen_ai.operation.name": "text_completion"}, None) == "LLM"

    def test_gen_ai_operation_name_embeddings_is_llm(self):
        assert get_span_kind({"gen_ai.operation.name": "embeddings"}, None) == "LLM"

    def test_gen_ai_operation_name_execute_tool_is_tool(self):
        assert get_span_kind({"gen_ai.operation.name": "execute_tool"}, None) == "TOOL"

    def test_gen_ai_operation_name_unknown_falls_through(self):
        assert get_span_kind({"gen_ai.operation.name": "unknown_op"}, None) == "SPAN"

    def test_infer_from_gen_ai_request_model(self):
        assert get_span_kind({"gen_ai.request.model": "gpt-4o-mini"}, None) == "LLM"

    def test_gen_ai_tool_call_arguments_is_tool(self):
        assert get_span_kind({"gen_ai.tool.call.arguments": '{"city": "NYC"}'}, None) == "TOOL"

    def test_gen_ai_tool_call_result_is_tool(self):
        assert get_span_kind({"gen_ai.tool.call.result": "sunny"}, None) == "TOOL"

    def test_openinference_takes_priority_over_gen_ai_operation(self):
        # openinference.span.kind=AGENT should win even when gen_ai.operation.name=chat
        assert (
            get_span_kind(
                {"openinference.span.kind": "AGENT", "gen_ai.operation.name": "chat"}, None
            )
            == "AGENT"
        )

    def test_traceroot_type_takes_priority_over_gen_ai_operation(self):
        assert (
            get_span_kind(
                {"traceroot.span.type": "SPAN", "gen_ai.operation.name": "execute_tool"}, None
            )
            == "SPAN"
        )


# ── GenAI semconv input/output fallback ────────────────────────────────


class TestGenAIInputOutputFallback:
    def test_gen_ai_input_messages_used_as_input(self):
        trace_hex = "aa" * 16
        span_hex = "bb" * 8
        payload = make_otel_payload(
            [
                make_span(
                    trace_hex,
                    span_hex,
                    attributes=[
                        make_attr("gen_ai.input.messages", '[{"role":"user","content":"hi"}]')
                    ],
                )
            ]
        )
        _, spans = transform_otel_to_clickhouse(payload, "proj-1")
        assert spans[0]["input"] == '[{"role":"user","content":"hi"}]'

    def test_gen_ai_output_messages_used_as_output(self):
        trace_hex = "aa" * 16
        span_hex = "bb" * 8
        payload = make_otel_payload(
            [
                make_span(
                    trace_hex,
                    span_hex,
                    attributes=[
                        make_attr(
                            "gen_ai.output.messages", '[{"role":"assistant","content":"hello"}]'
                        )
                    ],
                )
            ]
        )
        _, spans = transform_otel_to_clickhouse(payload, "proj-1")
        assert spans[0]["output"] == '[{"role":"assistant","content":"hello"}]'

    def test_gen_ai_tool_call_arguments_used_as_input(self):
        trace_hex = "aa" * 16
        span_hex = "bb" * 8
        payload = make_otel_payload(
            [
                make_span(
                    trace_hex,
                    span_hex,
                    attributes=[make_attr("gen_ai.tool.call.arguments", '{"city":"NYC"}')],
                )
            ]
        )
        _, spans = transform_otel_to_clickhouse(payload, "proj-1")
        assert spans[0]["input"] == '{"city":"NYC"}'

    def test_gen_ai_tool_call_result_used_as_output(self):
        trace_hex = "aa" * 16
        span_hex = "bb" * 8
        payload = make_otel_payload(
            [
                make_span(
                    trace_hex,
                    span_hex,
                    attributes=[make_attr("gen_ai.tool.call.result", "sunny, 72F")],
                )
            ]
        )
        _, spans = transform_otel_to_clickhouse(payload, "proj-1")
        assert spans[0]["output"] == "sunny, 72F"

    def test_traceroot_input_takes_priority_over_gen_ai(self):
        trace_hex = "aa" * 16
        span_hex = "bb" * 8
        payload = make_otel_payload(
            [
                make_span(
                    trace_hex,
                    span_hex,
                    attributes=[
                        make_attr("traceroot.span.input", "explicit-input"),
                        make_attr("gen_ai.input.messages", "should-be-ignored"),
                    ],
                )
            ]
        )
        _, spans = transform_otel_to_clickhouse(payload, "proj-1")
        assert spans[0]["input"] == "explicit-input"

    def test_openinference_input_takes_priority_over_gen_ai(self):
        trace_hex = "aa" * 16
        span_hex = "bb" * 8
        payload = make_otel_payload(
            [
                make_span(
                    trace_hex,
                    span_hex,
                    attributes=[
                        make_attr("input.value", "oi-input"),
                        make_attr("gen_ai.input.messages", "should-be-ignored"),
                    ],
                )
            ]
        )
        _, spans = transform_otel_to_clickhouse(payload, "proj-1")
        assert spans[0]["input"] == "oi-input"

    def test_tool_parameters_takes_priority_over_gen_ai_input_messages(self):
        # tool.parameters is OpenInference tier 2; gen_ai.input.messages is GenAI tier 3.
        # They're mutually exclusive in real traces but this guards the ordering.
        trace_hex = "aa" * 16
        span_hex = "bb" * 8
        payload = make_otel_payload(
            [
                make_span(
                    trace_hex,
                    span_hex,
                    attributes=[
                        make_attr("tool.parameters", '{"city":"NYC"}'),
                        make_attr("gen_ai.input.messages", "should-be-ignored"),
                    ],
                )
            ]
        )
        _, spans = transform_otel_to_clickhouse(payload, "proj-1")
        assert spans[0]["input"] == '{"city":"NYC"}'

    def test_openinference_tool_parameters_used_as_input(self):
        # OpenInference maps pydantic-ai tool_arguments → tool.parameters
        trace_hex = "aa" * 16
        span_hex = "bb" * 8
        payload = make_otel_payload(
            [
                make_span(
                    trace_hex,
                    span_hex,
                    attributes=[make_attr("tool.parameters", '{"symbol":"AAPL"}')],
                )
            ]
        )
        _, spans = transform_otel_to_clickhouse(payload, "proj-1")
        assert spans[0]["input"] == '{"symbol":"AAPL"}'

    def test_openinference_tool_response_used_as_output(self):
        # Raw pydantic-ai tool_response before OpenInference maps it to output.value
        trace_hex = "aa" * 16
        span_hex = "bb" * 8
        payload = make_otel_payload(
            [
                make_span(
                    trace_hex,
                    span_hex,
                    attributes=[make_attr("tool_response", '{"price":178.5}')],
                )
            ]
        )
        _, spans = transform_otel_to_clickhouse(payload, "proj-1")
        assert spans[0]["output"] == '{"price":178.5}'

    def test_tool_name_overrides_generic_span_name(self):
        # pydantic-ai emits "running tool"; gen_ai.tool.name should win
        trace_hex = "aa" * 16
        span_hex = "bb" * 8
        payload = make_otel_payload(
            [
                make_span(
                    trace_hex,
                    span_hex,
                    name="running tool",
                    attributes=[
                        make_attr("gen_ai.operation.name", "execute_tool"),
                        make_attr("gen_ai.tool.name", "get_stock_price"),
                    ],
                )
            ]
        )
        _, spans = transform_otel_to_clickhouse(payload, "proj-1")
        assert spans[0]["name"] == "get_stock_price"

    def test_non_tool_span_name_not_overridden(self):
        # tool.name present but span is LLM kind — name should not change
        trace_hex = "aa" * 16
        span_hex = "bb" * 8
        payload = make_otel_payload(
            [
                make_span(
                    trace_hex,
                    span_hex,
                    name="chat gpt-4o-mini",
                    attributes=[
                        make_attr("gen_ai.operation.name", "chat"),
                        make_attr("tool.name", "should-be-ignored"),
                    ],
                )
            ]
        )
        _, spans = transform_otel_to_clickhouse(payload, "proj-1")
        assert spans[0]["name"] == "chat gpt-4o-mini"


# ── Falsy-but-present precedence ────────────────────────────────────────


class TestFalsyPrecedence:
    def test_falsy_traceroot_input_wins_over_input_value(self):
        """traceroot.span.input="" must not fall through to input.value."""
        trace_hex = "aa" * 16
        span_hex = "bb" * 8
        payload = make_otel_payload(
            [
                make_span(
                    trace_hex,
                    span_hex,
                    attributes=[
                        make_attr("traceroot.span.input", ""),
                        make_attr("input.value", "fallback"),
                    ],
                )
            ]
        )
        _, spans = transform_otel_to_clickhouse(payload, "proj-1")
        assert spans[0]["input"] == ""

    def test_falsy_input_value_wins_over_gen_ai_input(self):
        """input.value="" must not fall through to gen_ai.input.messages."""
        trace_hex = "aa" * 16
        span_hex = "bb" * 8
        payload = make_otel_payload(
            [
                make_span(
                    trace_hex,
                    span_hex,
                    attributes=[
                        make_attr("input.value", ""),
                        make_attr("gen_ai.input.messages", "fallback"),
                    ],
                )
            ]
        )
        _, spans = transform_otel_to_clickhouse(payload, "proj-1")
        assert spans[0]["input"] == ""

    def test_falsy_traceroot_output_wins_over_output_value(self):
        """traceroot.span.output="" must not fall through to output.value."""
        trace_hex = "aa" * 16
        span_hex = "bb" * 8
        payload = make_otel_payload(
            [
                make_span(
                    trace_hex,
                    span_hex,
                    attributes=[
                        make_attr("traceroot.span.output", ""),
                        make_attr("output.value", "fallback"),
                    ],
                )
            ]
        )
        _, spans = transform_otel_to_clickhouse(payload, "proj-1")
        assert spans[0]["output"] == ""

    def test_falsy_output_value_wins_over_gen_ai_output(self):
        """output.value="" must not fall through to gen_ai.output.messages."""
        trace_hex = "aa" * 16
        span_hex = "bb" * 8
        payload = make_otel_payload(
            [
                make_span(
                    trace_hex,
                    span_hex,
                    attributes=[
                        make_attr("output.value", ""),
                        make_attr("gen_ai.output.messages", "fallback"),
                    ],
                )
            ]
        )
        _, spans = transform_otel_to_clickhouse(payload, "proj-1")
        assert spans[0]["output"] == ""


# ── Cache token metadata preservation ───────────────────────────────────


class TestCacheTokenMetadata:
    """gen_ai.usage.details.cache_* are a fallback alias for the cache buckets.
    Since #958 they are promoted into the usage_details map (cache_read_tokens /
    cache_write_tokens), NOT rescued into metadata. These tests pin that the
    fallback keys land in the columns and stay out of metadata."""

    @staticmethod
    def _llm_attrs(*extra):
        # The cache columns are only populated on a priced LLM span (model +
        # API token counts), so include those alongside the cache detail keys.
        return [
            make_attr("gen_ai.request.model", "claude-3-5-sonnet-20241022"),
            make_attr("gen_ai.usage.input_tokens", 1000),
            make_attr("gen_ai.usage.output_tokens", 200),
            *extra,
        ]

    def test_cache_read_tokens_promoted_to_usage_details(self):
        import json

        payload = make_otel_payload(
            [
                make_span(
                    "aa" * 16,
                    "bb" * 8,
                    attributes=self._llm_attrs(
                        make_attr("gen_ai.usage.details.cache_read_tokens", 128)
                    ),
                )
            ]
        )
        _, spans = transform_otel_to_clickhouse(payload, "proj-1")
        assert spans[0]["usage_details"]["cache_read_tokens"] == 128
        # Not duplicated into metadata.
        metadata = json.loads(spans[0]["metadata"]) if spans[0].get("metadata") else {}
        assert "gen_ai.usage.details.cache_read_tokens" not in metadata

    def test_cache_write_tokens_promoted_to_usage_details(self):
        import json

        payload = make_otel_payload(
            [
                make_span(
                    "aa" * 16,
                    "bb" * 8,
                    attributes=self._llm_attrs(
                        make_attr("gen_ai.usage.details.cache_write_tokens", 64)
                    ),
                )
            ]
        )
        _, spans = transform_otel_to_clickhouse(payload, "proj-1")
        assert spans[0]["usage_details"]["cache_write_tokens"] == 64
        metadata = json.loads(spans[0]["metadata"]) if spans[0].get("metadata") else {}
        assert "gen_ai.usage.details.cache_write_tokens" not in metadata

    def test_both_cache_tokens_promoted_as_integers(self):
        payload = make_otel_payload(
            [
                make_span(
                    "aa" * 16,
                    "bb" * 8,
                    attributes=self._llm_attrs(
                        make_attr("gen_ai.usage.details.cache_read_tokens", 128),
                        make_attr("gen_ai.usage.details.cache_write_tokens", 64),
                    ),
                )
            ]
        )
        _, spans = transform_otel_to_clickhouse(payload, "proj-1")
        assert spans[0]["usage_details"]["cache_read_tokens"] == 128
        assert spans[0]["usage_details"]["cache_write_tokens"] == 64
        assert isinstance(spans[0]["usage_details"]["cache_read_tokens"], int)
        assert isinstance(spans[0]["usage_details"]["cache_write_tokens"], int)

    def test_cache_write_1h_portion_promoted_to_usage_details(self):
        # The optional 1-hour write portion lands in the usage_details map when present.
        payload = make_otel_payload(
            [
                make_span(
                    "aa" * 16,
                    "bb" * 8,
                    attributes=self._llm_attrs(
                        make_attr("llm.token_count.prompt_details.cache_write", 500),
                        make_attr("gen_ai.usage.cache_creation.ephemeral_1h_input_tokens", 300),
                    ),
                )
            ]
        )
        _, spans = transform_otel_to_clickhouse(payload, "proj-1")
        ud = spans[0]["usage_details"]
        assert ud["cache_write_tokens"] == 500
        assert ud["cache_write_1h_tokens"] == 300

    def test_absent_1h_portion_keeps_usage_details_keys_unchanged(self):
        # No 1-hour portion reported (every span today) -> no extra key is added, so the
        # stored map is identical to before this change.
        payload = make_otel_payload(
            [
                make_span(
                    "aa" * 16,
                    "bb" * 8,
                    attributes=self._llm_attrs(
                        make_attr("llm.token_count.prompt_details.cache_write", 500),
                    ),
                )
            ]
        )
        _, spans = transform_otel_to_clickhouse(payload, "proj-1")
        ud = spans[0]["usage_details"]
        assert "cache_write_1h_tokens" not in ud
        assert set(ud) == {"cache_read_tokens", "cache_write_tokens", "reasoning_tokens"}
