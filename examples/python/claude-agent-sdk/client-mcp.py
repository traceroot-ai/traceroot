"""MCP-tool demo with TraceRoot observability.

Shows how MCP tool calls appear in traces. Production agents are often
MCP-heavy, with traces full of `mcp__<server>__<tool>` spans.

This uses an *in-process* SDK MCP server (`create_sdk_mcp_server`) so it runs
self-contained with just an Anthropic key — no external MCP server process to
install. An external stdio MCP server (the typical production setup) produces
the **same** span shape through the same code path: each MCP call arrives as a
`ToolUseBlock` named `mcp__<server>__<tool>` and gets a TOOL span, exactly like
a built-in tool.

Driven through the persistent `ClaudeSDKClient` (see client.py), since that
is the API real agents use.

Usage:
    cp .env.example .env
    uv run --no-project --python 3.13 --with-requirements requirements.txt python client-mcp.py
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

from claude_agent_sdk import (
    ClaudeAgentOptions,
    ClaudeSDKClient,
    create_sdk_mcp_server,
    tool,
)

# --- A tiny in-process MCP server with two tools ----------------------------


@tool("multiply", "Multiply two numbers", {"a": float, "b": float})
async def multiply(args):
    result = args["a"] * args["b"]
    return {"content": [{"type": "text", "text": str(result)}]}


@tool("add", "Add two numbers", {"a": float, "b": float})
async def add(args):
    result = args["a"] + args["b"]
    return {"content": [{"type": "text", "text": str(result)}]}


calc_server = create_sdk_mcp_server(name="calc", version="1.0.0", tools=[multiply, add])

OPTIONS = ClaudeAgentOptions(
    model="haiku",
    mcp_servers={"calc": calc_server},
    # MCP tools are addressed as mcp__<server>__<tool>.
    allowed_tools=["mcp__calc__multiply", "mcp__calc__add"],
    max_turns=5,
    permission_mode="bypassPermissions",
)

TURN_1 = "Use the multiply tool to compute 17 * 23. Reply with only the number."
TURN_2 = "Now use the add tool to add 100 to that number. Reply with only the result."


@observe(name="mcp_pipeline", type="agent")
async def run_session() -> str:
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
    print("ClaudeSDKClient + MCP tools — Demo (TraceRoot)")
    print("=" * 60)
    result = await run_session()
    if result:
        print(f"\n{result}")


if __name__ == "__main__":
    with using_attributes(user_id="example-user", session_id="claude-agent-sdk-mcp-session"):
        try:
            asyncio.run(run_demo())
        finally:
            traceroot.flush()
