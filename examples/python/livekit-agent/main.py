"""
LiveKit Agents with TraceRoot observability.

Usage:
    cp .env.example .env
    uv run --no-project --python 3.13 --with-requirements requirements.txt python main.py console
"""

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


@server.rtc_session(agent_name="traceroot-livekit-agent")
async def entrypoint(ctx: JobContext) -> None:
    traceroot.initialize(integrations=[Integration.LIVEKIT])

    async def flush_trace() -> None:
        traceroot.flush()

    ctx.add_shutdown_callback(flush_trace)

    session = AgentSession(
        stt="deepgram/nova-3:en",
        llm="openai/chat-latest",
        tts="cartesia/sonic-3",
    )

    with using_attributes(session_id=ctx.room.name):
        await session.start(
            agent=Assistant(),
            room=ctx.room,
            record={"traces": False},
        )
        await ctx.connect()


if __name__ == "__main__":
    cli.run_app(server)
