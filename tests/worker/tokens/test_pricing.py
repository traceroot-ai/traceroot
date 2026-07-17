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
    ("gpt-5.6-sol", "gpt-5.6-sol"),
    ("openai/gpt-5.6-sol", "gpt-5.6-sol"),
    ("azure/gpt-5.6-sol", "gpt-5.6-sol"),
    ("gpt-5.6-sol-2026-07-09", "gpt-5.6-sol"),
    ("gpt-5.6-terra", "gpt-5.6-terra"),
    ("openai/gpt-5.6-terra", "gpt-5.6-terra"),
    ("azure/gpt-5.6-terra", "gpt-5.6-terra"),
    ("gpt-5.6-luna", "gpt-5.6-luna"),
    ("openai/gpt-5.6-luna", "gpt-5.6-luna"),
    ("azure/gpt-5.6-luna", "gpt-5.6-luna"),
    ("gpt-5.5", "gpt-5.5"),
    ("openai/gpt-5.5", "gpt-5.5"),
    ("azure/gpt-5.5", "gpt-5.5"),
    ("gpt-5.5-2026-03-15", "gpt-5.5"),
    ("gpt-5.5-pro", "gpt-5.5-pro"),
    ("azure/gpt-5.5-pro", "gpt-5.5-pro"),
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

GLM_MODEL_CASES = [
    ("glm-5.2", "glm-5.2"),
    ("zai/glm-5.2", "glm-5.2"),
    ("glm-5.1", "glm-5.1"),
    ("zai/glm-5.1", "glm-5.1"),
    ("glm-5", "glm-5"),
    ("zai/glm-5", "glm-5"),
    ("glm-5-turbo", "glm-5-turbo"),
    ("zai/glm-5-turbo", "glm-5-turbo"),
    ("glm-4.7", "glm-4.7"),
    ("zai/glm-4.7", "glm-4.7"),
    ("glm-4.6", "glm-4.6"),
    ("zai/glm-4.6", "glm-4.6"),
    ("glm-4.5", "glm-4.5"),
    ("zai/glm-4.5", "glm-4.5"),
    ("glm-4.5-air", "glm-4.5-air"),
    ("zai/glm-4.5-air", "glm-4.5-air"),
    ("glm-4.5-flash", "glm-4.5-flash"),
]


