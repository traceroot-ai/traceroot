"""
Claude Agent SDK multi-agent research pipeline with TraceRoot observability.

Demonstrates a mini research system inspired by anthropics/claude-agent-sdk-demos:
- Lead agent coordinates research on a topic
- Researcher subagent gathers info via WebSearch
- Analyst subagent processes data via Bash (python3)
- Writer subagent produces a summary

Each subagent makes its own LLM calls, creating a rich trace hierarchy.

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

traceroot.initialize(integrations=[Integration.CLAUDE_AGENT_SDK])

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

from claude_agent_sdk import AgentDefinition, ClaudeAgentOptions, query

# ---------------------------------------------------------------------------
# Subagent definitions
# ---------------------------------------------------------------------------

RESEARCHER = AgentDefinition(
    description=(
        "Research specialist. Use when you need to gather information "
        "about a topic from the web. Returns structured research notes."
    ),
    prompt=(
        "You are a research specialist. Use WebSearch to find relevant "
        "information about the given topic. Provide a concise summary "
        "with key facts and sources. Keep your response under 200 words."
    ),
    tools=["WebSearch"],
    model="haiku",
)

ANALYST = AgentDefinition(
    description=(
        "Data analyst. Use when you need to perform calculations, "
        "data processing, or generate statistics from research findings."
    ),
    prompt=(
        "You are a data analyst. Use Bash with python3 to perform "
        "calculations, statistics, or data processing. Provide clear "
        "numerical results. Keep your response concise."
    ),
    tools=["Bash"],
    model="haiku",
)

WRITER = AgentDefinition(
    description=(
        "Report writer. Use when you need to synthesize research findings "
        "and analysis into a clear, well-structured summary report."
    ),
    prompt=(
        "You are a report writer. Synthesize the information provided "
        "into a clear, well-structured summary. Use bullet points and "
        "headers. Keep the report concise and under 300 words."
    ),
    tools=[],
    model="haiku",
)


# ---------------------------------------------------------------------------
# Agent
# ---------------------------------------------------------------------------


@observe(name="research_pipeline", type="agent")
async def run_research(topic: str) -> str:
    """Run a multi-agent research pipeline on the given topic."""
    result_text = ""
    async for message in query(
        prompt=(
            f"Research the following topic using a multi-step approach:\n\n"
            f"Topic: {topic}\n\n"
            f"Steps:\n"
            f"1. Use the researcher agent to gather key facts about this topic\n"
            f"2. Use the analyst agent to calculate or process any relevant numbers "
            f"(e.g., growth rates, comparisons, statistics)\n"
            f"3. Use the writer agent to produce a final summary report\n\n"
            f"Coordinate the agents and present the final report."
        ),
        options=ClaudeAgentOptions(
            allowed_tools=["Agent"],
            max_turns=15,
            agents={
                "researcher": RESEARCHER,
                "analyst": ANALYST,
                "writer": WRITER,
            },
        ),
    ):
        if hasattr(message, "result"):
            result_text = message.result
        elif hasattr(message, "content") and isinstance(message.content, str):
            print(message.content, end="", flush=True)
    return result_text


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

DEMO_TOPICS = [
    "What are the key features of OpenTelemetry for AI observability?",
]


@observe(name="demo_session", type="agent")
async def run_demo():
    for i, topic in enumerate(DEMO_TOPICS, 1):
        print(f"\n{'=' * 60}")
        print(f"Research {i}: {topic}")
        print("=" * 60)
        result = await run_research(topic)
        if result:
            print(f"\n{result}")
        print()


if __name__ == "__main__":
    with using_attributes(user_id="example-user", session_id="claude-agent-sdk-session"):
        try:
            asyncio.run(run_demo())
        finally:
            traceroot.flush()
