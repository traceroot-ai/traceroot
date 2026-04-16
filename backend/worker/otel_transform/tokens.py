"""Token usage and cost helpers for OTEL transform."""

from collections.abc import Callable
from dataclasses import dataclass
from decimal import Decimal
from typing import Any


@dataclass
class TokenUsage:
    input_tokens: int
    output_tokens: int
    total_tokens: int


class TokenCalculator:
    """Calculate token usage/cost while keeping transform orchestration simple."""

    def __init__(
        self,
        get_model_price: Callable[[str], dict[str, float] | None] | None = None,
        estimate_usage: Callable[..., dict[str, int | float | None]] | None = None,
    ):
        self._get_model_price = get_model_price
        self._estimate_usage = estimate_usage

    @classmethod
    def from_runtime(cls) -> "TokenCalculator":
        # Imported lazily so test patching remains stable and startup stays fast.
        from worker.tokens import calculate_cost
        from worker.tokens.pricing import get_model_price

        return cls(get_model_price=get_model_price, estimate_usage=calculate_cost)

    @classmethod
    def from_pricing_runtime(cls) -> "TokenCalculator":
        """Load only pricing dependencies for API-reported token usage."""
        from worker.tokens.pricing import get_model_price

        return cls(get_model_price=get_model_price)

    @classmethod
    def from_estimation_runtime(cls) -> "TokenCalculator":
        """Load estimation logic only when fallback token counting is needed."""
        from worker.tokens import calculate_cost

        return cls(estimate_usage=calculate_cost)

    @staticmethod
    def extract_model_name(span_attrs: dict[str, Any]) -> str | None:
        return (
            span_attrs.get("traceroot.llm.model")
            or span_attrs.get("gen_ai.request.model")
            or span_attrs.get("llm.model_name")
        )

    @staticmethod
    def extract_api_tokens(span_attrs: dict[str, Any]) -> TokenUsage | None:
        api_input_tokens = (
            span_attrs.get("llm.token_count.prompt")
            or span_attrs.get("gen_ai.usage.input_tokens")
            or span_attrs.get("gen_ai.usage.prompt_tokens")
        )
        api_output_tokens = (
            span_attrs.get("llm.token_count.completion")
            or span_attrs.get("gen_ai.usage.output_tokens")
            or span_attrs.get("gen_ai.usage.completion_tokens")
        )
        api_total_tokens = span_attrs.get("llm.token_count.total") or span_attrs.get(
            "gen_ai.usage.total_tokens"
        )

        if api_input_tokens is None and api_output_tokens is None:
            return None

        input_tokens = int(api_input_tokens) if api_input_tokens is not None else 0
        output_tokens = int(api_output_tokens) if api_output_tokens is not None else 0
        total_tokens = (
            int(api_total_tokens) if api_total_tokens is not None else input_tokens + output_tokens
        )
        return TokenUsage(
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            total_tokens=total_tokens,
        )

    def _apply_cost_from_prices(
        self,
        span_record: dict[str, Any],
        model_name: str,
        usage: TokenUsage,
    ) -> None:
        if self._get_model_price is None:
            return
        prices = self._get_model_price(model_name)
        if not prices:
            return

        input_cost = Decimal(usage.input_tokens) * Decimal(str(prices.get("input", 0)))
        output_cost = Decimal(usage.output_tokens) * Decimal(str(prices.get("output", 0)))
        span_record["cost"] = float(input_cost + output_cost)

    def apply_api_usage(
        self,
        span_record: dict[str, Any],
        model_name: str,
        api_usage: TokenUsage,
    ) -> None:
        span_record["model_name"] = model_name
        span_record["input_tokens"] = api_usage.input_tokens
        span_record["output_tokens"] = api_usage.output_tokens
        span_record["total_tokens"] = api_usage.total_tokens
        self._apply_cost_from_prices(span_record, model_name, api_usage)

    def apply_estimated_usage(self, span_record: dict[str, Any], model_name: str) -> None:
        if self._estimate_usage is None:
            return

        span_record["model_name"] = model_name
        usage = self._estimate_usage(
            model=model_name,
            input_text=span_record.get("input"),
            output_text=span_record.get("output"),
        )
        if usage["input_tokens"] is not None:
            span_record["input_tokens"] = usage["input_tokens"]
        if usage["output_tokens"] is not None:
            span_record["output_tokens"] = usage["output_tokens"]
        if usage["total_tokens"] is not None:
            span_record["total_tokens"] = usage["total_tokens"]
        if usage["cost"] is not None:
            span_record["cost"] = usage["cost"]

    def apply_usage(self, span_record: dict[str, Any], span_attrs: dict[str, Any]) -> None:
        model_name = self.extract_model_name(span_attrs)
        if not model_name:
            return

        api_usage = self.extract_api_tokens(span_attrs)
        if api_usage is not None:
            self.apply_api_usage(span_record, model_name, api_usage)
            return

        self.apply_estimated_usage(span_record, model_name)
