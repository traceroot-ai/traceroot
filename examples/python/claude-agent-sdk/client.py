"""ClaudeSDKClient demo with TraceRoot observability.

Counterpart to minimal.py, but uses the *persistent streaming* client
(`ClaudeSDKClient`) instead of the one-shot `query()` helper. This is the API
real production agents tend to use — a long-lived session driven across multiple
turns (here, two turns where the second builds on the first).

TraceRoot instruments the full `ClaudeSDKClient` path (connect / query /
receive_response), so the session below produces the same rich spans as the
`query()` examples: a per-turn root, nested `anthropic.messages.create` LLM
spans, and tool spans — on top of the manual `@observe` spans.

Usage:
    cp .env.example .env
    uv run --no-project --python 3.13 --with-requirements requirements.txt python client.py
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

from claude_agent_sdk import ClaudeAgentOptions, ClaudeSDKClient

# Shared workload — a two-turn persistent session. Turn 2 references turn 1,
# which only works because ClaudeSDKClient keeps the conversation alive.
TURN_1 = "Use the Bash tool to compute 17 * 23 with python3. Reply with only the number."
TURN_2 = "Now use the Bash tool to add 100 to that number. Reply with only the result."

OPTIONS = ClaudeAgentOptions(
    model="haiku",
    allowed_tools=["Bash"],
    max_turns=4,
    permission_mode="bypassPermissions",
)


@observe(name="research_pipeline", type="agent")
async def run_session() -> str:
    """Drive a persistent ClaudeSDKClient session across two turns."""
    final = ""
    async with ClaudeSDKClient(options=OPTIONS) as client:
        for turn in (TURN_1, TURN_2):
            await client.query(turn)
            async for message in client.receive_response():
                if hasattr(message, "result"):
                    final = message.result
    return final


@observe(name="demo_session", type="agent")
async def run_demo():
    print("=" * 60)
    print("ClaudeSDKClient persistent session — Demo (TraceRoot)")
    print("=" * 60)
    result = await run_session()
    if result:
        print(f"\n{result}")


if __name__ == "__main__":
    with using_attributes(user_id="example-user", session_id="claude-agent-sdk-client-session"):
        try:
            asyncio.run(run_demo())
        finally:
            traceroot.flush()
