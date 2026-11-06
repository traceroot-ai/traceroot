# Groq Tool Agent (TypeScript)

ReAct-style agent with Groq tool calling, instrumented with [TraceRoot](https://traceroot.ai).

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

Runs two demo queries that exercise tool use:

1. Weather comparison (San Francisco vs Tokyo)
2. Stock price lookup + calculation (NVDA +10%)

Tools: `get_weather`, `get_stock_price`, `calculate`, `get_current_time`

> `get_weather` and `get_stock_price` return mock data by design. They exist to demonstrate tool-call and LLM instrumentation, not live APIs.

## Verifying traces

When sharing screenshots/recordings for PR review, include:

1. Terminal run of `pnpm demo`
2. Corresponding traces visible in TraceRoot (either [app.traceroot.ai](https://app.traceroot.ai) or a local `TRACEROOT_HOST_URL`)