GEMINI_MODEL_CASES = [
    ("gemini-3.5-flash", "gemini-3.5-flash"),
    ("google/gemini-3.5-flash", "gemini-3.5-flash"),
    ("models/gemini-3.5-flash", "gemini-3.5-flash"),
    ("gemini-3.1-pro-preview", "gemini-3.1-pro-preview"),
    ("gemini-3.1-pro-preview-customtools", "gemini-3.1-pro-preview"),
    ("gemini-3.1-flash-lite", "gemini-3.1-flash-lite"),
    ("gemini-3.1-flash-lite-preview", "gemini-3.1-flash-lite-preview"),
    ("google/gemini-3-flash", "gemini-3-flash-preview"),
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

DEEPSEEK_MODEL_CASES = [
    ("deepseek-v4-flash", "deepseek-v4-flash"),
    ("deepseek/deepseek-v4-flash", "deepseek-v4-flash"),
    ("deepseek-v4-flash-20260424", "deepseek-v4-flash"),
    ("deepseek-chat", "deepseek-v4-flash"),
    ("deepseek-reasoner", "deepseek-v4-flash"),
    ("deepseek-v4-pro", "deepseek-v4-pro"),
    ("deepseek/deepseek-v4-pro", "deepseek-v4-pro"),
    ("deepseek-v4-pro-20260424", "deepseek-v4-pro"),
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


class TestGpt56CachePricing:
    """gpt-5.6 is the first OpenAI family with non-null cacheWrite pricing."""

    @pytest.mark.parametrize("model_name", ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"])
    def test_cache_write_is_1_25x_input_rate(self, real_cache, model_name):
        entry = next(e for e in real_cache if e["model_name"] == model_name)
        assert entry["prices"]["cacheWrite"] == pytest.approx(entry["prices"]["input"] * 1.25)

    @pytest.mark.parametrize("model_name", ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"])
    def test_cache_read_is_90_percent_discount(self, real_cache, model_name):
        entry = next(e for e in real_cache if e["model_name"] == model_name)
        assert entry["prices"]["cacheRead"] == pytest.approx(entry["prices"]["input"] * 0.10)


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


class TestDeepSeekModelIds:
    @pytest.mark.parametrize("model_id,expected_name", DEEPSEEK_MODEL_CASES)
    def test_matches_expected_model(self, real_cache, model_id, expected_name):
        with patch("worker.tokens.pricing._load_cache", lambda: real_cache):
            price = get_model_price(model_id)

        assert price is not None, f"{model_id} should match a pricing entry but returned None"
        assert "input" in price and "output" in price
        assert price[MATCHED_MODEL_NAME] == expected_name, (
            f"{model_id} matched a different entry than {expected_name}"
        )

    def test_deepseek_v4_pro_calculates_cost(self, real_cache):
        with patch("worker.tokens.pricing._load_cache", lambda: real_cache):
            result = calculate_cost("deepseek-v4-pro", "Hello world", "Hi there")

        assert result["input_tokens"] is not None
        assert result["input_tokens"] > 0
        assert result["output_tokens"] is not None
        assert result["output_tokens"] > 0
        assert result["cost"] is not None
        assert result["cost"] > 0


class TestGLMModelIds:
    @pytest.mark.parametrize("model_id,expected_name", GLM_MODEL_CASES)
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


# ---------------------------------------------------------------------------
# Real-JSON tests — guard against pricing patterns drifting from real model IDs
# emitted by AWS Bedrock and Google Vertex AI (issue #877).
# ---------------------------------------------------------------------------


# (model_id, expected modelName) for IDs the worker must price correctly.
CLAUDE_BEDROCK_VERTEX_CASES = [
    # Fable 5 — plain, [1m] variant, anthropic/ prefix, Bedrock (no Vertex reversed-alias)
    ("claude-fable-5", "claude-fable-5"),
    ("claude-fable-5[1m]", "claude-fable-5"),
    ("anthropic/claude-fable-5", "claude-fable-5"),
    ("us.anthropic.claude-fable-5-20260701-v1:0", "claude-fable-5"),
    # Opus 4.8 — plain, [1m] variant, Bedrock, Vertex
    ("claude-opus-4-8", "claude-opus-4-8"),
    ("claude-opus-4-8[1m]", "claude-opus-4-8"),
    ("anthropic/claude-opus-4-8", "claude-opus-4-8"),
    ("us.anthropic.claude-opus-4-8-20260601-v1:0", "claude-opus-4-8"),
    ("eu.anthropic.claude-opus-4-8-20260601-v1:0", "claude-opus-4-8"),
    ("claude-4-8-opus@20260601", "claude-opus-4-8"),
    # Opus 4.7
    ("claude-opus-4-7", "claude-opus-4-7"),
    ("claude-opus-4-7[1m]", "claude-opus-4-7"),
    ("us.anthropic.claude-opus-4-7-20260514-v1:0", "claude-opus-4-7"),
    ("claude-4-7-opus@20260514", "claude-opus-4-7"),
    # Opus 4.6 — [1m] variant (previously missing)
    ("claude-opus-4-6[1m]", "claude-opus-4-6"),
    # Opus 4.5 — [1m] variant (previously missing)
    ("claude-opus-4-5[1m]", "claude-opus-4-5"),
    # Bedrock — with cross-region inference profile prefixes
    ("us.anthropic.claude-haiku-4-5-20251001-v1:0", "claude-haiku-4-5"),
    ("eu.anthropic.claude-haiku-4-5-20251001-v1:0", "claude-haiku-4-5"),
    ("apac.anthropic.claude-haiku-4-5-20251001-v1:0", "claude-haiku-4-5"),
    ("global.anthropic.claude-haiku-4-5-20251001-v1:0", "claude-haiku-4-5"),
    # Bedrock — no CRIS prefix
    ("anthropic.claude-haiku-4-5-20251001-v1:0", "claude-haiku-4-5"),
    ("us.anthropic.claude-sonnet-4-5-20250929-v1:0", "claude-sonnet-4-5"),
    ("us.anthropic.claude-opus-4-5-20251101-v1:0", "claude-opus-4-5"),
    # Sonnet 5 — plain, Bedrock (CRIS + bare), Vertex (@date)
    ("claude-sonnet-5", "claude-sonnet-5"),
    ("anthropic/claude-sonnet-5", "claude-sonnet-5"),
    ("us.anthropic.claude-sonnet-5-20260601-v1:0", "claude-sonnet-5"),
    ("global.anthropic.claude-sonnet-5-20260601-v1:0", "claude-sonnet-5"),
    ("anthropic.claude-sonnet-5-20260601-v1:0", "claude-sonnet-5"),
    ("claude-sonnet-5@20260601", "claude-sonnet-5"),
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
    # Dot-notation versions — gateways (e.g. OpenRouter) spell the version with a
    # dot (4.8) where our slugs use a dash (4-8). Previously matched nothing and
    # recorded $0. Issue #1581.
    ("anthropic/claude-opus-4.8", "claude-opus-4-8"),
    ("claude-opus-4.8", "claude-opus-4-8"),
    ("anthropic/claude-opus-4.7", "claude-opus-4-7"),
    ("anthropic/claude-opus-4.6", "claude-opus-4-6"),
    ("anthropic/claude-opus-4.5", "claude-opus-4-5"),
    ("anthropic/claude-sonnet-4.6", "claude-sonnet-4-6"),
    ("anthropic/claude-sonnet-4.5", "claude-sonnet-4-5"),
    ("anthropic/claude-haiku-4.5", "claude-haiku-4-5"),
    ("anthropic/claude-3.5-sonnet", "claude-3-5-sonnet"),
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


# (model_id, expected fast modelName) — fast is a separately-priced tier that
# must resolve to its OWN rate card, never the standard entry. Issue #1581.
ANTHROPIC_FAST_CASES = [
    ("anthropic/claude-opus-4.8-fast", "claude-opus-4-8-fast"),
    ("anthropic/claude-opus-4-8-fast", "claude-opus-4-8-fast"),
    ("claude-opus-4-8-fast", "claude-opus-4-8-fast"),
    ("anthropic/claude-opus-4.7-fast", "claude-opus-4-7-fast"),
    ("anthropic/claude-opus-4-7-fast", "claude-opus-4-7-fast"),
]


def _prices(cache: list[dict], model_name: str) -> dict:
    return next(e["prices"] for e in cache if e["model_name"] == model_name)


class TestAnthropicFastTier:
    @pytest.mark.parametrize("model_id,expected_name", ANTHROPIC_FAST_CASES)
    def test_fast_matches_its_own_rate_card(self, real_cache, model_id, expected_name):
        with patch("worker.tokens.pricing._load_cache", lambda: real_cache):
            price = get_model_price(model_id)
        assert price is not None, f"{model_id} should match a fast rate card"
        assert price[MATCHED_MODEL_NAME] == expected_name, (
            f"{model_id} matched {price[MATCHED_MODEL_NAME]}, expected {expected_name}"
        )

    def test_standard_traffic_never_hits_a_fast_card(self, real_cache):
        # The critical guard: if a fast pattern swallowed non-fast traffic, 2x
        # usage would bill at 1x — a silent undercharge, worse than the $0 the
        # issue reports (a zero is visible; a half-price invoice is not).
        with patch("worker.tokens.pricing._load_cache", lambda: real_cache):
            for model_id in ("anthropic/claude-opus-4.8", "claude-opus-4-8"):
                price = get_model_price(model_id)
                assert price is not None
                assert price[MATCHED_MODEL_NAME] == "claude-opus-4-8"

    def test_opus_4_8_fast_rates(self, real_cache):
        # Fast Opus 4.8 = 2x standard, verified against Anthropic's pricing page.
        std = _prices(real_cache, "claude-opus-4-8")
        fast = _prices(real_cache, "claude-opus-4-8-fast")
        assert fast["input"] == 1e-05  # $10 / MTok
        assert fast["output"] == 5e-05  # $50 / MTok
        for key in ("input", "output", "cacheRead", "cacheWrite", "cacheWrite1h"):
            assert fast[key] == pytest.approx(std[key] * 2), key

    def test_opus_4_7_fast_is_6x_not_copied_from_4_8(self, real_cache):
        # 4.7's premium is 6x; do NOT copy 4.8's 2x (or vice versa).
        std = _prices(real_cache, "claude-opus-4-7")
        fast = _prices(real_cache, "claude-opus-4-7-fast")
        assert fast["input"] == 3e-05  # $30 / MTok
        assert fast["output"] == 15e-05  # $150 / MTok
        for key in ("input", "output", "cacheRead", "cacheWrite", "cacheWrite1h"):
            assert fast[key] == pytest.approx(std[key] * 6), key

    def test_opus_4_6_has_no_fast_card(self, real_cache):
        # Opus 4.6 is not fast-capable; it must bill standard, not a fast rate.
        assert all(e["model_name"] != "claude-opus-4-6-fast" for e in real_cache)


def test_cost_from_buckets_prices_each_bucket_once():
    from worker.tokens.buckets import TokenBuckets
    from worker.tokens.pricing import cost_from_buckets

    prices = {
        "input": 0.000003,
        "output": 0.000015,
        "cacheRead": 0.0000003,
        "cacheWrite": 0.00000375,
    }
    buckets = TokenBuckets(input_uncached=60, output=50, cache_read=900, cache_write=40)
    expected = 60 * 0.000003 + 50 * 0.000015 + 900 * 0.0000003 + 40 * 0.00000375
    assert cost_from_buckets(prices, buckets) == pytest.approx(expected)


def test_cost_from_buckets_treats_missing_cache_rates_as_zero():
    from worker.tokens.buckets import TokenBuckets
    from worker.tokens.pricing import cost_from_buckets

    # Model with no cache rates (e.g. OpenAI has no cacheWrite).
    prices = {"input": 0.0000025, "output": 0.00001}
    buckets = TokenBuckets(input_uncached=100, output=50, cache_read=900, cache_write=0)
    expected = 100 * 0.0000025 + 50 * 0.00001  # cache_read priced at 0 (no rate)
    assert cost_from_buckets(prices, buckets) == pytest.approx(expected)


def test_cost_from_buckets_returns_none_without_prices():
    from worker.tokens.buckets import TokenBuckets
    from worker.tokens.pricing import cost_from_buckets

    buckets = TokenBuckets(input_uncached=100, output=50, cache_read=0, cache_write=0)
    assert cost_from_buckets(None, buckets) is None
    assert cost_from_buckets({}, buckets) is None


def test_calculate_cost_matches_cost_from_buckets_for_text_path():
    from worker.tokens.buckets import TokenBuckets
    from worker.tokens.pricing import calculate_cost, cost_from_buckets

    prices = {"input": 0.0000025, "output": 0.00001}
    with patch("worker.tokens.pricing.get_model_price", return_value=prices):
        result = calculate_cost("gpt-4o", "hello world", "hi there")

    in_tok = result["input_tokens"]
    out_tok = result["output_tokens"]
    expected = cost_from_buckets(
        prices, TokenBuckets(input_uncached=in_tok, output=out_tok, cache_read=0, cache_write=0)
    )
    assert result["cost"] == pytest.approx(expected)


def test_cost_breakdown_from_buckets_sums_to_cost_from_buckets():
    from worker.tokens.buckets import TokenBuckets
    from worker.tokens.pricing import cost_breakdown_from_buckets, cost_from_buckets

    prices = {
        "input": 0.000003,
        "output": 0.000015,
        "cacheRead": 0.0000003,
        "cacheWrite": 0.00000375,
    }
    buckets = TokenBuckets(input_uncached=2000, output=1500, cache_read=6000, cache_write=2000)
    breakdown = cost_breakdown_from_buckets(prices, buckets)
    assert breakdown == {
        "input_uncached_cost": pytest.approx(2000 * 0.000003),
        "cache_read_cost": pytest.approx(6000 * 0.0000003),
        "cache_write_cost": pytest.approx(2000 * 0.00000375),
        "output_cost": pytest.approx(1500 * 0.000015),
    }
    assert sum(breakdown.values()) == pytest.approx(cost_from_buckets(prices, buckets))


def test_cost_breakdown_from_buckets_treats_missing_cache_rates_as_zero():
    from worker.tokens.buckets import TokenBuckets
    from worker.tokens.pricing import cost_breakdown_from_buckets

    prices = {"input": 0.0000025, "output": 0.00001}  # OpenAI: no cache rates
    buckets = TokenBuckets(input_uncached=4000, output=1000, cache_read=4000, cache_write=0)
    breakdown = cost_breakdown_from_buckets(prices, buckets)
    assert breakdown["cache_read_cost"] == 0.0
    assert breakdown["cache_write_cost"] == 0.0
    assert breakdown["input_uncached_cost"] == pytest.approx(4000 * 0.0000025)
    assert breakdown["output_cost"] == pytest.approx(1000 * 0.00001)


def test_cost_breakdown_from_buckets_returns_none_without_prices():
    from worker.tokens.buckets import TokenBuckets
    from worker.tokens.pricing import cost_breakdown_from_buckets

    buckets = TokenBuckets(input_uncached=100, output=50)
    assert cost_breakdown_from_buckets(None, buckets) is None
    assert cost_breakdown_from_buckets({}, buckets) is None


# ---------------------------------------------------------------------------
# Cache-write 1-hour portion pricing. The portion is a sub-partition of the
# cache_write total: the 1-hour portion at its own rate, remainder at cacheWrite.
# ---------------------------------------------------------------------------

# opus-4.x-shaped rates: cacheWrite is the 5-minute / default rate (1.25x input);
# cacheWrite1h = 2x input.
TTL_PRICES = {
    "input": 0.000005,
    "output": 0.000025,
    "cacheRead": 0.0000005,
    "cacheWrite": 0.00000625,
    "cacheWrite1h": 0.00001,
}


def test_cache_write_1h_portion_prices_at_its_own_rate():
    from worker.tokens.buckets import TokenBuckets
    from worker.tokens.pricing import cost_from_buckets

    # 900 write tokens: 600 @1h, 300 remainder (priced at cacheWrite).
    buckets = TokenBuckets(cache_write=900, cache_write_1h=600)
    expected = 300 * 0.00000625 + 600 * 0.00001
    assert cost_from_buckets(TTL_PRICES, buckets) == pytest.approx(expected)


def test_cache_write_remainder_prices_at_combined_rate():
    from worker.tokens.buckets import TokenBuckets
    from worker.tokens.pricing import cost_from_buckets

    # 1000 write: 200 @1h, 800 remainder (priced at cacheWrite).
    buckets = TokenBuckets(cache_write=1000, cache_write_1h=200)
    expected = 200 * 0.00001 + 800 * 0.00000625
    assert cost_from_buckets(TTL_PRICES, buckets) == pytest.approx(expected)


def test_cost_from_buckets_caps_unreconciled_1h():
    # Defense-in-depth: _bucket_cost_terms is the single source of truth, so a
    # hand-built bucket that over-reports the 1-hour portion (1h > cache_write) must
    # still price at most the write total — never double-count.
    from worker.tokens.buckets import TokenBuckets
    from worker.tokens.pricing import cost_from_buckets

    over = TokenBuckets(cache_write=100, cache_write_1h=180)
    capped = TokenBuckets(cache_write=100, cache_write_1h=100)
    assert cost_from_buckets(TTL_PRICES, over) == pytest.approx(
        cost_from_buckets(TTL_PRICES, capped)
    )
    # Never exceeds pricing the whole write total at the 1h rate.
    assert cost_from_buckets(TTL_PRICES, over) <= 100 * TTL_PRICES["cacheWrite1h"]


def test_negative_cache_write_total_never_prices_negative():
    # A malformed negative total must clamp to 0, never produce a negative cost
    # (the total is clamped non-negative before the split math, matching the TS helper).
    from worker.tokens.buckets import TokenBuckets
    from worker.tokens.pricing import cost_from_buckets

    buckets = TokenBuckets(cache_write=-500, cache_write_1h=-200)
    assert cost_from_buckets(TTL_PRICES, buckets) == pytest.approx(0.0)


def test_negative_counts_never_price_negative_matches_ts():
    # Every count is clamped non-negative before pricing, so a fully-malformed bucket
    # prices to exactly 0 — identical to the TS helper's all-negative case. Guards the
    # Python<->TS parity invariant for negative inputs.
    from worker.tokens.buckets import TokenBuckets
    from worker.tokens.pricing import cost_from_buckets

    buckets = TokenBuckets(
        input_uncached=-100,
        output=-50,
        cache_read=-10,
        cache_write=-900,
        cache_write_1h=-1,
    )
    assert cost_from_buckets(TTL_PRICES, buckets) == pytest.approx(0.0)


def test_cache_write_1h_rate_of_zero_falls_back_to_combined_rate():
    # An explicit cacheWrite1h of 0 is treated as unset and falls back to cacheWrite,
    # matching the TS `|| cacheWriteRate` fallback so the two cost formulas agree.
    from worker.tokens.buckets import TokenBuckets
    from worker.tokens.pricing import cost_from_buckets

    prices = {"input": 0.000005, "output": 0.0, "cacheWrite": 0.00000625, "cacheWrite1h": 0.0}
    buckets = TokenBuckets(cache_write=100, cache_write_1h=40)
    # 40 @1h (-> cacheWrite, since cacheWrite1h is 0) + 60 remainder @cacheWrite.
    expected = 100 * 0.00000625
    assert cost_from_buckets(prices, buckets) == pytest.approx(expected)


def test_cache_write_1h_without_ttl_rate_matches_combined():
    # A 1-hour portion present but the model has no 1h rate (e.g. non-Anthropic): it
    # falls back to cacheWrite, so cost == the pre-split formula.
    from worker.tokens.buckets import TokenBuckets
    from worker.tokens.pricing import cost_from_buckets

    prices = {"input": 0.000003, "output": 0.0, "cacheWrite": 0.00000375}
    split = TokenBuckets(cache_write=500, cache_write_1h=150)
    combined = TokenBuckets(cache_write=500)
    assert cost_from_buckets(prices, split) == pytest.approx(cost_from_buckets(prices, combined))


def test_cache_write_1h_absent_is_byte_identical_to_today():
    # Regression guard: with no 1-hour portion, cache_write_cost == cache_write * cacheWrite.
    from worker.tokens.buckets import TokenBuckets
    from worker.tokens.pricing import cost_breakdown_from_buckets

    buckets = TokenBuckets(input_uncached=10, output=5, cache_read=20, cache_write=300)
    breakdown = cost_breakdown_from_buckets(TTL_PRICES, buckets)
    assert breakdown["cache_write_cost"] == pytest.approx(300 * 0.00000625)


def test_cache_write_1h_breakdown_still_sums_to_total():
    from worker.tokens.buckets import TokenBuckets
    from worker.tokens.pricing import cost_breakdown_from_buckets, cost_from_buckets

    buckets = TokenBuckets(
        input_uncached=100,
        output=50,
        cache_read=200,
        cache_write=300,
        cache_write_1h=180,
    )
    breakdown = cost_breakdown_from_buckets(TTL_PRICES, buckets)
    assert sum(breakdown.values()) == pytest.approx(cost_from_buckets(TTL_PRICES, buckets))
    # cache_write_cost stays one canonical term: the 1-hour portion is priced inside it,
    # never added as extra keys, so the total can't double-count.
    assert set(breakdown) == {
        "input_uncached_cost",
        "cache_read_cost",
        "cache_write_cost",
        "output_cost",
    }


def test_anthropic_entries_have_2x_input_1h_cache_rate():
    # Every Anthropic entry that has a cache-write rate must carry a 1h rate equal
    # to 2x its input rate (Anthropic's platform pricing for 1-hour cache writes).
    anthropic = [e for e in _standard_price_entries() if e.get("provider") == "anthropic"]
    assert anthropic, "expected anthropic entries in the price table"
    for entry in anthropic:
        prices = entry["prices"]
        if prices.get("cacheWrite") is None:
            continue
        assert "cacheWrite1h" in prices, f"{entry['modelName']} missing cacheWrite1h"
        assert prices["cacheWrite1h"] == pytest.approx(prices["input"] * 2), entry["modelName"]
