"""Minimal multi-agent demo with TraceRoot observability.

A trimmed-down version of main.py for quick end-to-end SDK testing:
- ONE topic (not 2)
- No WebSearch (the slow part) — researcher answers from knowledge
- Low max_turns and "be brief" instructions so the run finishes in ~1-2 min

Still exercises the full trace shape: orchestrator + researcher/analyst/writer
subagents + LLM spans + a Bash tool span + the final ResultMessage.

Usage:
    cp .env.example .env
    uv run --no-project --python 3.13 --with-requirements requirements.txt python minimal.py
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

# No-WebSearch researcher → fast. Analyst uses Bash (quick). Writer has no tools.
RESEARCHER = AgentDefinition(
    description="Research specialist. Gives key facts about a topic from its own knowledge.",
    prompt="You are a research specialist. Give 3 key facts about the topic from your own knowledge. No web search. Under 80 words.",
    tools=[],
    model="haiku",
)
ANALYST = AgentDefinition(
    description="Data analyst. Performs a quick calculation.",
    prompt="You are a data analyst. Use Bash with python3 for ONE short calculation. Report the number. Under 40 words.",
    tools=["Bash"],
    model="haiku",
)
WRITER = AgentDefinition(
    description="Report writer. Synthesizes findings into a short summary.",
    prompt="You are a report writer. Write a 3-bullet summary. Under 80 words.",
    tools=[],
    model="haiku",
)

TOPIC = "What are the key features of OpenTelemetry for AI observability?"


@observe(name="research_pipeline", type="agent")
async def run_research(topic: str) -> str:
    result_text = ""
    async for message in query(
        prompt=(
            f"Topic: {topic}\n\n"
            f"Do exactly 3 steps, calling each agent EXACTLY ONCE, and be very brief:\n"
            f"1. researcher agent: 3 key facts (no web search)\n"
            f"2. analyst agent: one quick python3 calculation\n"
            f"3. writer agent: a 3-bullet summary\n"
            f"Then present the final summary."
        ),
        options=ClaudeAgentOptions(
            model="sonnet",
            allowed_tools=["Agent"],
            max_turns=8,
            permission_mode="bypassPermissions",
            agents={"researcher": RESEARCHER, "analyst": ANALYST, "writer": WRITER},
        ),
    ):
        if hasattr(message, "result"):
            result_text = message.result
    return result_text


@observe(name="demo_session", type="agent")
async def run_demo():
    print("=" * 60)
    print(f"Research: {TOPIC}")
    print("=" * 60)
    result = await run_research(TOPIC)
    if result:
        print(f"\n{result}")


if __name__ == "__main__":
    with using_attributes(user_id="example-user", session_id="claude-agent-sdk-minimal-session"):
        try:
            asyncio.run(run_demo())
        finally:
            traceroot.flush()
