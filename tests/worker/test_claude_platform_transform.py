"""Unit tests for Claude Platform OpenTelemetry export transformation.

Covers:
- Span kind classification for Claude Platform span names
- Session ID extraction (anthropic.session.id & gen_ai.conversation.id)
- System instructions and input/output parsing
- Token usage deduplication across Claude Platform nested span levels
- Ingestion idempotency for redelivered spans (deduping by trace ID + span ID)
"""

import json

from shared.enums import SpanKind
from tests.worker.test_otel_transform import make_attr, make_otel_payload, make_span
from worker.otel_transform import (
    get_span_kind,
    transform_otel_to_clickhouse,
)


class TestClaudePlatformSpanKind:
    def test_session_turn_is_agent(self):
        # Even if gen_ai.request.model is present, session turn is an AGENT
        span_kind = get_span_kind(
            {"gen_ai.request.model": "claude-sonnet-4-20250514"},
            otel_kind="SPAN_KIND_INTERNAL",
            span_name="anthropic.session.turn",
        )
        assert span_kind == SpanKind.AGENT

    def test_model_request_is_llm(self):
        span_kind = get_span_kind(
            {"gen_ai.request.model": "claude-sonnet-4-20250514"},
            otel_kind="SPAN_KIND_INTERNAL",
            span_name="anthropic.model_request",
        )
        assert span_kind == SpanKind.LLM

    def test_messages_create_is_llm(self):
        span_kind = get_span_kind(
            {},
            otel_kind="SPAN_KIND_SERVER",
            span_name="anthropic.messages.create",
        )
        assert span_kind == SpanKind.LLM

    def test_custom_tool_use_is_tool(self):
        span_kind = get_span_kind(
            {"anthropic.custom_tool_use.name": "calculator"},
            otel_kind="SPAN_KIND_INTERNAL",
            span_name="anthropic.custom_tool_use",
        )
        assert span_kind == SpanKind.TOOL

    def test_mcp_tool_use_is_tool(self):
        span_kind = get_span_kind(
            {"anthropic.mcp_tool_use.name": "fetch_file"},
            otel_kind="SPAN_KIND_INTERNAL",
            span_name="anthropic.mcp_tool_use",
        )
        assert span_kind == SpanKind.TOOL

    def test_session_outcome_evaluation_is_evaluation(self):
        span_kind = get_span_kind(
            {},
            otel_kind="SPAN_KIND_INTERNAL",
            span_name="anthropic.session.outcome_evaluation",
        )
        assert span_kind == SpanKind.EVALUATION

    def test_compaction_is_span(self):
        span_kind = get_span_kind(
            {},
            otel_kind="SPAN_KIND_INTERNAL",
            span_name="anthropic.compaction",
        )
        assert span_kind == SpanKind.SPAN

    def test_tool_name_extracted_from_anthropic_custom_tool_use(self):
        trace_hex = "11" * 16
        span_hex = "22" * 8
        payload = make_otel_payload(
            [
                make_span(
                    trace_hex,
                    span_hex,
                    name="anthropic.custom_tool_use",
                    attributes=[
                        make_attr("anthropic.custom_tool_use.name", "weather_checker"),
                        make_attr("gen_ai.tool.call.arguments", '{"city": "Paris"}'),
                    ],
                )
            ]
        )
        _, spans = transform_otel_to_clickhouse(payload, "p-1")
        assert len(spans) == 1
        assert spans[0]["span_kind"] == SpanKind.TOOL
        assert spans[0]["name"] == "weather_checker"


