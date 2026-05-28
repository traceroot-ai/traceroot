"""Unit tests for model pricing and cost calculation."""

import json
from pathlib import Path
from unittest.mock import patch

import pytest

from worker.tokens.pricing import calculate_cost, get_model_price

MATCHED_MODEL_NAME = "__matched_model_name"

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
        "prices": {
            "input": 0.0000025,
            "output": 0.00001,
            "cacheRead": 0.00000125,
            "cacheWrite": None,
        },
    },
    {
        "model_name": "claude-3-5-sonnet",
        "match_pattern": "(?i)^(anthropic\\/)?(claude-3-5-sonnet)(-[\\d-]+)?$",
        "prices": {
            "input": 0.000003,
            "output": 0.000015,
            "cacheRead": 0.0000003,
            "cacheWrite": 0.00000375,
        },
    },
]


def _mock_load_cache():
    return MOCK_CACHE


def _standard_price_entries() -> list[dict]:
    return json.loads(PRICES_JSON.read_text())


@pytest.fixture(scope="module")
def real_cache() -> list[dict]:
    """Build a pricing cache from the production standard-model-prices.json."""
    entries = _standard_price_entries()
    return [
        {
            "model_name": entry["modelName"],
            "match_pattern": entry["matchPattern"],
            "prices": {
                **entry["prices"],
                MATCHED_MODEL_NAME: entry["modelName"],
            },
        }
        for entry in entries
    ]


OPENAI_MODEL_CASES = [
    ("gpt-5.5", "gpt-5.5"),
    ("openai/gpt-5.5", "gpt-5.5"),
    ("gpt-5.5-pro", "gpt-5.5-pro"),
    ("gpt-5.4", "gpt-5.4"),
    ("gpt-5.4-mini", "gpt-5.4-mini"),
    ("gpt-5.4-nano", "gpt-5.4-nano"),
    ("gpt-5.4-pro", "gpt-5.4-pro"),
    ("gpt-5.2", "gpt-5.2"),
    ("gpt-5.2-pro", "gpt-5.2-pro"),
    ("gpt-5.1", "gpt-5.1"),
    ("gpt-5", "gpt-5"),
    ("gpt-5-mini", "gpt-5-mini"),
    ("gpt-5-nano", "gpt-5-nano"),
    ("gpt-5-pro", "gpt-5-pro"),
    ("gpt-4.1", "gpt-4.1"),
    ("gpt-4.1-mini", "gpt-4.1-mini"),
    ("gpt-4.1-nano", "gpt-4.1-nano"),
    ("gpt-4o", "gpt-4o"),
    ("openai/gpt-4o", "gpt-4o"),
    ("gpt-4o-2024-05-13", "gpt-4o-2024-05-13"),
    ("gpt-4o-mini", "gpt-4o-mini"),
    ("o1", "o1"),
    ("o1-pro", "o1-pro"),
    ("o3-pro", "o3-pro"),
    ("o3", "o3"),
    ("o4-mini", "o4-mini"),
    ("o3-mini", "o3-mini"),
    ("o1-mini", "o1-mini"),
    ("gpt-4-turbo-2024-04-09", "gpt-4-turbo"),
    ("gpt-4-0125-preview", "gpt-4-0125-preview"),
    ("gpt-4-1106-preview", "gpt-4-1106-preview"),
    ("gpt-4-1106-vision-preview", "gpt-4-1106-vision-preview"),
    ("gpt-4-0613", "gpt-4"),
    ("gpt-4-0314", "gpt-4"),
    ("gpt-4-32k", "gpt-4-32k"),
    ("gpt-3.5-turbo", "gpt-3.5-turbo"),
    ("gpt-3.5-turbo-0125", "gpt-3.5-turbo"),
    ("gpt-3.5-turbo-1106", "gpt-3.5-turbo-1106"),
    ("gpt-3.5-turbo-0613", "gpt-3.5-turbo-0613"),
    ("gpt-3.5-0301", "gpt-3.5-0301"),
    ("gpt-3.5-turbo-instruct", "gpt-3.5-turbo-instruct"),
    ("gpt-3.5-turbo-16k-0613", "gpt-3.5-turbo-16k-0613"),
    ("davinci-002", "davinci-002"),
    ("babbage-002", "babbage-002"),
]

GEMINI_MODEL_CASES = [
    ("gemini-3.5-flash", "gemini-3.5-flash"),
    ("google/gemini-3.5-flash", "gemini-3.5-flash"),
    ("models/gemini-3.5-flash", "gemini-3.5-flash"),
    ("gemini-3.1-pro-preview", "gemini-3.1-pro-preview"),
    ("gemini-3.1-pro-preview-customtools", "gemini-3.1-pro-preview"),
    ("gemini-3.1-flash-lite", "gemini-3.1-flash-lite"),
    ("gemini-3.1-flash-lite-preview", "gemini-3.1-flash-lite-preview"),
    ("gemini-3-flash-preview", "gemini-3-flash-preview"),
    ("gemini-2.5-pro", "gemini-2.5-pro"),
    ("gemini-2.5-flash", "gemini-2.5-flash"),
    ("gemini-2.5-flash-lite", "gemini-2.5-flash-lite"),
    ("gemini-2.5-flash-lite-preview-09-2025", "gemini-2.5-flash-lite-preview-09-2025"),
    ("gemini-2.5-computer-use-preview-10-2025", "gemini-2.5-computer-use-preview-10-2025"),
    ("gemini-robotics-er-1.6-preview", "gemini-robotics-er-1.6-preview"),
    ("gemini-2.0-flash", "gemini-2.0-flash"),
    ("gemini-2.0-flash-lite", "gemini-2.0-flash-lite"),
    ("gemini-1.5-flash", "gemini-1.5-flash"),
    ("gemini-1.5-pro", "gemini-1.5-pro"),
]


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


