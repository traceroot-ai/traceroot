# Vercel AI SDK Agent

Multi-step tool-use agent built with the [Vercel AI SDK](https://sdk.vercel.ai/), instrumented with [TraceRoot](https://traceroot.ai).

## Setup

```bash
cp .env.example .env  # fill in your API keys
pnpm install
```

## Usage

```bash
pnpm demo            # agent.ts — multi-step tool-use agent (generateText)
pnpm demo:streaming  # agent-streaming.ts — streamed handler with deferred work
pnpm demo:agent      # tool-loop-agent.ts — ToolLoopAgent + generateObject + embeddings
```

## What the demos show

**`pnpm demo`** — two queries that exercise multi-step tool use:
1. Weather comparison (San Francisco vs Tokyo)
2. Stock price lookup + calculation (NVDA +10%)

Tools: `getWeather`, `getStockPrice`, `calculate`

**`pnpm demo:agent`** — a support-triage assistant that proves TraceRoot traces
far more than `generateText`. In one run it exercises four AI SDK surfaces, all
captured automatically:
- `embedMany` + `embed` + `cosineSimilarity` (semantic routing over a small KB)
- the **`ToolLoopAgent`** class — `.generate()` (tool loop) and `.stream()`
- `generateObject` (schema-validated triage record)

## Why no `instrumentModules` config?

Unlike LangChain / OpenAI / Anthropic, the Vercel AI SDK emits OpenTelemetry spans natively when `experimental_telemetry: { isEnabled: true }` is set on each call. TraceRoot enriches those spans through the OpenInference span processor registered inside `TraceRoot.initialize()` — no `instrumentModules` entry needed.

See [docs/integrations/vercel-ai](https://traceroot.ai/docs/integrations/vercel-ai) for details.
