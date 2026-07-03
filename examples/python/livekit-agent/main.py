"""
LiveKit Agents with TraceRoot observability.

Usage:
    cp .env.example .env
    python main.py smoke
    python main.py dev
    python main.py start
    python main.py console

See README.md for PR-review installation commands using a local TraceRoot SDK.
"""

import asyncio
import sys

from dotenv import find_dotenv, load_dotenv

dotenv_path = find_dotenv()
if dotenv_path:
    load_dotenv(dotenv_path)
else:
    print("No .env file found. Using process environment variables.")

from livekit.agents import Agent, AgentServer, AgentSession, JobContext, cli, function_tool

import traceroot
from traceroot import Integration, using_attributes


class Assistant(Agent):
    def __init__(self) -> None:
        super().__init__(
            instructions=(
                "You are a helpful voice AI assistant. Keep replies short. "
                "When the user asks you to add two numbers, call add_numbers "
                "before answering."
            ),
        )

    @function_tool(description="Add two numbers and return the sum.")
    async def add_numbers(self, a: float, b: float) -> str:
        """Return a deterministic addition result for tool tracing."""
        return f"{a} + {b} = {a + b}"


server = AgentServer()


def _new_session(*, voice: bool) -> AgentSession:
    if not voice:
        return AgentSession(llm="openai/chat-latest")

    return AgentSession(
        stt="deepgram/nova-3:en",
        llm="openai/chat-latest",
        tts="cartesia/sonic-3",
    )


async def run_smoke() -> None:
    traceroot.initialize(integrations=[Integration.LIVEKIT])

    session = _new_session(voice=False)
    try:
        with using_attributes(session_id="livekit-smoke"):
            await session.start(agent=Assistant())
            result = session.run(user_input="What is 12 plus 30? Use the add_numbers tool.")
            await result
    finally:
        await session.aclose()
        await traceroot.flush_async()


@server.rtc_session(agent_name="traceroot-livekit-agent")
async def entrypoint(ctx: JobContext) -> None:
    traceroot.initialize(integrations=[Integration.LIVEKIT])
    ctx.add_shutdown_callback(traceroot.flush_async)

    session = _new_session(voice=True)

    with using_attributes(session_id=ctx.room.name):
        await session.start(
            agent=Assistant(),
            room=ctx.room,
        )
        await ctx.connect()


if __name__ == "__main__":
    if len(sys.argv) == 1 or sys.argv[1] == "smoke":
        asyncio.run(run_smoke())
    else:
        cli.run_app(server)
