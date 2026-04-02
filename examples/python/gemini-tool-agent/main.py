"""
Gemini ReAct agent with tool use and TraceRoot observability.

Uses the new google.genai SDK (not the deprecated google.generativeai).

Usage:
    cp .env.example .env
    uv run --no-project --python 3.13 --with-requirements requirements.txt python main.py
"""

import json
import logging
import os

from dotenv import find_dotenv, load_dotenv

dotenv_path = find_dotenv()
if dotenv_path:
    load_dotenv(dotenv_path)
else:
    print("No .env file found (find_dotenv returned None).\nUsing process environment variables.")

from google import genai

import traceroot
from traceroot import observe, using_attributes

traceroot.initialize()

client = genai.Client(api_key=os.environ["GEMINI_API_KEY"])

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


TOOLS = {
    "get_weather": get_weather,
    "get_stock_price": get_stock_price,
    "calculate": calculate,
}


# ---------------------------------------------------------------------------
# Agent
# ---------------------------------------------------------------------------


class ReActAgent:
    """ReAct-style agent using Google Gemini's function calling API."""

    def __init__(self, model: str = "gemini-2.5-flash"):
        self.model = model
        self.contents: list = []
        self.system_instruction = (
            "You are a helpful AI assistant with access to tools. "
            "Use available tools to gather information, then provide "
            "a clear, comprehensive answer."
        )
        # Declare tools for Gemini
        self.tools = [
            genai.types.Tool(
                function_declarations=[
                    genai.types.FunctionDeclaration(
                        name="get_weather",
                        description="Get current weather for a city",
                        parameters=genai.types.Schema(
                            type="OBJECT",
                            properties={
                                "city": genai.types.Schema(type="STRING", description="City name"),
                            },
                            required=["city"],
                        ),
                    ),
                    genai.types.FunctionDeclaration(
                        name="get_stock_price",
                        description="Get current stock price for a ticker symbol",
                        parameters=genai.types.Schema(
                            type="OBJECT",
                            properties={
                                "symbol": genai.types.Schema(
                                    type="STRING", description="Stock ticker symbol (e.g., AAPL)"
                                ),
                            },
                            required=["symbol"],
                        ),
                    ),
                    genai.types.FunctionDeclaration(
                        name="calculate",
                        description="Evaluate a mathematical expression",
                        parameters=genai.types.Schema(
                            type="OBJECT",
                            properties={
                                "expression": genai.types.Schema(
                                    type="STRING", description="Math expression (e.g., '2 + 2 * 3')"
                                ),
                            },
                            required=["expression"],
                        ),
                    ),
                ]
            )
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
        self.contents.append(genai.types.Content(role="user", parts=[genai.types.Part(text=query)]))

        for _ in range(5):
            response = client.models.generate_content(
                model=self.model,
                contents=self.contents,
                config=genai.types.GenerateContentConfig(
                    system_instruction=self.system_instruction,
                    tools=self.tools,
                ),
            )

            # Guard against empty candidates (e.g. safety-filtered responses)
            if not response.candidates:
                logger.warning("No candidates returned (response may have been blocked).")
                return "I wasn't able to generate a response."

            # Check for function calls
            function_calls = []
            for part in response.candidates[0].content.parts:
                if part.function_call:
                    function_calls.append(part)

            if not function_calls:
                # No tool calls — extract text
                text_parts = [p.text for p in response.candidates[0].content.parts if p.text]
                self.contents.append(response.candidates[0].content)
                return "\n".join(text_parts)

            # Add model response to history
            self.contents.append(response.candidates[0].content)

            # Execute tools and send results back
            tool_response_parts = []
            for part in function_calls:
                fc = part.function_call
                name = fc.name
                args = dict(fc.args)
                logger.info(f"Tool call: {name}({args})")
                result_str = self._execute_tool(name, args)
                logger.info(f"Tool result: {result_str}")
                result_dict = json.loads(result_str)

                tool_response_parts.append(
                    genai.types.Part(
                        function_response=genai.types.FunctionResponse(
                            name=name,
                            response=result_dict,
                        )
                    )
                )

            self.contents.append(genai.types.Content(role="user", parts=tool_response_parts))

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
    with using_attributes(user_id="example-user", session_id="gemini-agent-session"):
        run_demo()
    traceroot.flush()