class TestOpenAIModelIds:
    @pytest.mark.parametrize("model_id,expected_name", OPENAI_MODEL_CASES)
    def test_matches_expected_model(self, real_cache, model_id, expected_name):
        with patch("worker.tokens.pricing._load_cache", lambda: real_cache):
            price = get_model_price(model_id)

        assert price is not None, f"{model_id} should match a pricing entry but returned None"
        assert "input" in price and "output" in price
        assert price[MATCHED_MODEL_NAME] == expected_name, (
            f"{model_id} matched a different entry than {expected_name}"
        )

    def test_latest_openai_model_calculates_cost(self, real_cache):
        with patch("worker.tokens.pricing._load_cache", lambda: real_cache):
            result = calculate_cost("gpt-5.5", "Hello world", "Hi there")

        assert result["input_tokens"] is not None
        assert result["input_tokens"] > 0
        assert result["output_tokens"] is not None
        assert result["output_tokens"] > 0
        assert result["cost"] is not None
        assert result["cost"] > 0


class TestGeminiModelIds:
    @pytest.mark.parametrize("model_id,expected_name", GEMINI_MODEL_CASES)
    def test_matches_expected_model(self, real_cache, model_id, expected_name):
        with patch("worker.tokens.pricing._load_cache", lambda: real_cache):
            price = get_model_price(model_id)

        assert price is not None, f"{model_id} should match a pricing entry but returned None"
        assert "input" in price and "output" in price
        assert price[MATCHED_MODEL_NAME] == expected_name, (
            f"{model_id} matched a different entry than {expected_name}"
        )


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

    @patch("worker.tokens.pricing.count_tokens", return_value=25)
    def test_cost_with_prompt_caching(self, mock_count):
        """Verify cost calculation includes cache_read_tokens and cache_write_tokens."""
        # Using claude-3-5-sonnet prices (from MOCK_CACHE above):
        # input=0.000003, output=0.000015, cacheRead=0.0000003, cacheWrite=0.00000375
        result = calculate_cost(
            model="claude-3-5-sonnet",
            input_text="x" * 100,  # about 25 tokens
            output_text="y" * 100,  # about 25 tokens
            cache_read_tokens=10000,
            cache_write_tokens=5000,
        )
        assert result["input_tokens"] == 25
        assert result["output_tokens"] == 25
        assert result["cost"] is not None

        expected_input_cost = 25.0 * 0.000003
        expected_output_cost = 25.0 * 0.000015
        expected_cache_read_cost = 10000 * 0.0000003
        expected_cache_write_cost = 5000 * 0.00000375
        expected_total = (
            expected_input_cost
            + expected_output_cost
            + expected_cache_read_cost
            + expected_cache_write_cost
        )

        assert abs(result["cost"] - expected_total) < 1e-9

    @patch("worker.tokens.pricing.count_tokens", return_value=25)
    def test_cost_with_missing_cache_rates(self, mock_count):
        """Verify None cache pricing rates are safely handled as 0."""
        # gpt-4o has cacheWrite=None
        result = calculate_cost(
            model="gpt-4o",
            input_text="x" * 100,
            output_text="y" * 100,
            cache_read_tokens=1000,
            cache_write_tokens=1000,
        )
        assert result["cost"] is not None
        # Should not crash and should calculate correctly with cacheWrite treated as 0
        expected_input_cost = 25.0 * 0.0000025
        expected_output_cost = 25.0 * 0.00001
        expected_cache_read_cost = 1000 * 0.00000125
        expected_cache_write_cost = 1000 * 0.0
        expected_total = (
            expected_input_cost
            + expected_output_cost
            + expected_cache_read_cost
            + expected_cache_write_cost
        )
        assert abs(result["cost"] - expected_total) < 1e-9


# ---------------------------------------------------------------------------
# Real-JSON tests — guard against pricing patterns drifting from real model IDs
# emitted by AWS Bedrock and Google Vertex AI (issue #877).
# ---------------------------------------------------------------------------


# (model_id, expected modelName) for IDs the worker must price correctly.
CLAUDE_BEDROCK_VERTEX_CASES = [
    ("claude-opus-4-7", "claude-opus-4-7"),
    ("claude-opus-4-7[1m]", "claude-opus-4-7"),
    ("us.anthropic.claude-opus-4-7-20260514-v1:0", "claude-opus-4-7"),
    ("claude-4-7-opus@20260514", "claude-opus-4-7"),
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
