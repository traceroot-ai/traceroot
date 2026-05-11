"""
PydanticAI agent with tool use, instrumented with TraceRoot.

Usage:
    cp .env.example .env
    uv run --no-project --python 3.13 --with-requirements requirements.txt python main.py
"""

from dataclasses import dataclass

from dotenv import find_dotenv, load_dotenv

dotenv_path = find_dotenv()
if dotenv_path:
    load_dotenv(dotenv_path)
else:
    print("No .env file found (find_dotenv returned None).\nUsing process environment variables.")

import traceroot
from pydantic_ai import Agent, RunContext
from traceroot import Integration, observe, using_attributes

traceroot.initialize(integrations=[Integration.PYDANTIC_AI])


@dataclass
class WeatherDeps:
    """Dependencies shared across tool calls."""

    weather_by_city: dict[str, dict[str, str | int]]


agent = Agent(
    "openai:gpt-4o-mini",
    deps_type=WeatherDeps,
    system_prompt=(
        "You are a concise weather assistant. Use available tools when needed, "
        "and always include both cities in your response."
    ),
)


@agent.tool
def get_weather(ctx: RunContext[WeatherDeps], city: str) -> str:
    """Return current weather details for a city."""
    data = ctx.deps.weather_by_city.get(
        city.lower(),
        {"temp_f": 70, "condition": "unknown", "humidity_pct": 50},
    )
    return (
        f"{city.title()}: {data['temp_f']}F, {data['condition']}, "
        f"humidity {data['humidity_pct']}%"
    )


@observe(name="pydantic_ai_weather_demo", type="agent")
def run_demo() -> None:
    deps = WeatherDeps(
        weather_by_city={
            "san francisco": {"temp_f": 62, "condition": "foggy", "humidity_pct": 79},
            "new york": {"temp_f": 58, "condition": "cloudy", "humidity_pct": 63},
            "tokyo": {"temp_f": 74, "condition": "sunny", "humidity_pct": 48},
        }
    )

    prompt = "Compare weather in San Francisco and Tokyo, then suggest light clothing."
    result = agent.run_sync(prompt, deps=deps)
    print("\nPrompt:\n", prompt)
    print("\nAgent response:\n", result.output)


if __name__ == "__main__":
    with using_attributes(user_id="example-user", session_id="pydantic-ai-session"):
        try:
            run_demo()
        finally:
            traceroot.flush()
