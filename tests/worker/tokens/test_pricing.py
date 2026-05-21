"""Unit tests for model pricing and cost calculation."""

import json
from pathlib import Path
from unittest.mock import patch

import pytest

from worker.tokens.pricing import calculate_cost, get_model_price

PRICES_JSON = (
    Path(__file__).resolve().parents[3]
    / "frontend"
    / "packages"
    / "core"
    / "src"
    / "standard-model-prices.json"
)

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


# ---------------------------------------------------------------------------
# Real-JSON tests — guard against pricing patterns drifting from real model IDs
# emitted by AWS Bedrock and Google Vertex AI (issue #877).
# ---------------------------------------------------------------------------


@pytest.fixture(scope="module")
def real_cache() -> list[dict]:
    """Build a pricing cache from the production standard-model-prices.json."""
    entries = json.loads(PRICES_JSON.read_text())
    return [
        {
            "model_name": e["modelName"],
            "match_pattern": e["matchPattern"],
            "prices": e["prices"],
        }
        for e in entries
    ]


# (model_id, expected modelName) for IDs the worker must price correctly.
CLAUDE_BEDROCK_VERTEX_CASES = [
    # Bedrock — with cross-region inference profile prefixes
    ("us.anthropic.claude-haiku-4-5-20251001-v1:0", "claude-haiku-4-5"),
    ("eu.anthropic.claude-haiku-4-5-20251001-v1:0", "claude-haiku-4-5"),
    ("apac.anthropic.claude-haiku-4-5-20251001-v1:0", "claude-haiku-4-5"),
    ("global.anthropic.claude-haiku-4-5-20251001-v1:0", "claude-haiku-4-5"),
    # Bedrock — no CRIS prefix
    ("anthropic.claude-haiku-4-5-20251001-v1:0", "claude-haiku-4-5"),
    ("us.anthropic.claude-sonnet-4-5-20250929-v1:0", "claude-sonnet-4-5"),
    ("us.anthropic.claude-opus-4-5-20251101-v1:0", "claude-opus-4-5"),
    ("us.anthropic.claude-sonnet-4-6-20251015-v1:0", "claude-sonnet-4-6"),
    ("us.anthropic.claude-opus-4-6-20251015-v1:0", "claude-opus-4-6"),
    ("us.anthropic.claude-sonnet-4-20250514-v1:0", "claude-sonnet-4"),
    ("us.anthropic.claude-3-5-sonnet-20241022-v2:0", "claude-3-5-sonnet"),
    ("anthropic.claude-3-5-sonnet-20241022-v2:0", "claude-3-5-sonnet"),
    ("us.anthropic.claude-3-5-haiku-20241022-v1:0", "claude-3-5-haiku"),
    ("anthropic.claude-3-opus-20240229-v1:0", "claude-3-opus"),
    ("anthropic.claude-3-sonnet-20240229-v1:0", "claude-3-sonnet"),
    ("anthropic.claude-3-haiku-20240307-v1:0", "claude-3-haiku"),
    # Vertex AI — number-first ordering for 4.x families, @date separator
    ("claude-4-5-haiku@20251001", "claude-haiku-4-5"),
    ("claude-4-5-sonnet@20250929", "claude-sonnet-4-5"),
    ("claude-4-5-opus@20251101", "claude-opus-4-5"),
    ("claude-4-6-sonnet@20251015", "claude-sonnet-4-6"),
    ("claude-4-6-opus@20251015", "claude-opus-4-6"),
    ("claude-4-sonnet@20250514", "claude-sonnet-4"),
    # Vertex AI — 3.x families keep number-first ordering, @date separator
    ("claude-3-5-sonnet@20241022", "claude-3-5-sonnet"),
    ("claude-3-5-haiku@20241022", "claude-3-5-haiku"),
]


class TestClaudeBedrockAndVertexIds:
    @pytest.mark.parametrize("model_id,expected_name", CLAUDE_BEDROCK_VERTEX_CASES)
    def test_matches_expected_family(self, real_cache, model_id, expected_name):
        with patch("worker.tokens.pricing._load_cache", lambda: real_cache):
            price = get_model_price(model_id)
        assert price is not None, f"{model_id} should match a pricing entry but returned None"
        assert "input" in price and "output" in price

        expected = next(e for e in real_cache if e["model_name"] == expected_name)
        assert price["input"] == expected["prices"]["input"], (
            f"{model_id} matched a different family than {expected_name}"
        )

    def test_unrelated_model_still_none(self, real_cache):
        with patch("worker.tokens.pricing._load_cache", lambda: real_cache):
            assert get_model_price("totally-not-a-real-model-2099") is None
