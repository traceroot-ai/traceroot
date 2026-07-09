"""Travel concierge — a multi-agent Microsoft Agent Framework app traced with TraceRoot.

Agent Framework is Microsoft's successor to AutoGen + Semantic Kernel, and its
defining feature is multi-agent orchestration. This example shows a `TravelConcierge`
agent that delegates to two specialist agents exposed as tools via `Agent.as_tool()`:

    TravelConcierge
    ├─ LocalGuide     (tools: get_weather, find_attractions)
    └─ BudgetPlanner  (tools: convert_currency)

TraceRoot auto-instruments the whole thing through Agent Framework's built-in
OpenTelemetry support, so the trace nests exactly like the hierarchy above —
every agent invocation, model call and tool execution is its own span at
https://traceroot.ai.

Usage:
    cp .env.example .env  # then fill in your keys
    uv run --no-project --python 3.13 --with-requirements requirements.txt python main.py

    # or, with a plain virtualenv:
    pip install -r requirements.txt && python main.py
"""

import asyncio
import logging
from typing import Annotated

from dotenv import find_dotenv, load_dotenv
from pydantic import Field

# Load environment variables (TRACEROOT_API_KEY, OPENAI_API_KEY, ...) first.
dotenv_path = find_dotenv()
if dotenv_path:
    load_dotenv(dotenv_path)
else:
    print("No .env file found (find_dotenv returned None).\nUsing process environment variables.")

# Initialize TraceRoot BEFORE importing Agent Framework so the OpenTelemetry
# instrumentation is wired up before the framework emits its first span.
import traceroot
from traceroot import Integration, observe, using_attributes

traceroot.initialize(integrations=[Integration.AGENT_FRAMEWORK])

# Imported after traceroot.initialize() so tracing is already active.
from agent_framework import Agent
from agent_framework.openai import OpenAIChatClient

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("concierge")


# ---------------------------------------------------------------------------
# Tools — plain functions. Agent Framework reads the type hints and the
# Field(description=...) annotations to build the tool schema, and emits an
# `execute_tool` span for every call. We deliberately do NOT add @observe here:
# the framework already traces tool execution, so decorating would double it up.
# ---------------------------------------------------------------------------

# Static stand-ins for real APIs so the example runs without extra credentials.
_WEATHER = {
    "tokyo": "18°C, light rain in the morning clearing to sun by afternoon",
    "kyoto": "16°C, overcast with a cool breeze",
    "osaka": "20°C, sunny and humid",
}
_FX_RATES_TO_USD = {"USD": 1.0, "JPY": 0.0064, "EUR": 1.08, "GBP": 1.27}
_ATTRACTIONS = {
    ("tokyo", "food"): ["Tsukiji Outer Market", "Omoide Yokocho", "a kaiseki dinner in Ginza"],
    ("tokyo", "history"): [
        "Senso-ji Temple",
        "the Imperial Palace East Gardens",
        "Edo-Tokyo Museum",
    ],
    ("kyoto", "history"): ["Kinkaku-ji", "Fushimi Inari Shrine", "Nijo Castle"],
    ("kyoto", "food"): ["Nishiki Market", "a tofu kaiseki lunch", "Pontocho Alley izakayas"],
}


def get_weather(
    city: Annotated[str, Field(description="City name, e.g. 'Tokyo'")],
) -> str:
    """Return a short weather forecast for a city."""
    forecast = _WEATHER.get(city.strip().lower())
    return forecast or f"No forecast on file for {city}; assume mild and partly cloudy."


def find_attractions(
    city: Annotated[str, Field(description="City to find attractions in")],
    interest: Annotated[str, Field(description="Interest category, e.g. 'food' or 'history'")],
) -> str:
    """Suggest a few points of interest in a city for a given interest."""
    spots = _ATTRACTIONS.get((city.strip().lower(), interest.strip().lower()))
    if not spots:
        return f"No curated {interest} spots for {city}; try a local guidebook."
    return ", ".join(spots)


def convert_currency(
    amount: Annotated[float, Field(description="Amount of money to convert")],
    from_currency: Annotated[
        str, Field(description="ISO currency code to convert from, e.g. 'USD'")
    ],
    to_currency: Annotated[str, Field(description="ISO currency code to convert to, e.g. 'JPY'")],
) -> str:
    """Convert an amount between two currencies using static reference rates."""
    src = _FX_RATES_TO_USD.get(from_currency.upper())
    dst = _FX_RATES_TO_USD.get(to_currency.upper())
    if src is None or dst is None:
        return f"Unsupported currency pair {from_currency}->{to_currency}."
    converted = amount * src / dst
    return f"{amount:.2f} {from_currency.upper()} = {converted:.2f} {to_currency.upper()}"


# ---------------------------------------------------------------------------
# Agents — two specialists, one orchestrator that delegates to them.
# ---------------------------------------------------------------------------


def build_concierge() -> Agent:
    """Wire up the specialist agents and the concierge that delegates to them."""
    client = OpenAIChatClient(model="gpt-4o-mini")

    local_guide = Agent(
        client,
        "You are a local guide. Check the weather once and look up attractions once "
        "per interest, then give a specific, concise recommendation. Do not repeat "
        "tool calls you have already made.",
        name="LocalGuide",
        tools=[get_weather, find_attractions],
    )
    budget_planner = Agent(
        client,
        "You are a budget planner. Convert the traveller's budget into the local "
        "currency and suggest a sensible per-activity allocation.",
        name="BudgetPlanner",
        tools=[convert_currency],
    )

    # Agent.as_tool() exposes a whole agent as a callable tool. When the concierge
    # invokes one, it shows up in the trace as a nested agent run with its own
    # tool calls underneath.
    return Agent(
        client,
        "You are TravelConcierge. Plan a great day trip by delegating: ask "
        "local_guide for weather and attraction ideas, and budget_planner for the "
        "money side. Then weave their answers into one short, friendly itinerary.",
        name="TravelConcierge",
        tools=[
            local_guide.as_tool(
                name="local_guide",
                description="Get the weather and attraction ideas for a city and interests.",
                arg_name="request",
                arg_description="What to research, e.g. 'food and history spots in Tokyo + weather'.",
            ),
            budget_planner.as_tool(
                name="budget_planner",
                description="Convert a travel budget to local currency and allocate it.",
                arg_name="request",
                arg_description="The budget task, e.g. 'allocate 200 USD across a day in Tokyo (JPY)'.",
            ),
        ],
    )


DEMO_QUERIES = [
    "I'm spending a day in Tokyo with a 200 USD budget. I love food and history — "
    "plan my day and break the budget down in JPY.",
    "Same idea for Kyoto on a 150 USD budget, focused on history.",
]


@observe(name="demo_session", type="agent")
async def run_demo() -> None:
    """Run the concierge over a couple of trip requests."""
    concierge = build_concierge()

    for i, query in enumerate(DEMO_QUERIES, start=1):
        logger.info("Request %d: %s", i, query)
        response = await concierge.run(query)
        print(f"\n{'=' * 70}\nRequest {i}: {query}\n{'-' * 70}\n{response.text}\n")


if __name__ == "__main__":
    with using_attributes(user_id="example-user", session_id="agent-framework-session"):
        asyncio.run(run_demo())
    traceroot.flush()
