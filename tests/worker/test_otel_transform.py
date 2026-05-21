"""Unit tests for OTEL → ClickHouse transformation logic."""

import base64
from datetime import datetime

from tests.fixtures.otel_payloads import make_attr, make_otel_payload, make_span
from worker.otel_transform import (
    attributes_to_dict,
    decode_otel_id,
    extract_attribute_value,
    get_span_kind,
    nanos_to_datetime,
    transform_otel_to_clickhouse,
)

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
