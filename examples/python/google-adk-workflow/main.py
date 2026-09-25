"""
Google ADK 2.x graph Workflow (fan-out / fan-in) with TraceRoot observability.

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

from google.adk import Agent, Event, Workflow
from google.adk.runners import InMemoryRunner
from google.adk.workflow import JoinNode
from google.genai import types
from pydantic import BaseModel

MODEL = "gemini-3.8-flash"

# ---------------------------------------------------------------------------
# Nodes
# ---------------------------------------------------------------------------


def record_city(node_input: str):
    """Store the city in session state and pass it to the parallel branches."""
    city = node_input.strip()
    return Event(output=city, state={"city": city})


def get_weather(node_input: str) -> dict:
    """Get current weather for a city."""
    weather_db = {
        "new york": {"temp": 45, "condition": "cloudy", "humidity": 60},
        "san francisco": {"temp": 68, "condition": "foggy", "humidity": 75},
        "london": {"temp": 52, "condition": "rainy", "humidity": 85},
        "tokyo": {"temp": 72, "condition": "sunny", "humidity": 50},
    }
    data = weather_db.get(node_input.lower(), {"temp": 70, "condition": "unknown", "humidity": 50})
    return {"city": node_input, **data}


class Attractions(BaseModel):
    attractions: list[str]


find_attractions = Agent(
    name="find_attractions",
    model=MODEL,
    instruction="List three must-see attractions in {city}.",
    output_schema=Attractions,
)

suggest_food = Agent(
    name="suggest_food",
    model=MODEL,
    instruction="In one sentence, name a signature local dish to try in {city}.",
)

# Waits for every branch, then passes a dict keyed by node name to the next node.
gather = JoinNode(name="gather")

write_brief = Agent(
    name="write_brief",
    model=MODEL,
    instruction=(
        "Write a three-sentence travel brief for {city} using the weather, "
        "attractions, and food research you are given."
    ),
)

workflow = Workflow(
    name="city_brief",
    edges=[
        (
            "START",
            record_city,
            (get_weather, find_attractions, suggest_food),
            gather,
            write_brief,
        ),
    ],
)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

DEMO_CITIES = ["Tokyo", "London"]


@observe(name="city_brief_run", type="agent")
async def run_city(runner: InMemoryRunner, user_id: str, session_id: str, city: str):
    # Fresh ADK session per city so each run starts from empty workflow state.
    # TraceRoot records this ADK session id as session.id.
    await runner.session_service.create_session(
        app_name=runner.app_name,
        user_id=user_id,
        session_id=session_id,
    )
    async for event in runner.run_async(
        user_id=user_id,
        session_id=session_id,
        new_message=types.Content(role="user", parts=[types.Part(text=city)]),
    ):
        if (
            event.author == write_brief.name
            and event.content
            and event.content.parts
            and event.content.parts[0].text
        ):
            print(f"\nBrief: {event.content.parts[0].text.strip()}\n")


async def run_demo():
    app_name = "traceroot-adk-workflow-demo"
    user_id = "example-user"

    runner = InMemoryRunner(agent=workflow, app_name=app_name)

    for i, city in enumerate(DEMO_CITIES, 1):
        print(f"\n{'=' * 60}")
        print(f"City {i}: {city}")
        print("=" * 60)

        await run_city(runner, user_id, f"google-adk-workflow-{city.lower()}", city)


if __name__ == "__main__":
    with using_attributes(user_id="example-user"):
        try:
            asyncio.run(run_demo())
        finally:
            traceroot.flush()
