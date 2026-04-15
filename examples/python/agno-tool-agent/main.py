"""
Agno Tool Agent — TraceRoot Observability

A ReAct-style agent built with the Agno framework, instrumented
with TraceRoot via traceroot.initialize(integrations=[Integration.AGNO]).

Env vars required: ANTHROPIC_API_KEY, TRACEROOT_API_KEY

Run:
    pip install -r requirements.txt
    python main.py
"""

import logging

from dotenv import find_dotenv, load_dotenv

dotenv_path = find_dotenv()
if dotenv_path:
    load_dotenv(dotenv_path)
else:
    print("No .env file found (find_dotenv returned None).\nUsing process environment variables.")

from agno.agent import Agent
from agno.models.anthropic import Claude
from agno.tools.duckduckgo import DuckDuckGoTools
from agno.tools.yfinance import YFinanceTools

import traceroot
from traceroot import Integration, observe, using_attributes

traceroot.initialize(integrations=[Integration.AGNO])
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Agent setup
# ---------------------------------------------------------------------------


agent = Agent(
    model=Claude(id="claude-sonnet-4-20250514"),
    tools=[
        YFinanceTools(),
        DuckDuckGoTools(),
    ],
    instructions=[
        "Use YFinance for stock prices and fundamentals.",
        "Use DuckDuckGo for general web searches.",
        "Always cite your sources.",
    ],
    markdown=True,
)


# ---------------------------------------------------------------------------
# Demo
# ---------------------------------------------------------------------------


DEMO_QUERIES = [
    "What is the current stock price of NVDA and what are its fundamentals?",
    "Search for the latest news about AI agent frameworks in 2025.",
]


@observe(name="demo_session", type="agent")
def run_demo() -> None:
    print("=" * 60)
    print("Agno Tool Agent — Demo (TraceRoot)")
    print("=" * 60)

    for i, query in enumerate(DEMO_QUERIES, 1):
        print(f"\n{'=' * 60}")
        print(f"Query {i}: {query}")
        print("=" * 60)
        agent.print_response(query, stream=False)


if __name__ == "__main__":
    with using_attributes(user_id="example-user", session_id="agno-python-session"):
        run_demo()
    traceroot.flush()
    print("\n[Traces exported]")
