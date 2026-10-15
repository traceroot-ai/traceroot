"""
Pydantic AI agent with tool use, instrumented with TraceRoot observability.

Pydantic AI has built-in OpenTelemetry support. We configure it to use
TraceRoot's TracerProvider + the OpenInference span processor for
enriched LLM attributes.

Usage:
    cp .env.example .env  # fill in your API keys
    uv run --no-project --python 3.13 --with-requirements requirements.txt python main.py
"""

import asyncio

from dotenv import find_dotenv, load_dotenv

dotenv_path = find_dotenv()
if dotenv_path:
    load_dotenv(dotenv_path)
else:
    print("No .env file found (find_dotenv returned None).\nUsing process environment variables.")

import traceroot
from traceroot import observe, using_attributes

traceroot.initialize()

# Pydantic AI has built-in OTel support — just configure instrumentation_settings
from pydantic_ai import Agent

agent = Agent(
    "openai:gpt-4o-mini",
    system_prompt="You are a helpful assistant with access to tools.",
    instrument=True,  # enable built-in OpenTelemetry tracing
)


@agent.tool_plain
def get_weather(city: str) -> str:
    """Get weather for a city."""
    weather_db = {
        "san francisco": "68°F, foggy, humidity 75%",
        "tokyo": "72°F, sunny, humidity 50%",
        "new york": "45°F, cloudy, humidity 60%",
    }
    return weather_db.get(city.lower(), "Unknown city")


@agent.tool_plain
def get_stock_price(symbol: str) -> str:
    """Get stock price."""
    stocks = {
        "AAPL": "$178.50 (+1.3%)",
        "NVDA": "$495.20 (+2.5%)",
        "GOOGL": "$141.20 (-0.6%)",
    }
    return stocks.get(symbol.upper(), "Unknown symbol")


@agent.tool_plain
def calculate(expression: str) -> str:
    """Evaluate a math expression."""
    import ast
    import operator

    ops = {
        ast.Add: operator.add,
        ast.Sub: operator.sub,
        ast.Mult: operator.mul,
        ast.Div: operator.truediv,
    }

    def _eval(node):
        if isinstance(node, ast.Expression):
            return _eval(node.body)
        if isinstance(node, ast.Constant) and isinstance(node.value, (int, float)):
            return node.value
        if isinstance(node, ast.BinOp) and type(node.op) in ops:
            return ops[type(node.op)](_eval(node.left), _eval(node.right))
        if isinstance(node, ast.UnaryOp) and isinstance(node.op, ast.USub):
            return -_eval(node.operand)
        raise ValueError(f"Unsupported: {ast.dump(node)}")

    try:
        tree = ast.parse(expression, mode="eval")
        return str(_eval(tree))
    except Exception as e:
        return f"Error: {e}"


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

DEMO_QUERIES = [
    "What's the weather in San Francisco and Tokyo? Compare them.",
    "What's NVDA stock price? If it goes up 10%, what would the new price be?",
]


@observe(name="demo_session", type="agent")
async def run_demo():
    results = []
    for query in DEMO_QUERIES:
        print(f"\nQuery: {query}")
        result = await agent.run(query)
        print(f"Answer: {result.output}")
        results.append(result.output)
    return "\n".join(results)


if __name__ == "__main__":
    with using_attributes(user_id="example-user", session_id="pydantic-ai-session"):
        asyncio.run(run_demo())
    traceroot.flush()
