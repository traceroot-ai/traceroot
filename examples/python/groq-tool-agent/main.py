"""
Groq Tool Agent — TraceRoot Observability

A ReAct-style agent built with the Groq SDK, instrumented
with TraceRoot via traceroot.initialize(integrations=[Integration.GROQ]).

Env vars required: GROQ_API_KEY, TRACEROOT_API_KEY

Run:
    pip install -r requirements.txt
    python main.py
"""

import json
import logging
from datetime import UTC, datetime

from dotenv import find_dotenv, load_dotenv

dotenv_path = find_dotenv()
if dotenv_path:
    load_dotenv(dotenv_path)
else:
    print("No .env file found (find_dotenv returned None).\nUsing process environment variables.")

from groq import Groq

import traceroot
from traceroot import Integration, observe, using_attributes

traceroot.initialize(integrations=[Integration.GROQ])
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Tools
# ---------------------------------------------------------------------------


@observe(name="get_weather", type="tool")
def get_weather(city: str) -> dict:
    """Get current weather for a city."""
    weather_db = {
        "san francisco": {"temp": 68, "condition": "foggy", "humidity": 75},
        "new york": {"temp": 45, "condition": "cloudy", "humidity": 60},
        "london": {"temp": 52, "condition": "rainy", "humidity": 85},
        "tokyo": {"temp": 72, "condition": "sunny", "humidity": 50},
    }
    data = weather_db.get(city.lower(), {"temp": 70, "condition": "unknown", "humidity": 50})
    return {"city": city, **data}


@observe(name="get_stock_price", type="tool")
def get_stock_price(symbol: str) -> dict:
    """Get stock price for a symbol."""
    stocks = {
        "AAPL": {"price": 178.50, "change": +2.30, "percent": "+1.3%"},
        "GOOGL": {"price": 141.20, "change": -0.80, "percent": "-0.6%"},
        "MSFT": {"price": 378.90, "change": +4.50, "percent": "+1.2%"},
        "NVDA": {"price": 495.20, "change": +12.30, "percent": "+2.5%"},
    }
    data = stocks.get(symbol.upper(), {"price": 0, "change": 0, "percent": "N/A"})
    return {"symbol": symbol.upper(), **data}


@observe(name="calculate", type="tool")
def calculate(expression: str) -> dict:
    """Evaluate a math expression safely using AST parsing."""
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
        raise ValueError(f"Unsupported expression: {ast.dump(node)}")

    try:
        tree = ast.parse(expression, mode="eval")
        result = _eval(tree)
        return {"expression": expression, "result": result}
    except Exception as e:
        return {"error": str(e)}


@observe(name="get_current_time", type="tool")
def get_current_time(timezone: str = "UTC") -> dict:
    """Get current time in the specified timezone."""
    import zoneinfo

    try:
        zone = zoneinfo.ZoneInfo(timezone)
        current_time = datetime.now(zone).strftime("%Y-%m-%d %H:%M:%S")
    except Exception:
        current_time = datetime.now(UTC).strftime("%Y-%m-%d %H:%M:%S")
        timezone = "UTC"
    return {"timezone": timezone, "time": current_time}


TOOLS = {
    "get_weather": get_weather,
    "get_stock_price": get_stock_price,
    "calculate": calculate,
    "get_current_time": get_current_time,
}

TOOL_SCHEMAS = [
    {
        "type": "function",
        "function": {
            "name": "get_weather",
            "description": "Get current weather for a city",
            "parameters": {
                "type": "object",
                "properties": {"city": {"type": "string", "description": "City name"}},
                "required": ["city"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_stock_price",
            "description": "Get current stock price for a ticker symbol",
            "parameters": {
                "type": "object",
                "properties": {
                    "symbol": {"type": "string", "description": "Stock ticker symbol (e.g., AAPL)"}
                },
                "required": ["symbol"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "calculate",
            "description": "Evaluate a mathematical expression",
            "parameters": {
                "type": "object",
                "properties": {
                    "expression": {
                        "type": "string",
                        "description": "Math expression (e.g., '2 + 2 * 3')",
                    }
                },
                "required": ["expression"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_current_time",
            "description": "Get the current date and time",
            "parameters": {
                "type": "object",
                "properties": {
                    "timezone": {"type": "string", "description": "Timezone (default: UTC)"}
                },
            },
        },
    },
]


# ---------------------------------------------------------------------------
# Agent
# ---------------------------------------------------------------------------


class ReActAgent:
    """ReAct-style agent using Groq's tool calling API."""

    def __init__(self, model: str = "llama-3.3-70b-versatile"):
        self.client = Groq()
        self.model = model
        self.messages: list[dict] = [
            {
                "role": "system",
                "content": (
                    "You are a helpful AI assistant with access to tools. "
                    "Use available tools to gather information, then provide "
                    "a clear, comprehensive answer."
                ),
            }
        ]

    @observe(name="execute_tool", type="span")
    def _execute_tool(self, name: str, arguments: dict) -> str:
        if name not in TOOLS:
            return json.dumps({"error": f"Unknown tool: {name}"})
        try:
            return json.dumps(TOOLS[name](**arguments))
        except Exception as e:
            return json.dumps({"error": str(e)})

    @observe(name="agent_turn", type="agent")
    def run(self, query: str) -> str:
        self.messages.append({"role": "user", "content": query})

        for _ in range(5):
            response = self.client.chat.completions.create(
                model=self.model,
                messages=self.messages,
                tools=TOOL_SCHEMAS,
                tool_choice="auto",
            )

            msg = response.choices[0].message

            if msg.tool_calls:
                self.messages.append(msg)

                for tc in msg.tool_calls:
                    args = json.loads(tc.function.arguments)
                    logger.info(f"Tool call: {tc.function.name}({args})")
                    result = self._execute_tool(tc.function.name, args)
                    logger.info(f"Tool result: {result}")
                    self.messages.append(
                        {
                            "role": "tool",
                            "tool_call_id": tc.id,
                            "content": result,
                        }
                    )
            else:
                self.messages.append({"role": "assistant", "content": msg.content})
                return msg.content or ""

        return "I wasn't able to complete this task within the allowed steps."


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

DEMO_QUERIES = [
    "What's the weather in San Francisco and Tokyo? Compare them.",
]


@observe(name="demo_session", type="agent")
def run_demo():
    for i, query in enumerate(DEMO_QUERIES, 1):
        agent = ReActAgent()
        print(f"\n{'=' * 60}")
        print(f"Query {i}: {query}")
        print("=" * 60)
        result = agent.run(query)
        print(f"\nAgent: {result}\n")


if __name__ == "__main__":
    with using_attributes(user_id="example-user", session_id="groq-agent-session"):
        run_demo()
    traceroot.flush()