class TestClaudePlatformSessionId:
    def test_anthropic_session_id_extracted(self):
        trace_hex = "12" * 16
        span_hex = "34" * 8
        payload = make_otel_payload(
            [
                make_span(
                    trace_hex,
                    span_hex,
                    name="anthropic.session.turn",
                    attributes=[
                        make_attr("anthropic.session.id", "claude-sess-999"),
                    ],
                )
            ]
        )
        traces, spans = transform_otel_to_clickhouse(payload, "p-1")
        assert len(traces) == 1
        assert traces[0]["session_id"] == "claude-sess-999"

        # anthropic.session.id should be treated as a known prefix and excluded from extra metadata
        metadata = spans[0].get("metadata")
        if metadata:
            parsed = json.loads(metadata)
            assert "anthropic.session.id" not in parsed

    def test_gen_ai_conversation_id_fallback(self):
        trace_hex = "13" * 16
        span_hex = "35" * 8
        payload = make_otel_payload(
            [
                make_span(
                    trace_hex,
                    span_hex,
                    name="anthropic.messages.create",
                    attributes=[
                        make_attr("gen_ai.conversation.id", "conv-thread-42"),
                    ],
                )
            ]
        )
        traces, _ = transform_otel_to_clickhouse(payload, "p-1")
        assert traces[0]["session_id"] == "conv-thread-42"


class TestClaudePlatformSystemInstructions:
    def test_system_instructions_alone(self):
        trace_hex = "14" * 16
        span_hex = "36" * 8
        payload = make_otel_payload(
            [
                make_span(
                    trace_hex,
                    span_hex,
                    name="anthropic.model_request",
                    attributes=[
                        make_attr("gen_ai.system_instructions", "You are a code reviewer."),
                    ],
                )
            ]
        )
        _, spans = transform_otel_to_clickhouse(payload, "p-1")
        assert spans[0]["input"] == "You are a code reviewer."

    def test_system_instructions_combined_with_input_messages(self):
        trace_hex = "15" * 16
        span_hex = "37" * 8
        messages_json = json.dumps([{"role": "user", "content": "Help me fix this bug."}])
        payload = make_otel_payload(
            [
                make_span(
                    trace_hex,
                    span_hex,
                    name="anthropic.model_request",
                    attributes=[
                        make_attr("gen_ai.system_instructions", "You are an AI assistant."),
                        make_attr("gen_ai.input.messages", messages_json),
                    ],
                )
            ]
        )
        _, spans = transform_otel_to_clickhouse(payload, "p-1")
        parsed_input = json.loads(spans[0]["input"])
        assert len(parsed_input) == 2
        assert parsed_input[0] == {"role": "system", "content": "You are an AI assistant."}
        assert parsed_input[1] == {"role": "user", "content": "Help me fix this bug."}


