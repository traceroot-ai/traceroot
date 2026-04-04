"""
Gemini ReAct agent with tool use, streaming, and TraceRoot observability.

Usage:
    cp .env.example .env
    pip install -r requirements.txt
    python main.py
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

from google import genai
from google.genai import types

import traceroot
from traceroot import Integration, observe, using_attributes

traceroot.initialize(integrations=[Integration.GEMINI])

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
def get_current_time() -> dict:
    """Get current time in UTC."""
    return {
        "time": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "timezone": "UTC",
    }


TOOLS = {
    "get_weather": get_weather,
    "get_stock_price": get_stock_price,
    "calculate": calculate,
    "get_current_time": get_current_time,
}

TOOL_SCHEMAS = [
    types.FunctionDeclaration(
        name="get_weather",
        description="Get current weather for a city",
        parameters=types.Schema(
            type="OBJECT",
            properties={"city": types.Schema(type="STRING", description="City name")},
            required=["city"],
        ),
    ),
    types.FunctionDeclaration(
        name="get_stock_price",
        description="Get current stock price for a ticker symbol",
        parameters=types.Schema(
            type="OBJECT",
            properties={
                "symbol": types.Schema(
                    type="STRING", description="Stock ticker symbol (e.g., AAPL)"
                )
            },
            required=["symbol"],
        ),
    ),
    types.FunctionDeclaration(
        name="calculate",
        description="Evaluate a mathematical expression",
        parameters=types.Schema(
            type="OBJECT",
            properties={
                "expression": types.Schema(
                    type="STRING", description="Math expression (e.g., '2 + 2 * 3')"
                )
            },
            required=["expression"],
        ),
    ),
    types.FunctionDeclaration(
        name="get_current_time",
        description="Get the current date and time",
        parameters=types.Schema(
            type="OBJECT",
        ),
    ),
]

SYSTEM_INSTRUCTION = (
    "You are a helpful AI assistant with access to tools. "
    "Use available tools to gather information, then provide "
    "a clear, comprehensive answer."
)


# ---------------------------------------------------------------------------
# Agent
# ---------------------------------------------------------------------------


class ReActAgent:
    """ReAct-style agent that reasons and acts in a loop."""

    def __init__(self, model: str = "gemini-2.5-flash"):
        self.client = genai.Client(api_key=os.environ.get("GEMINI_API_KEY"))
        self.model = model
        self.contents: list[types.Content] = []

    @observe(name="execute_tool", type="span")
    def _execute_tool(self, name: str, arguments: dict) -> str:
        if name not in TOOLS:
            return json.dumps({"error": f"Unknown tool: {name}"})
        try:
            return json.dumps(TOOLS[name](**arguments))
        except Exception as e:
            return json.dumps({"error": str(e)})

    @observe(name="llm_completion", type="span")
    def _get_completion(self) -> types.GenerateContentResponse:
        """Get a completion from Gemini."""
        return self.client.models.generate_content(
            model=self.model,
            contents=self.contents,
            config=types.GenerateContentConfig(
                system_instruction=SYSTEM_INSTRUCTION,
                tools=TOOL_SCHEMAS,
            ),
        )

    @observe(name="agent_turn", type="agent")
    def run(self, query: str) -> str:
        # Append user message in Gemini's Content format
        self.contents.append(types.Content(role="user", parts=[types.Part(text=query)]))

        for _ in range(5):
            response = self._get_completion()

            if not response.candidates:
                return response.text or "No response generated."

            candidate = response.candidates[0]
            content = candidate.content

            # Guard against None content
            if content is None or not content.parts:
                return response.text or "No response generated."

            # Collect any text and function calls from the response parts
            text_parts = []
            function_calls = []
            for part in content.parts:
                if part.text:
                    text_parts.append(part.text)
                if part.function_call:
                    function_calls.append(part.function_call)

            # Append model response to history
            self.contents.append(content)

            if not function_calls:
                return "\n".join(text_parts)

            # Execute each tool call and build function response parts
            tool_response_parts = []
            for fc in function_calls:
                args = dict(fc.args)
                logger.info(f"Tool call: {fc.name}({args})")
                result = self._execute_tool(fc.name, args)
                logger.info(f"Tool result: {result}")

                tool_response_parts.append(
                    types.Part(
                        function_response=types.FunctionResponse(
                            name=fc.name,
                            response={"result": json.loads(result)},
                        )
                    )
                )

            # Append all tool results as a single user turn
            self.contents.append(types.Content(role="user", parts=tool_response_parts))

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
    with using_attributes(user_id="example-user", session_id="tool-agent-session"):
        run_demo()
    traceroot.flush()
