# Vercel AI SDK Agent

Multi-step tool-use agent built with the [Vercel AI SDK](https://sdk.vercel.ai/), instrumented with [TraceRoot](https://traceroot.ai).

## Setup

```bash
cp .env.example .env  # fill in your API keys
pnpm install
```

## Usage

```bash
pnpm demo
```

## What it does

Runs two demo queries that exercise multi-step tool use:
1. Weather comparison (San Francisco vs Tokyo)
2. Stock price lookup + calculation (NVDA +10%)

Tools: `getWeather`, `getStockPrice`, `calculate`

## Why no `instrumentModules` config?

Unlike LangChain / OpenAI / Anthropic, the Vercel AI SDK emits OpenTelemetry spans natively when `experimental_telemetry: { isEnabled: true }` is set on each call. TraceRoot enriches those spans through the OpenInference span processor registered inside `TraceRoot.initialize()` — no `instrumentModules` entry needed.

See [docs/integrations/vercel-ai](https://traceroot.ai/docs/integrations/vercel-ai) for details.
