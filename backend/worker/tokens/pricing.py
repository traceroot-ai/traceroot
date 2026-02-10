"""Model pricing and cost calculation.

Pricing sources:
- OpenAI: https://openai.com/api/pricing/
- Anthropic: https://www.anthropic.com/pricing#anthropic-api
"""

from decimal import Decimal

from .usage import count_tokens

# Prices in USD per 1M tokens
MODEL_PRICES: dict[str, dict[str, float]] = {
    # OpenAI - https://openai.com/api/pricing/
    "gpt-4o": {"input": 2.50, "output": 10.00},
    "gpt-4o-mini": {"input": 0.15, "output": 0.60},
    "gpt-4-turbo": {"input": 10.00, "output": 30.00},
    "gpt-4": {"input": 30.00, "output": 60.00},
    "gpt-3.5-turbo": {"input": 0.50, "output": 1.50},
    "o1": {"input": 15.00, "output": 60.00},
    "o1-mini": {"input": 3.00, "output": 12.00},
    "o3-mini": {"input": 1.10, "output": 4.40},
    # Anthropic - https://www.anthropic.com/pricing#anthropic-api
    "claude-3-5-sonnet": {"input": 3.00, "output": 15.00},
    "claude-3-5-haiku": {"input": 0.80, "output": 4.00},
    "claude-3-opus": {"input": 15.00, "output": 75.00},
    "claude-3-sonnet": {"input": 3.00, "output": 15.00},
    "claude-3-haiku": {"input": 0.25, "output": 1.25},
    "claude-sonnet-4": {"input": 3.00, "output": 15.00},
}


def get_model_price(model: str) -> dict[str, float] | None:
    """Lookup price for model. Tries exact match, then prefix match."""
    if model in MODEL_PRICES:
        return MODEL_PRICES[model]
    for key in MODEL_PRICES:
        if model.startswith(key):
            return MODEL_PRICES[key]
    return None


def calculate_cost(
    model: str,
    input_text: str | None,
    output_text: str | None,
) -> dict[str, int | float | None]:
    """Calculate token usage and cost.

    Returns:
        Dict with input_tokens, output_tokens, total_tokens, cost.
        Returns empty values if model not found.
    """
    result: dict[str, int | float | None] = {
        "input_tokens": None,
        "output_tokens": None,
        "total_tokens": None,
        "cost": None,
    }

    if not model:
        return result

    input_tokens = count_tokens(input_text, model)
    output_tokens = count_tokens(output_text, model)
    total_tokens = input_tokens + output_tokens

    result["input_tokens"] = input_tokens
    result["output_tokens"] = output_tokens
    result["total_tokens"] = total_tokens

    prices = get_model_price(model)
    if prices:
        # Convert to Decimal for precision
        input_cost = Decimal(input_tokens) * Decimal(str(prices["input"])) / Decimal("1000000")
        output_cost = Decimal(output_tokens) * Decimal(str(prices["output"])) / Decimal("1000000")
        result["cost"] = float(input_cost + output_cost)

    return result
