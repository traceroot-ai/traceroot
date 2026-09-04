"""
AWS Bedrock ReAct agent with tool use and TraceRoot observability.

Calls Amazon Bedrock via the Converse API (boto3) with toolConfig, instrumented
with TraceRoot through Integration.BEDROCK (patches boto3's bedrock-runtime
client to trace all LLM call spans).

Usage:
    cp .env.example .env
    pip install -r requirements.txt
    python main.py

Env vars required: TRACEROOT_API_KEY, AWS_REGION, BEDROCK_MODEL_ID
AWS credentials are picked up from the default AWS SDK credential chain
(aws configure / environment variables / instance role).
"""

import json
import logging
import os
from datetime import datetime

from dotenv import find_dotenv, load_dotenv

dotenv_path = find_dotenv()
if dotenv_path:
    load_dotenv(dotenv_path)
else:
    print("No .env file found (find_dotenv returned None).\nUsing process environment variables.")

import boto3

import traceroot
from traceroot import Integration, observe, using_attributes

traceroot.initialize(integrations=[Integration.BEDROCK])

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
    """Get current time."""
    return {"timezone": timezone, "time": datetime.now().strftime("%Y-%m-%d %H:%M:%S")}


TOOLS = {
    "get_weather": get_weather,
    "get_stock_price": get_stock_price,
    "calculate": calculate,
    "get_current_time": get_current_time,
}

# Bedrock Converse API tool specs — each tool is wrapped in {"toolSpec": {...}}
# with inputSchema as {"json": {...}} (NOT Anthropic's flat input_schema shape).
TOOL_SPECS = [
    {
        "toolSpec": {
            "name": "get_weather",
            "description": "Get current weather for a city",
            "inputSchema": {
                "json": {
                    "type": "object",
                    "properties": {"city": {"type": "string", "description": "City name"}},
                    "required": ["city"],
                }
            },
        }
    },
    {
        "toolSpec": {
            "name": "get_stock_price",
            "description": "Get current stock price for a ticker symbol",
            "inputSchema": {
                "json": {
                    "type": "object",
                    "properties": {
                        "symbol": {
                            "type": "string",
                            "description": "Stock ticker symbol (e.g., AAPL)",
                        }
                    },
                    "required": ["symbol"],
                }
            },
        }
    },
    {
        "toolSpec": {
            "name": "calculate",
            "description": "Evaluate a mathematical expression",
            "inputSchema": {
                "json": {
                    "type": "object",
                    "properties": {
                        "expression": {
                            "type": "string",
                            "description": "Math expression (e.g., '2 + 2 * 3')",
                        }
                    },
                    "required": ["expression"],
                }
            },
        }
    },
    {
        "toolSpec": {
            "name": "get_current_time",
            "description": "Get the current date and time",
            "inputSchema": {
                "json": {
                    "type": "object",
                    "properties": {
                        "timezone": {"type": "string", "description": "Timezone (default: UTC)"}
                    },
                }
            },
        }
    },
]


# ---------------------------------------------------------------------------
# Agent
# ---------------------------------------------------------------------------


class ReActAgent:
    """ReAct-style agent using Bedrock's Converse API with tool use."""

    def __init__(self, model: str | None = None):
        self.client = boto3.client("bedrock-runtime", region_name=os.environ["AWS_REGION"])
        self.model = model or os.environ["BEDROCK_MODEL_ID"]
        self.messages: list[dict] = []
        self.system = (
            "You are a helpful AI assistant with access to tools. "
            "Use available tools to gather information, then provide "
            "a clear, comprehensive answer."
        )

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
        self.messages.append({"role": "user", "content": [{"text": query}]})

        for _ in range(5):
            response = self.client.converse(
                modelId=self.model,
                system=[{"text": self.system}],
                toolConfig={"tools": TOOL_SPECS},
                messages=self.messages,
                inferenceConfig={"maxTokens": 4096},
            )

            assistant_content = response["output"]["message"]["content"]

            if response["stopReason"] == "tool_use":
                self.messages.append({"role": "assistant", "content": assistant_content})

                tool_results = []
                for block in assistant_content:
                    if "toolUse" in block:
                        tool_use = block["toolUse"]
                        name = tool_use["name"]
                        tool_input = tool_use["input"]
                        logger.info(f"Tool call: {name}({tool_input})")
                        result = self._execute_tool(name, tool_input)
                        logger.info(f"Tool result: {result}")
                        tool_results.append(
                            {
                                "toolResult": {
                                    "toolUseId": tool_use["toolUseId"],
                                    "content": [{"text": result}],
                                    "status": "success",
                                }
                            }
                        )
                self.messages.append({"role": "user", "content": tool_results})
            else:
                text = "".join(
                    block.get("text", "") for block in assistant_content if "text" in block
                )
                self.messages.append({"role": "assistant", "content": assistant_content})
                return text

        return "I wasn't able to complete this task within the allowed steps."


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

DEMO_QUERIES = [
    "What's the weather in San Francisco and Tokyo? Compare them.",
    "What's NVDA stock price? If it goes up 10%, what would the new price be?",
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
    with using_attributes(user_id="example-user", session_id="bedrock-agent-session"):
        run_demo()
    traceroot.flush()
