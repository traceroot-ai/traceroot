"""Tests for user-supplied span cost handling in otel_transform and trace_reader.

Addresses issue #2692:
- Supports finished cost on spans (claude_agent_sdk.total_cost_usd, gen_ai.usage.cost,
  llm.cost, traceroot.llm.cost, and manual usage dict cost).
- Follows "supplied beats computed" precedence over built-in catalog pricing.
- Allows unpriced models to record non-zero costs when supplied.
- Validates and clamps untrusted cost inputs (rejecting negative, NaN, inf, overflow).
- Records cost provenance ("traceroot.cost_source": "supplied") in span metadata.
- Reconciles headline cost and breakdown (addressing #2176).
"""

import json

from rest.services.trace_reader import span_cost_details
from shared.span_attributes import COST_SOURCE, COST_SOURCE_CATALOG, COST_SOURCE_SUPPLIED
from tests.fixtures.otel_payloads import make_attr, make_otel_payload, make_span
from worker.otel_transform import (
    _MAX_PLAUSIBLE_COST,
    parse_supplied_cost,
    transform_otel_to_clickhouse,
)


class TestParseSuppliedCost:
    """parse_supplied_cost safely validates wire-provided numeric dollar amounts."""

    def test_valid_numbers_and_strings(self):
        assert parse_supplied_cost(0.0) == 0.0
        assert parse_supplied_cost(0.0054321) == 0.0054321
        assert parse_supplied_cost(42) == 42.0
        assert parse_supplied_cost("0.0125") == 0.0125
        assert parse_supplied_cost("15") == 15.0

    def test_none_empty_and_boolean_rejected(self):
        assert parse_supplied_cost(None) is None
        assert parse_supplied_cost("") is None
        assert parse_supplied_cost(True) is None
        assert parse_supplied_cost(False) is None

    def test_negative_values_rejected(self):
        assert parse_supplied_cost(-0.01) is None
        assert parse_supplied_cost("-5") is None

    def test_non_finite_values_rejected(self):
        assert parse_supplied_cost(float("nan")) is None
        assert parse_supplied_cost(float("inf")) is None
        assert parse_supplied_cost(float("-inf")) is None
        assert parse_supplied_cost("NaN") is None
        assert parse_supplied_cost("Infinity") is None

    def test_overflow_values_rejected(self):
        assert parse_supplied_cost(_MAX_PLAUSIBLE_COST) is None
        assert parse_supplied_cost(_MAX_PLAUSIBLE_COST + 1) is None
        assert parse_supplied_cost(10**12) is None

    def test_non_numeric_strings_rejected(self):
        assert parse_supplied_cost("free") is None
        assert parse_supplied_cost("N/A") is None
        assert parse_supplied_cost({}) is None
        assert parse_supplied_cost([]) is None


