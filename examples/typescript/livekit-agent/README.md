# LiveKit Agents TypeScript Example

LiveKit Agents text/voice agent, instrumented with
[TraceRoot](https://traceroot.ai).

## Setup

```bash
cp .env.example .env
pnpm install
```

For PR review before the LiveKit TypeScript SDK support is published, install a
locally built TraceRoot SDK package:

```bash
pnpm --dir /path/to/traceroot-ts/packages/traceroot build
npm --cache /tmp/npm-cache --prefix /path/to/traceroot-ts/packages/traceroot pack --pack-destination /tmp/traceroot-ts-pack
npm install --no-save /tmp/traceroot-ts-pack/traceroot-ai-traceroot-*.tgz
```

Then verify the example without external API keys:

```bash
pnpm build
```

The non-interactive demo uses LiveKit Inference credentials:

```bash
npm run demo
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
