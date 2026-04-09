"""
AutoGen multi-agent conversation with tool use and TraceRoot observability.

Usage:
    cp .env.example .env
    pip install -r requirements.txt
    python main.py
"""

import json
import logging
import os
from typing import Annotated

from dotenv import find_dotenv, load_dotenv

dotenv_path = find_dotenv()
if dotenv_path:
    load_dotenv(dotenv_path)
else:
    print("No .env file found. Using process environment variables.")

import autogen
from autogen import register_function

import traceroot
from traceroot import Integration, using_attributes

traceroot.initialize(integrations=[Integration.AUTOGEN, Integration.GOOGLE_GENAI])

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


def get_weather(city: Annotated[str, "City name"]) -> str:
    """Get current weather for a city."""
    weather_db = {
        "san francisco": {"temp": 68, "condition": "foggy", "humidity": 75},
        "new york": {"temp": 45, "condition": "cloudy", "humidity": 60},
        "london": {"temp": 52, "condition": "rainy", "humidity": 85},
        "tokyo": {"temp": 72, "condition": "sunny", "humidity": 50},
    }
    data = weather_db.get(city.lower(), {"temp": 70, "condition": "unknown", "humidity": 50})
    return json.dumps({"city": city, **data})


def calculate(expression: Annotated[str, "Math expression (e.g., '2 + 2 * 3')"]) -> str:
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
        return json.dumps({"expression": expression, "result": result})
    except Exception as e:
        return json.dumps({"error": str(e)})


DEMO_QUERIES = [
    "What's the weather in San Francisco and Tokyo? Compare them.",
    "Calculate 15 multiplied by 24.",
]


def run_demo():
    config_list = [
        {
            "model": "gemini-2.5-flash",
            "api_key": os.environ.get("GEMINI_API_KEY"),
            "api_type": "google",
        }
    ]
    llm_config = {"config_list": config_list, "temperature": 0.0}

    assistant = autogen.AssistantAgent(
        name="assistant",
        system_message="You are a helpful AI assistant. Use the tools provided to answer questions. When you have fully answered the user's request, you must append the word 'TERMINATE' to the very end of your response.",
        llm_config=llm_config,
    )

    executor = autogen.UserProxyAgent(
        name="executor",
        human_input_mode="NEVER",
        code_execution_config=False,
        is_termination_msg=lambda x: (
            x.get("content", "") and x.get("content", "").rstrip().endswith("TERMINATE")
        ),
    )

    register_function(
        get_weather,
        caller=assistant,
        executor=executor,
        name="get_weather",
        description="Get current weather for a city",
    )

    register_function(
        calculate,
        caller=assistant,
        executor=executor,
        name="calculate",
        description="Evaluate a mathematical expression",
    )

    for i, query in enumerate(DEMO_QUERIES, 1):
        print(f"\n{'=' * 60}")
        print(f"Query {i}: {query}")
        print("=" * 60)

        executor.initiate_chat(
            assistant,
            message=query,
            clear_history=True,
            max_turns=10,
        )


if __name__ == "__main__":
    with using_attributes(user_id="example-user", session_id="autogen-session"):
        run_demo()
    traceroot.flush()
