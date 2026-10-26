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

The default command runs one real text-only LiveKit turn, calls the `add_numbers`
tool, flushes TraceRoot, and exits.

To run with live voice interactions in development, production, or console modes:

```bash
uv run --no-project --python 3.13 --with-requirements requirements.txt python main.py dev
uv run --no-project --python 3.13 --with-requirements requirements.txt python main.py start
uv run --no-project --python 3.13 --with-requirements requirements.txt python main.py console
```

## What it does

Starts a LiveKit agent and routes LiveKit's native OpenTelemetry spans through
TraceRoot. The default path runs a text-only turn with LiveKit Inference LLM and
exits. The `console`, `dev`, and `start` paths use LiveKit Inference for STT,
TTS, and LLM calls, plus LiveKit Agents' default bundled VAD and default turn
detection for voice interaction.

The TraceRoot setup is intentionally small:

- `traceroot.initialize(integrations=[Integration.LIVEKIT])` gives TraceRoot's
  tracer provider to LiveKit.
- `using_attributes(session_id=ctx.room.name)` groups all spans from the room
  into one TraceRoot session.
- `ctx.add_shutdown_callback(traceroot.flush_async)` flushes spans before the
  job exits.

LiveKit currently emits an `agent_turn` span for each completed turn. Voice runs
also emit `user_turn` spans for user input.

The demo agent exposes an `add_numbers` function tool. The default command asks
"what is 12 plus 30?" automatically to generate a tool call span.
