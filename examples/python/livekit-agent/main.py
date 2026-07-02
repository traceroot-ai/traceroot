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

from livekit.agents import Agent, AgentServer, AgentSession, JobContext, JobProcess, cli, inference
from livekit.plugins import silero
from livekit.plugins.turn_detector.multilingual import MultilingualModel

import traceroot
from traceroot import Integration, using_attributes


class Assistant(Agent):
    def __init__(self) -> None:
        super().__init__(
            instructions="You are a helpful voice AI assistant.",
            llm=inference.LLM(model="openai/gpt-5.2-chat-latest"),
        )


server = AgentServer()


def prewarm(proc: JobProcess) -> None:
    proc.userdata["vad"] = silero.VAD.load()


server.setup_fnc = prewarm


@server.rtc_session(agent_name="traceroot-livekit-agent")
async def entrypoint(ctx: JobContext) -> None:
    traceroot.initialize(integrations=[Integration.LIVEKIT])

    async def flush_trace() -> None:
        traceroot.flush()

    ctx.add_shutdown_callback(flush_trace)

    session = AgentSession(
        stt=inference.STT(model="deepgram/nova-3", language="multi"),
        tts=inference.TTS(model="cartesia/sonic-3"),
        turn_detection=MultilingualModel(),
        vad=ctx.proc.userdata["vad"],
        preemptive_generation=True,
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
