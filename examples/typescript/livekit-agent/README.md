# LiveKit Agents TypeScript Example

LiveKit Agents text/voice agent, instrumented with
[TraceRoot](https://traceroot.ai).

## Setup

```bash
cp .env.example .env
pnpm install
```

Verify the example:

```bash
pnpm build
```

The non-interactive demo uses LiveKit Inference credentials:

```bash
npm run demo
```

The `npm run console` and `npm run console:text` scripts require the [LiveKit CLI](https://docs.livekit.io/home/cli/cli-setup/) (`lk`):

```bash
# macOS
brew install livekit-cli

# Linux / macOS
curl -sSL https://get.livekit.io/cli | bash

# Windows
winget install LiveKit.LiveKitCLI
```

For an interactive voice session, run the LiveKit CLI console from a real
terminal:

```bash
npm run console
```

That starts the LiveKit mic/speaker console broker and launches this agent with
the required `--connect-addr` automatically. For text mode, use:

```bash
npm run console:text
```

Room worker modes still use the LiveKit agent runner:

```bash
npm run dev
npm run start
```

## What It Does

The TraceRoot setup uses the same primitives as the Python SDK example:

- `TraceRoot.initialize({ instrumentModules: { livekitAgents } })` gives
  TraceRoot's tracer provider to LiveKit.
- `usingAttributes({ sessionId: ctx.room.name })` groups spans from the room into
  one TraceRoot session.
- `ctx.addShutdownCallback(() => TraceRoot.flush())` flushes spans before the job
  exits.

The default `demo` path runs one text-only LiveKit turn, asks the agent to add
two numbers, calls the `add_numbers` function tool, flushes TraceRoot, and exits.