class TestSuppliedCostIngest:
    """Tests for span transformation when caller or instrumentor provides cost."""

    TRACE = "aa" * 16
    SPAN = "bb" * 8

    def _transform(self, span: dict) -> dict:
        _, spans = transform_otel_to_clickhouse(make_otel_payload([span]), "proj-1")
        return spans[0]

    def test_claude_agent_sdk_total_cost_usd_on_unpriced_model(self):
        """Unpriced model records non-zero cost when Claude Agent SDK reports total_cost_usd."""
        span = make_span(self.TRACE, self.SPAN)
        span["attributes"] = [
            make_attr("traceroot.llm.model", "unpriced-custom-model-v1"),
            make_attr("claude_agent_sdk.total_cost_usd", 0.0425),
            make_attr("llm.token_count.prompt", 1500),
            make_attr("llm.token_count.completion", 300),
        ]
        transformed = self._transform(span)
        assert transformed["cost"] == 0.0425
        assert transformed["input_tokens"] == 1500
        assert transformed["output_tokens"] == 300
        assert transformed["total_tokens"] == 1800

        meta = json.loads(transformed["metadata"])
        assert meta.get(COST_SOURCE) == COST_SOURCE_SUPPLIED

    def test_gen_ai_usage_cost_precedence_over_catalog_pricing(self):
        """Supplied cost beats computed catalog pricing (e.g. enterprise discounted rate)."""
        from unittest.mock import patch

        mock_prices = {"input": 0.00001, "output": 0.00003}
        span = make_span(self.TRACE, self.SPAN)
        # gpt-4o is a standard catalog model with non-zero pricing
        span["attributes"] = [
            make_attr("traceroot.llm.model", "gpt-4o"),
            make_attr("gen_ai.usage.cost", 0.000123),  # custom discounted rate
            make_attr("llm.token_count.prompt", 500),
            make_attr("llm.token_count.completion", 100),
        ]
        with patch("worker.tokens.pricing.get_model_price", return_value=mock_prices):
            transformed = self._transform(span)
            # Catalog would compute 500 * 0.00001 + 100 * 0.00003 = 0.008, but supplied cost wins!
            assert transformed["cost"] == 0.000123

            meta = json.loads(transformed["metadata"])
            assert meta.get(COST_SOURCE) == COST_SOURCE_SUPPLIED

    def test_openinference_llm_cost_attribute(self):
        """OpenInference llm.cost attribute is honored on spans."""
        span = make_span(self.TRACE, self.SPAN)
        span["attributes"] = [
            make_attr("llm.model_name", "fine-tuned-llama-3"),
            make_attr("llm.cost", 0.0089),
            make_attr("llm.token_count.prompt", 200),
            make_attr("llm.token_count.completion", 80),
        ]
        transformed = self._transform(span)
        assert transformed["cost"] == 0.0089
        meta = json.loads(transformed["metadata"])
        assert meta.get(COST_SOURCE) == COST_SOURCE_SUPPLIED

    def test_openinference_llm_cost_total_attribute(self):
        """OpenInference semconv 0.1.41 llm.cost.total attribute is honored."""
        span = make_span(self.TRACE, self.SPAN)
        span["attributes"] = [
            make_attr("llm.model_name", "mistral-large"),
            make_attr("llm.cost.total", 0.042),
            make_attr("llm.token_count.prompt", 400),
            make_attr("llm.token_count.completion", 150),
        ]
        transformed = self._transform(span)
        assert transformed["cost"] == 0.042
        meta = json.loads(transformed["metadata"])
        assert meta.get(COST_SOURCE) == COST_SOURCE_SUPPLIED

    def test_openinference_llm_usage_cost_variant(self):
        """Alternative OpenInference llm.usage.cost spelling is honored."""
        span = make_span(self.TRACE, self.SPAN)
        span["attributes"] = [
            make_attr("traceroot.llm.model", "custom-model"),
            make_attr("llm.usage.cost", 0.015),
            make_attr("llm.token_count.prompt", 100),
        ]
        transformed = self._transform(span)
        assert transformed["cost"] == 0.015

    def test_traceroot_llm_cost_attribute(self):
        """Explicit traceroot.llm.cost attribute is honored."""
        span = make_span(self.TRACE, self.SPAN)
        span["attributes"] = [
            make_attr("traceroot.llm.model", "any-model"),
            make_attr("traceroot.llm.cost", 0.035),
            make_attr("llm.token_count.prompt", 300),
        ]
        transformed = self._transform(span)
        assert transformed["cost"] == 0.035

    def test_manual_usage_dict_cost(self):
        """Cost passed in manual usage dict (traceroot.llm.usage) is parsed and adopted."""
        span = make_span(self.TRACE, self.SPAN)
        manual_dict = {
            "input_tokens": 1000,
            "output_tokens": 250,
            "cost": 0.0175,
        }
        span["attributes"] = [
            make_attr("traceroot.llm.model", "my-gateway-model"),
            make_attr("traceroot.llm.usage", json.dumps(manual_dict)),
        ]
        transformed = self._transform(span)
        assert transformed["cost"] == 0.0175
        assert transformed["input_tokens"] == 1000
        assert transformed["output_tokens"] == 250
        meta = json.loads(transformed["metadata"])
        assert meta.get(COST_SOURCE) == COST_SOURCE_SUPPLIED

    def test_supplied_cost_without_token_counts(self):
        """Span with supplied cost but without token counts still gets cost recorded."""
        span = make_span(self.TRACE, self.SPAN)
        span["attributes"] = [
            make_attr("traceroot.llm.model", "custom-service"),
            make_attr("traceroot.llm.cost", 0.055),
        ]
        transformed = self._transform(span)
        assert transformed["cost"] == 0.055
        meta = json.loads(transformed["metadata"])
        assert meta.get(COST_SOURCE) == COST_SOURCE_SUPPLIED

    def test_bad_cost_falls_back_to_catalog_for_priced_model(self):
        """Malformed or negative cost attribute falls back to normal catalog pricing."""
        from unittest.mock import patch

        mock_prices = {"input": 0.00001, "output": 0.00003}
        span = make_span(self.TRACE, self.SPAN)
        span["attributes"] = [
            make_attr("traceroot.llm.model", "gpt-4o"),
            make_attr("claude_agent_sdk.total_cost_usd", -5.0),  # invalid negative
            make_attr("llm.token_count.prompt", 1000),
            make_attr("llm.token_count.completion", 200),
        ]
        with patch("worker.tokens.pricing.get_model_price", return_value=mock_prices):
            transformed = self._transform(span)
            # Negative cost was ignored; catalog pricing calculated cost > 0
            assert transformed.get("cost") is not None
            assert transformed["cost"] > 0
            meta = json.loads(transformed["metadata"])
            assert meta.get(COST_SOURCE) == COST_SOURCE_CATALOG

    def test_bad_cost_on_unpriced_model_stays_none(self):
        """Malformed cost on unpriced model leaves cost as None rather than crashing."""
        span = make_span(self.TRACE, self.SPAN)
        span["attributes"] = [
            make_attr("traceroot.llm.model", "unpriced-model"),
            make_attr("gen_ai.usage.cost", "invalid_cost"),
            make_attr("llm.token_count.prompt", 500),
        ]
        transformed = self._transform(span)
        assert transformed.get("cost") is None

    def test_aggregate_wrapper_does_not_adopt_cost(self):
        """Aggregate wrappers (like invoke_agent) do not adopt child cost."""
        span = make_span(self.TRACE, self.SPAN)
        span["attributes"] = [
            make_attr("gen_ai.operation.name", "invoke_agent"),
            make_attr("gen_ai.usage.cost", 0.50),
        ]
        transformed = self._transform(span)
        assert transformed.get("cost") is None

    def test_malformed_higher_priority_cost_does_not_shadow_valid_lower_priority(self):
        """A malformed higher-priority cost (empty string, negative) does not shadow a valid lower-priority cost."""
        span = make_span(self.TRACE, self.SPAN)
        span["attributes"] = [
            make_attr("traceroot.llm.model", "unpriced-model"),
            make_attr("traceroot.llm.cost", ""),  # malformed higher priority key
            make_attr("claude_agent_sdk.total_cost_usd", -1.0),  # invalid negative
            make_attr("llm.cost", 0.032),  # valid lower priority key
        ]
        transformed = self._transform(span)
        assert transformed["cost"] == 0.032
        meta = json.loads(transformed["metadata"])
        assert meta.get(COST_SOURCE) == COST_SOURCE_SUPPLIED

    def test_sender_provided_cost_source_is_stripped_and_untrusted(self):
        """Callers cannot spoof server-authored traceroot.cost_source provenance."""
        span = make_span(self.TRACE, self.SPAN)
        span["attributes"] = [
            make_attr("traceroot.llm.model", "unpriced-model"),
            make_attr("traceroot.cost_source", "supplied"),  # sender tries to spoof provenance
            # Note: NO valid cost attribute is supplied!
        ]
        transformed = self._transform(span)
        assert transformed.get("cost") is None
        meta = json.loads(transformed["metadata"]) if transformed.get("metadata") else {}
        # Must NOT carry "supplied" when the worker didn't assign a supplied cost
        assert meta.get(COST_SOURCE) != COST_SOURCE_SUPPLIED

    def test_claude_agent_sdk_query_agent_span_does_not_double_count_cost(self):
        """Claude Agent SDK puts total_cost_usd on the ClaudeAgent.query AGENT wrapper span,
        while its child LLM span carries tokens priced by catalog. The AGENT wrapper must
        NOT adopt the cost, avoiding double-counting in trace sum(cost)."""
        from unittest.mock import patch

        mock_prices = {"input": 0.00001, "output": 0.00003}
        agent_span_id = "11" * 8
        llm_span_id = "22" * 8
        agent_span = make_span(self.TRACE, agent_span_id)
        agent_span["name"] = "ClaudeAgent.query"
        agent_span["attributes"] = [
            make_attr("openinference.span.kind", "AGENT"),
            make_attr("claude_agent_sdk.total_cost_usd", 0.03678),
        ]

        llm_span = make_span(self.TRACE, llm_span_id, parent_span_id_hex=agent_span_id)
        llm_span["name"] = "anthropic.messages.create"
        llm_span["attributes"] = [
            make_attr("openinference.span.kind", "LLM"),
            make_attr("traceroot.llm.model", "claude-3-5-sonnet-20241022"),
            make_attr("llm.token_count.prompt", 2000),
            make_attr("llm.token_count.completion", 559),
        ]

        with patch("worker.tokens.pricing.get_model_price", return_value=mock_prices):
            _, transformed = transform_otel_to_clickhouse(
                make_otel_payload([agent_span, llm_span]), "proj-1"
            )

        agent_record = next(s for s in transformed if s["span_id"] == agent_span_id)
        llm_record = next(s for s in transformed if s["span_id"] == llm_span_id)

        # Child LLM span gets priced by catalog
        assert llm_record.get("cost") is not None
        assert llm_record["cost"] > 0

        # Aggregate AGENT span must NOT adopt cost
        assert agent_record.get("cost") is None


class TestSpanCostDetailsSuppression:
    """Verifies that span_cost_details suppresses recomputed breakdown for supplied spans (#2176)."""

    def test_supplied_cost_suppresses_recomputed_breakdown(self):
        """A span with user-supplied cost returns {} so the popup does not contradict headline."""
        details = span_cost_details(
            model_name="gpt-4o",
            input_tokens=1000,
            output_tokens=200,
            usage_details={},
            is_supplied_cost=True,
        )
        assert details == {}

    def test_catalog_cost_still_computes_breakdown(self):
        """Catalog-priced spans continue to return their computed per-category breakdown."""
        from unittest.mock import patch

        mock_prices = {"input": 0.00001, "output": 0.00003}
        with patch("rest.services.trace_reader.get_model_price", return_value=mock_prices):
            details = span_cost_details(
                model_name="gpt-4o",
                input_tokens=1000,
                output_tokens=200,
                usage_details={},
                is_supplied_cost=False,
            )
            assert "input_uncached_cost" in details
            assert "output_cost" in details
            assert details["output_cost"] > 0