class TestClaudePlatformTokenDeduplication:
    def test_session_spans_token_deduplication(self):
        """In a session, only model_request and outcome_evaluation count tokens.

        session.turn and messages.create report aggregate counts and must be suppressed.
        """
        trace_hex = "16" * 16
        root_span_hex = "01" * 8
        turn_span_hex = "02" * 8
        model_span_hex = "03" * 8
        eval_span_hex = "04" * 8

        session_attrs = [
            make_attr("anthropic.session.id", "sess-xyz"),
            make_attr("gen_ai.request.model", "claude-sonnet-4-20250514"),
            make_attr("gen_ai.usage.input_tokens", 100),
            make_attr("gen_ai.usage.output_tokens", 50),
        ]

        span_turn = make_span(
            trace_hex,
            turn_span_hex,
            parent_span_id_hex=root_span_hex,
            name="anthropic.session.turn",
            attributes=session_attrs,
        )
        span_model = make_span(
            trace_hex,
            model_span_hex,
            parent_span_id_hex=turn_span_hex,
            name="anthropic.model_request",
            attributes=session_attrs,
        )
        span_eval = make_span(
            trace_hex,
            eval_span_hex,
            parent_span_id_hex=turn_span_hex,
            name="anthropic.session.outcome_evaluation",
            attributes=session_attrs,
        )

        payload = make_otel_payload([span_turn, span_model, span_eval])

        from unittest.mock import patch

        mock_prices = {
            "input": 0.000003,
            "output": 0.000015,
            "cacheRead": 0.0000003,
            "cacheWrite": 0.00000375,
        }
        with patch("worker.tokens.pricing.get_model_price", return_value=mock_prices):
            _, spans = transform_otel_to_clickhouse(payload, "p-1")
        span_by_name = {s["name"]: s for s in spans}

        # Turn span should have suppressed tokens (aggregate wrapper)
        turn_span = span_by_name["anthropic.session.turn"]
        assert "input_tokens" not in turn_span or turn_span.get("input_tokens") is None
        assert "cost" not in turn_span or turn_span.get("cost") is None

        # Model request span should adopt tokens and calculate cost
        model_span = span_by_name["anthropic.model_request"]
        assert model_span.get("input_tokens") == 100
        assert model_span.get("output_tokens") == 50
        assert model_span.get("cost") is not None

        # Outcome evaluation span should also adopt tokens
        eval_span = span_by_name["anthropic.session.outcome_evaluation"]
        assert eval_span.get("input_tokens") == 100
        assert eval_span.get("output_tokens") == 50

    def test_messages_create_client_span_suppressed(self):
        """Outside a session, client span of messages.create duplicates server span."""
        trace_hex = "17" * 16
        client_span_hex = "05" * 8
        server_span_hex = "06" * 8

        msg_attrs = [
            make_attr("gen_ai.request.model", "claude-sonnet-4-20250514"),
            make_attr("gen_ai.usage.input_tokens", 80),
            make_attr("gen_ai.usage.output_tokens", 20),
        ]

        # CLIENT span (from SDK)
        client_span_dict = make_span(
            trace_hex,
            client_span_hex,
            name="anthropic.messages.create",
            attributes=msg_attrs,
        )
        client_span_dict["kind"] = 3  # SPAN_KIND_CLIENT

        # SERVER span (from API export)
        server_span_dict = make_span(
            trace_hex,
            server_span_hex,
            name="anthropic.messages.create",
            attributes=msg_attrs,
        )
        server_span_dict["kind"] = 2  # SPAN_KIND_SERVER

        payload = make_otel_payload([client_span_dict, server_span_dict])

        _, spans = transform_otel_to_clickhouse(payload, "p-1")
        client_span = next(s for s in spans if s["span_id"] == client_span_hex)
        server_span = next(s for s in spans if s["span_id"] == server_span_hex)

        assert client_span.get("input_tokens") is None
        assert server_span.get("input_tokens") == 80


class TestSpanIdempotentDeduplication:
    def test_redelivered_duplicate_spans_deduplicated_in_batch(self):
        trace_hex = "18" * 16
        span_hex = "07" * 8

        # First span arrives in-flight (no end time)
        span_initial = make_span(
            trace_hex,
            span_hex,
            name="anthropic.model_request",
            start_nanos=1_000_000_000_000_000_000,
            end_nanos=0,
            attributes=[
                make_attr("gen_ai.request.model", "claude-sonnet-4-20250514"),
            ],
        )
        # Redelivered span has completed (carries end time and output)
        span_completed = make_span(
            trace_hex,
            span_hex,
            name="anthropic.model_request",
            start_nanos=1_000_000_000_000_000_000,
            end_nanos=1_000_000_001_000_000_000,
            attributes=[
                make_attr("gen_ai.request.model", "claude-sonnet-4-20250514"),
                make_attr("gen_ai.output.messages", '[{"role": "assistant", "content": "Done"}]'),
            ],
        )

        payload = make_otel_payload([span_initial, span_completed])
        _, spans = transform_otel_to_clickhouse(payload, "p-1")

        # Must deduplicate to exactly one span record with the richer updated attributes
        assert len(spans) == 1
        assert spans[0]["span_id"] == span_hex
        assert spans[0]["span_end_time"] is not None
        assert spans[0]["output"] == '[{"role": "assistant", "content": "Done"}]'
