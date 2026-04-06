# Mastra Weather Agent (TypeScript)

Weather agent using [Mastra](https://mastra.ai) with Claude Haiku, instrumented with [TraceRoot](https://traceroot.ai).

## Setup

```bash
cp .env.example .env  # fill in your API keys
pnpm install
pnpm demo
```

## What it does

Runs two demo weather queries through a Mastra agent backed by `claude-haiku-4-5-20251001`:

1. Current weather in San Francisco
2. Weather comparison between New York and London

Both calls share a `threadId` so they appear grouped under the same session in the TraceRoot UI.

Tools: `get_weather`
