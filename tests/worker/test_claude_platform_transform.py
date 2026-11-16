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
from tests.worker.test_otel_transform import (
    make_attr,
    make_otel_payload,
    make_span,
)
from worker.otel_transform import (
    _format_input_with_system_instructions,
    get_span_kind,
    transform_otel_to_clickhouse,
)
from worker.tokens.buckets import normalize_token_usage


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

    def test_tool_name_extracted_from_anthropic_mcp_tool_use(self):
        trace_hex = "11" * 16
        span_hex = "23" * 8
        payload = make_otel_payload(
            [
                make_span(
                    trace_hex,
                    span_hex,
                    name="anthropic.mcp_tool_use",
                    attributes=[
                        make_attr("anthropic.mcp_tool_use.name", "mcp_tool_query"),
                        make_attr("gen_ai.tool.call.arguments", '{"q": "SELECT 1"}'),
                    ],
                )
            ]
        )
        _, spans = transform_otel_to_clickhouse(payload, "p-1")
        assert len(spans) == 1
        assert spans[0]["span_kind"] == SpanKind.TOOL
        assert spans[0]["name"] == "mcp_tool_query"

    def test_span_missing_start_time_skipped(self):
        span = make_span("24" * 16, "13" * 8)
        del span["startTimeUnixNano"]
        _, spans = transform_otel_to_clickhouse(make_otel_payload([span]), "p-1")
        assert len(spans) == 0


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

    def test_system_instructions_plain_text_messages(self):
        trace_hex = "15" * 16
        span_hex = "38" * 8
        payload = make_otel_payload(
            [
                make_span(
                    trace_hex,
                    span_hex,
                    name="anthropic.model_request",
                    attributes=[
                        make_attr("gen_ai.system_instructions", "Be concise."),
                        make_attr("gen_ai.input.messages", "What is the capital of France?"),
                    ],
                )
            ]
        )
        _, spans = transform_otel_to_clickhouse(payload, "p-1")
        assert (
            spans[0]["input"]
            == "System instructions:\nBe concise.\n\nWhat is the capital of France?"
        )

    def test_explicit_traceroot_input_priority_not_augmented(self):
        """Explicit traceroot.span.input wins and is not augmented even if equal to gen_ai.input.messages."""
        trace_hex = "15" * 16
        span_hex = "39" * 8
        payload = make_otel_payload(
            [
                make_span(
                    trace_hex,
                    span_hex,
                    name="anthropic.model_request",
                    attributes=[
                        make_attr("traceroot.span.input", "Exact user prompt"),
                        make_attr("gen_ai.input.messages", "Exact user prompt"),
                        make_attr("gen_ai.system_instructions", "System instructions here"),
                    ],
                )
            ]
        )
        _, spans = transform_otel_to_clickhouse(payload, "p-1")
        # traceroot.span.input had higher precedence, so system instructions should NOT be appended
        assert spans[0]["input"] == "Exact user prompt"

    def test_format_input_helper_edge_cases(self):
        assert _format_input_with_system_instructions(None, "sys") is None
        assert _format_input_with_system_instructions("input", None) == "input"

        # List input
        res_list = _format_input_with_system_instructions(
            [{"role": "user", "content": "hi"}], "sys"
        )
        assert len(res_list) == 2
        assert res_list[0] == {"role": "system", "content": "sys"}

        # Non-str, non-list input
        assert _format_input_with_system_instructions(42, "sys") == 42

        # RecursionError handling
        from unittest.mock import patch

        with patch("json.loads", side_effect=RecursionError("deep recursion")):
            res_rec = _format_input_with_system_instructions('{"nested": true}', "sys")
            assert res_rec == 'System instructions:\nsys\n\n{"nested": true}'

    def test_system_instructions_parts_spec_shape(self):
        """When system_instructions is a JSON array of parts, format with 'parts' key."""
        trace_hex = "15" * 16
        span_hex = "3a" * 8
        parts_json = json.dumps([{"type": "text", "text": "You are a helpful coding assistant."}])
        messages_json = json.dumps([{"role": "user", "content": "Write a test."}])
        payload = make_otel_payload(
            [
                make_span(
                    trace_hex,
                    span_hex,
                    name="anthropic.model_request",
                    attributes=[
                        make_attr("gen_ai.system_instructions", parts_json),
                        make_attr("gen_ai.input.messages", messages_json),
                    ],
                )
            ]
        )
        _, spans = transform_otel_to_clickhouse(payload, "p-1")
        parsed_input = json.loads(spans[0]["input"])
        assert len(parsed_input) == 2
        assert parsed_input[0] == {
            "role": "system",
            "parts": [{"type": "text", "text": "You are a helpful coding assistant."}],
        }
        assert parsed_input[1] == {"role": "user", "content": "Write a test."}


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
        eval_attrs = [
            make_attr("anthropic.session.id", "sess-xyz"),
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
            attributes=eval_attrs,
        )
        msg_span_hex = "05" * 8
        span_msg = make_span(
            trace_hex,
            msg_span_hex,
            parent_span_id_hex=turn_span_hex,
            name="anthropic.messages.create",
            attributes=session_attrs,
        )

        payload = make_otel_payload([span_turn, span_model, span_eval, span_msg])

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

        # In-session messages.create should also have suppressed tokens (aggregate wrapper)
        msg_span = span_by_name["anthropic.messages.create"]
        assert "input_tokens" not in msg_span or msg_span.get("input_tokens") is None

        # Model request span should adopt tokens and calculate cost
        model_span = span_by_name["anthropic.model_request"]
        assert model_span.get("input_tokens") == 100
        assert model_span.get("output_tokens") == 50
        assert model_span.get("cost") is not None

        # Outcome evaluation span should also adopt tokens and inherit model
        eval_span = span_by_name["anthropic.session.outcome_evaluation"]
        assert eval_span.get("input_tokens") == 100
        assert eval_span.get("output_tokens") == 50
        assert eval_span.get("model_name") == "claude-sonnet-4-20250514"
        assert eval_span.get("cost") is not None

    def test_messages_api_export_deduplicates_server_and_model_request(self):
        """API export produces SERVER messages.create and child model_request.

        Anthropic's rule is to sum either messages.create or its model_request
        children, never both. messages.create (SERVER) must be suppressed so
        tokens and cost are strictly attributed to model_request without doubling.
        """
        trace_hex = "17" * 16
        server_span_hex = "05" * 8
        model_span_hex = "06" * 8

        msg_attrs = [
            make_attr("gen_ai.request.model", "claude-sonnet-4-20250514"),
            make_attr("gen_ai.usage.input_tokens", 1000),
            make_attr("gen_ai.usage.output_tokens", 200),
        ]

        server_span_dict = make_span(
            trace_hex,
            server_span_hex,
            name="anthropic.messages.create",
            attributes=msg_attrs,
        )
        server_span_dict["kind"] = 2  # SPAN_KIND_SERVER

        model_span_dict = make_span(
            trace_hex,
            model_span_hex,
            parent_span_id_hex=server_span_hex,
            name="anthropic.model_request",
            attributes=msg_attrs,
        )
        model_span_dict["kind"] = 1  # SPAN_KIND_INTERNAL

        payload = make_otel_payload([server_span_dict, model_span_dict])

        from unittest.mock import patch

        mock_prices = {
            "input": 0.000003,
            "output": 0.000015,
            "cacheRead": 0.0000003,
            "cacheWrite": 0.00000375,
        }
        with patch("worker.tokens.pricing.get_model_price", return_value=mock_prices):
            _, spans = transform_otel_to_clickhouse(payload, "p-1")

        server_span = next(s for s in spans if s["span_id"] == server_span_hex)
        model_span = next(s for s in spans if s["span_id"] == model_span_hex)

        # Server span must be suppressed as aggregate wrapper
        assert server_span.get("input_tokens") is None
        assert server_span.get("output_tokens") is None
        assert server_span.get("total_tokens") is None
        assert server_span.get("cost") is None

        # Model request span must report exact usage and pricing
        assert model_span.get("input_tokens") == 1000
        assert model_span.get("output_tokens") == 200
        assert model_span.get("total_tokens") == 1200
        assert model_span.get("cost") is not None

        # Total tokens across trace must be exactly 1200, NOT 2400
        total_trace_tokens = sum(s.get("total_tokens") or 0 for s in spans)
        assert total_trace_tokens == 1200

    def test_sdk_only_messages_create_retains_usage(self):
        """SDK-only users without Console destination export must not lose usage.

        CLIENT span must preserve input/output tokens and cost when no API spans exist.
        """
        trace_hex = "18" * 16
        client_span_hex = "07" * 8

        msg_attrs = [
            make_attr("gen_ai.request.model", "claude-sonnet-4-20250514"),
            make_attr("gen_ai.usage.input_tokens", 1000),
            make_attr("gen_ai.usage.output_tokens", 200),
        ]

        client_span_dict = make_span(
            trace_hex,
            client_span_hex,
            name="anthropic.messages.create",
            attributes=msg_attrs,
        )
        client_span_dict["kind"] = 3  # SPAN_KIND_CLIENT

        payload = make_otel_payload([client_span_dict])

        from unittest.mock import patch

        mock_prices = {
            "input": 0.000003,
            "output": 0.000015,
            "cacheRead": 0.0000003,
            "cacheWrite": 0.00000375,
        }
        with patch("worker.tokens.pricing.get_model_price", return_value=mock_prices):
            _, spans = transform_otel_to_clickhouse(payload, "p-1")

        client_span = spans[0]
        assert client_span.get("input_tokens") == 1000
        assert client_span.get("output_tokens") == 200
        assert client_span.get("total_tokens") == 1200
        assert client_span.get("cost") is not None

    def test_separate_delivery_messages_create_and_model_request_no_double_count(self):
        """Cross-batch delivery: SERVER messages.create in batch 1 and model_request in batch 2.

        Independent of co-batching, SERVER messages.create is an aggregate wrapper
        under Claude Platform export and does not count tokens. Total across both
        batches must be exactly 1200, never 2400.
        """
        trace_hex = "20" * 16
        server_hex = "16" * 8
        model_hex = "17" * 8

        msg_attrs = [
            make_attr("gen_ai.request.model", "claude-sonnet-4-20250514"),
            make_attr("gen_ai.usage.input_tokens", 1000),
            make_attr("gen_ai.usage.output_tokens", 200),
        ]

        server_span = make_span(
            trace_hex,
            server_hex,
            name="anthropic.messages.create",
            attributes=msg_attrs,
        )
        server_span["kind"] = 2  # SPAN_KIND_SERVER

        model_span = make_span(
            trace_hex,
            model_hex,
            parent_span_id_hex=server_hex,
            name="anthropic.model_request",
            attributes=msg_attrs,
        )
        model_span["kind"] = 1  # SPAN_KIND_INTERNAL

        batch1 = make_otel_payload([server_span])
        batch2 = make_otel_payload([model_span])

        from unittest.mock import patch

        mock_prices = {
            "input": 0.000003,
            "output": 0.000015,
            "cacheRead": 0.0000003,
            "cacheWrite": 0.00000375,
        }
        with patch("worker.tokens.pricing.get_model_price", return_value=mock_prices):
            _, spans_b1 = transform_otel_to_clickhouse(batch1, "p-1")
            _, spans_b2 = transform_otel_to_clickhouse(batch2, "p-1")

        s1 = spans_b1[0]
        s2 = spans_b2[0]

        # Batch 1 (server span) has suppressed tokens
        assert s1.get("input_tokens") is None
        assert s1.get("total_tokens") is None
        assert s1.get("cost") is None

        # Batch 2 (model_request) reports usage and cost
        assert s2.get("input_tokens") == 1000
        assert s2.get("output_tokens") == 200
        assert s2.get("total_tokens") == 1200
        assert s2.get("cost") is not None

        # Total across both deliveries
        all_spans = spans_b1 + spans_b2
        assert sum(s.get("total_tokens") or 0 for s in all_spans) == 1200

    def test_outcome_evaluation_without_model_inherits_parent_and_retains_tokens(self):
        """Outcome evaluation has no model attribute but retains tokens and inherits model from turn."""
        trace_hex = "1c" * 16
        turn_hex = "10" * 8
        eval_hex = "11" * 8

        turn_span = make_span(
            trace_hex,
            turn_hex,
            name="anthropic.session.turn",
            attributes=[
                make_attr("anthropic.session.id", "sess-eval-1"),
                make_attr("gen_ai.request.model", "claude-sonnet-4-20250514"),
            ],
        )
        eval_span = make_span(
            trace_hex,
            eval_hex,
            parent_span_id_hex=turn_hex,
            name="anthropic.session.outcome_evaluation",
            attributes=[
                make_attr("anthropic.session.id", "sess-eval-1"),
                make_attr("gen_ai.usage.input_tokens", 500),
                make_attr("gen_ai.usage.output_tokens", 50),
            ],
        )
        payload = make_otel_payload([turn_span, eval_span])

        from unittest.mock import patch

        mock_prices = {
            "input": 0.000003,
            "output": 0.000015,
            "cacheRead": 0.0000003,
            "cacheWrite": 0.00000375,
        }
        with patch("worker.tokens.pricing.get_model_price", return_value=mock_prices):
            _, spans = transform_otel_to_clickhouse(payload, "p-1")

        s_eval = next(s for s in spans if s["span_id"] == eval_hex)
        assert s_eval.get("input_tokens") == 500
        assert s_eval.get("output_tokens") == 50
        assert s_eval.get("total_tokens") == 550
        assert s_eval.get("model_name") == "claude-sonnet-4-20250514"
        assert s_eval.get("cost") is not None

    def test_compaction_inherits_parent_model_and_prices(self):
        """anthropic.compaction span without model inherits parent model and reports cost."""
        trace_hex = "1d" * 16
        req_hex = "12" * 8
        comp_hex = "13" * 8

        req_span = make_span(
            trace_hex,
            req_hex,
            name="anthropic.model_request",
            attributes=[
                make_attr("gen_ai.request.model", "claude-sonnet-4-20250514"),
                make_attr("gen_ai.usage.input_tokens", 1000),
                make_attr("gen_ai.usage.output_tokens", 200),
            ],
        )
        comp_span = make_span(
            trace_hex,
            comp_hex,
            parent_span_id_hex=req_hex,
            name="anthropic.compaction",
            attributes=[
                make_attr("gen_ai.usage.input_tokens", 400),
                make_attr("gen_ai.usage.output_tokens", 100),
            ],
        )
        payload = make_otel_payload([req_span, comp_span])

        from unittest.mock import patch

        mock_prices = {
            "input": 0.000003,
            "output": 0.000015,
            "cacheRead": 0.0000003,
            "cacheWrite": 0.00000375,
        }
        with patch("worker.tokens.pricing.get_model_price", return_value=mock_prices):
            _, spans = transform_otel_to_clickhouse(payload, "p-1")

        s_req = next(s for s in spans if s["span_id"] == req_hex)
        s_comp = next(s for s in spans if s["span_id"] == comp_hex)

        assert s_req.get("total_tokens") == 1200
        assert s_comp.get("input_tokens") == 400
        assert s_comp.get("output_tokens") == 100
        assert s_comp.get("total_tokens") == 500
        assert s_comp.get("model_name") == "claude-sonnet-4-20250514"
        assert s_comp.get("cost") is not None
        assert sum(s.get("total_tokens") or 0 for s in spans) == 1700

    def test_sdk_compaction_usage_absorbed_on_client_span(self):
        """SDK client span absorbs anthropic.usage.compaction.* tokens into input/output tokens."""
        trace_hex = "1e" * 16
        client_hex = "14" * 8

        client_span = make_span(
            trace_hex,
            client_hex,
            name="anthropic.messages.create",
            attributes=[
                make_attr("gen_ai.request.model", "claude-sonnet-4-20250514"),
                make_attr("gen_ai.usage.input_tokens", 1000),
                make_attr("gen_ai.usage.output_tokens", 200),
                make_attr("anthropic.usage.compaction.input_tokens", 400),
                make_attr("anthropic.usage.compaction.output_tokens", 100),
            ],
        )
        client_span["kind"] = 3  # SPAN_KIND_CLIENT
        payload = make_otel_payload(
            [client_span], scope_name="openinference.instrumentation.anthropic"
        )

        from unittest.mock import patch

        mock_prices = {
            "input": 0.000003,
            "output": 0.000015,
            "cacheRead": 0.0000003,
            "cacheWrite": 0.00000375,
        }
        with patch("worker.tokens.pricing.get_model_price", return_value=mock_prices):
            _, spans = transform_otel_to_clickhouse(payload, "p-1")

        s = spans[0]
        assert s.get("input_tokens") == 1400  # 1000 + 400
        assert s.get("output_tokens") == 300  # 200 + 100
        assert s.get("total_tokens") == 1700

    def test_claude_platform_cache_write_pricing(self):
        """Claude Platform cache write with 1h ephemeral cache is priced at $0.00813."""
        trace_hex = "1f" * 16
        model_hex = "15" * 8

        model_span = make_span(
            trace_hex,
            model_hex,
            name="anthropic.model_request",
            attributes=[
                make_attr("gen_ai.request.model", "claude-3-5-sonnet-20241022"),
                make_attr("gen_ai.usage.input_tokens", 1000),
                make_attr("gen_ai.usage.cache_read.input_tokens", 100),
                make_attr("gen_ai.usage.cache_write.input_tokens", 800),
                make_attr("anthropic.usage.cache_creation.ephemeral_1h_input_tokens", 800),
                make_attr("gen_ai.usage.output_tokens", 200),
            ],
        )
        payload = make_otel_payload([model_span])

        from unittest.mock import patch

        mock_prices = {
            "input": 0.000003,
            "output": 0.000015,
            "cacheRead": 0.0000003,
            "cacheWrite": 0.00000375,
            "cacheWrite1h": 0.000006,
        }
        with patch("worker.tokens.pricing.get_model_price", return_value=mock_prices):
            _, spans = transform_otel_to_clickhouse(payload, "p-1")

        s = spans[0]
        assert s["usage_details"]["cache_write_tokens"] == 800
        assert s["usage_details"]["cache_write_1h_tokens"] == 800
        assert s["usage_details"]["cache_read_tokens"] == 100
        assert s["cost"] == 0.00813


class TestClaudePlatformScope:
    def test_com_anthropic_scope_recognized(self):
        """Scope com.anthropic.claude-platform should be recognized without unknown-scope warning."""
        buckets = normalize_token_usage(
            "com.anthropic.claude-platform",
            input_tokens=100,
            output_tokens=50,
            cache_read_tokens=10,
            cache_write_tokens=5,
        )
        assert buckets.input_uncached == 85
        assert buckets.cache_read == 10
        assert buckets.cache_write == 5
