"""
Google ADK agent with tool use and TraceRoot observability.

Uses the Google Agent Development Kit (ADK) which handles the agent loop,
tool execution, and multi-turn conversations automatically.

Usage:
    cp .env.example .env
    uv run --no-project --python 3.13 --with-requirements requirements.txt python main.py
"""

import asyncio
import logging

from dotenv import find_dotenv, load_dotenv

dotenv_path = find_dotenv()
if dotenv_path:
    load_dotenv(dotenv_path)
else:
    print("No .env file found. Using process environment variables.")

import traceroot
from traceroot import Integration, observe, using_attributes

traceroot.initialize(integrations=[Integration.GOOGLE_ADK])

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

from google.adk.agents import Agent
from google.adk.runners import InMemoryRunner
from google.genai import types

# ---------------------------------------------------------------------------
# Tools
# ---------------------------------------------------------------------------


def get_weather(city: str) -> dict:
    """Get current weather for a city."""
    weather_db = {
        "new york": {"temp": 45, "condition": "cloudy", "humidity": 60},
        "san francisco": {"temp": 68, "condition": "foggy", "humidity": 75},
        "london": {"temp": 52, "condition": "rainy", "humidity": 85},
        "tokyo": {"temp": 72, "condition": "sunny", "humidity": 50},
    }
    data = weather_db.get(city.lower(), {"temp": 70, "condition": "unknown", "humidity": 50})
    return {"status": "success", "city": city, **data}


def calculate(expression: str) -> dict:
    """Evaluate a math expression safely."""
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
        raise ValueError(f"Unsupported expression: {ast.dump(node)}")

    try:
        tree = ast.parse(expression, mode="eval")
        result = _eval(tree)
        return {"status": "success", "expression": expression, "result": result}
    except Exception as e:
        return {"status": "error", "error_message": str(e)}


# ---------------------------------------------------------------------------
# Agent
# ---------------------------------------------------------------------------

agent = Agent(
    name="assistant",
    model="gemini-2.5-flash",
    description="Helpful assistant with access to tools.",
    instruction=(
        "You are a helpful AI assistant with access to tools. "
        "Use available tools to gather information, then provide "
        "a clear, comprehensive answer."
    ),
    tools=[get_weather, calculate],
)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

DEMO_QUERIES = [
    "What's the weather in San Francisco and Tokyo? Compare them.",
    "What is 1234 multiplied by 5678?",
]


@observe(name="demo_session", type="agent")
async def run_demo():
    app_name = "traceroot-adk-demo"
    user_id = "example-user"
    session_id = "google-adk-agent-session"

    runner = InMemoryRunner(agent=agent, app_name=app_name)
    session_service = runner.session_service
    await session_service.create_session(
        app_name=app_name,
        user_id=user_id,
        session_id=session_id,
    )

    for i, query in enumerate(DEMO_QUERIES, 1):
        print(f"\n{'=' * 60}")
        print(f"Query {i}: {query}")
        print("=" * 60)

        async for event in runner.run_async(
            user_id=user_id,
            session_id=session_id,
            new_message=types.Content(
                role="user",
                parts=[types.Part(text=query)],
            ),
        ):
            if (
                event.is_final_response()
                and event.content
                and event.content.parts
                and event.content.parts[0].text
            ):
                print(f"\nAgent: {event.content.parts[0].text.strip()}\n")


if __name__ == "__main__":
    with using_attributes(user_id="example-user", session_id="google-adk-agent-session"):
        try:
            asyncio.run(run_demo())
        finally:
            traceroot.flush()
    traceroot.flush()
