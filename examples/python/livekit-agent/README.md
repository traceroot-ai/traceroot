# LiveKit Agent

Voice agent using LiveKit Agents, instrumented with [TraceRoot](https://traceroot.ai).

## Setup

```bash
cp .env.example .env  # fill in your API keys
```

With `uv` (recommended):

```bash
uv run --no-project --python 3.13 --with-requirements requirements.txt python main.py
```

## What it does

Starts a LiveKit voice agent and routes LiveKit's native OpenTelemetry spans
through TraceRoot.

The TraceRoot setup is intentionally small:

- `traceroot.initialize(integrations=[Integration.LIVEKIT])` gives TraceRoot's
  tracer provider to LiveKit.
- `using_attributes(session_id=ctx.room.name)` groups all spans from the room
  into one TraceRoot session.
- `ctx.add_shutdown_callback(traceroot.flush)` flushes spans before the job exits.
- `record={"traces": False}` avoids LiveKit Cloud re-binding the tracer provider
  away from TraceRoot.
