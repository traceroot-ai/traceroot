# LiveKit Voice Agent

LiveKit Agents voice agent, instrumented with [TraceRoot](https://traceroot.ai).

## Setup

```bash
cp .env.example .env  # fill in your API keys
```

With `uv` (recommended):

```bash
uv run --no-project --python 3.13 --with-requirements requirements.txt python main.py
```

To talk to the agent from your terminal:

```bash
uv run --no-project --python 3.13 --with-requirements requirements.txt python main.py console
```

## What it does

Starts a LiveKit agent and routes LiveKit's native OpenTelemetry spans through
TraceRoot. The agent uses LiveKit Inference for STT, TTS, and LLM calls, plus
Silero VAD and LiveKit's multilingual turn detector for voice interaction.

The TraceRoot setup is intentionally small:

- `traceroot.initialize(integrations=[Integration.LIVEKIT])` gives TraceRoot's
  tracer provider to LiveKit.
- `using_attributes(session_id=ctx.room.name)` groups all spans from the room
  into one TraceRoot session.
- `ctx.add_shutdown_callback(traceroot.flush)` flushes spans before the job exits.
- `record={"traces": False}` avoids LiveKit Cloud re-binding the tracer provider
  away from TraceRoot.

LiveKit currently emits an `agent_turn` span for each completed turn. The user's
utterance is attached as that span's input, and the assistant response is
attached as its output.
