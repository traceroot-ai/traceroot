"""Unit tests for model pricing and cost calculation."""

from unittest.mock import patch

from worker.tokens.pricing import calculate_cost, get_model_price

# Mock data matching the standard-model-prices.json (prices in USD per token)
MOCK_CACHE = [
    {
        "model_name": "gpt-4o",
        "match_pattern": "(?i)^(openai\\/)?(gpt-4o)(-[\\d-]+)?$",
        "prices": {"input": 0.0000025, "output": 0.00001},
    },
    {
        "model_name": "claude-3-5-sonnet",
        "match_pattern": "(?i)^(anthropic\\/)?(claude-3-5-sonnet)(-[\\d-]+)?$",
        "prices": {"input": 0.000003, "output": 0.000015},
    },
]


def _mock_load_cache():
    return MOCK_CACHE


@patch("worker.tokens.pricing._load_cache", _mock_load_cache)
class TestGetModelPrice:
    def test_exact_match(self):
        price = get_model_price("gpt-4o")
        assert price is not None
        assert "input" in price
        assert "output" in price
        assert price["input"] == 0.0000025
        assert price["output"] == 0.00001

    def test_regex_match(self):
        """Versioned model name should match via regex."""
        price = get_model_price("gpt-4o-2024-01-01")
        assert price is not None
        assert price["input"] == 0.0000025

    def test_claude_model(self):
        price = get_model_price("claude-3-5-sonnet")
        assert price is not None
        assert price["input"] == 0.000003
        assert price["output"] == 0.000015

    def test_unknown_model(self):
        assert get_model_price("unknown-model-xyz") is None


@patch("worker.tokens.pricing._load_cache", _mock_load_cache)
class TestCalculateCost:
    def test_known_model_with_text(self):
        result = calculate_cost("gpt-4o", "Hello world", "Hi there")
        assert result["input_tokens"] is not None
        assert result["input_tokens"] > 0
        assert result["output_tokens"] is not None
        assert result["output_tokens"] > 0
        assert result["total_tokens"] == result["input_tokens"] + result["output_tokens"]
        assert result["cost"] is not None
        assert result["cost"] > 0

    def test_none_text_gives_zero_tokens(self):
        result = calculate_cost("gpt-4o", None, None)
        assert result["input_tokens"] == 0
        assert result["output_tokens"] == 0
        assert result["total_tokens"] == 0
        assert result["cost"] == 0.0

    def test_unknown_model_no_cost(self):
        """Unknown model: tokens counted (fallback encoding), but cost is None."""
        result = calculate_cost("unknown-model", "Hello", "World")
        assert result["input_tokens"] is not None
        assert result["input_tokens"] > 0
        assert result["cost"] is None

    def test_empty_model_returns_all_none(self):
        result = calculate_cost("", "Hello", "World")
        assert result["input_tokens"] is None
        assert result["output_tokens"] is None
        assert result["total_tokens"] is None
        assert result["cost"] is None

    def test_cost_precision(self):
        """Verify Decimal math preserves precision."""
        result = calculate_cost("gpt-4o", "x" * 1000, "y" * 1000)
        assert result["cost"] is not None
        # Cost should be a reasonable float, not have floating-point artifacts
        cost_str = f"{result['cost']:.10f}"
        assert "999999" not in cost_str  # No floating-point weirdness
