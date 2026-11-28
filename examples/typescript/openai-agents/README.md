# OpenAI Agents SDK (TypeScript)

Multi-tool agent built with the [OpenAI Agents SDK](https://openai.github.io/openai-agents-js/) (`@openai/agents`), instrumented with [TraceRoot](https://traceroot.ai).

## Setup

```bash
cp .env.example .env  # fill in OPENAI_API_KEY and TRACEROOT_API_KEY
pnpm install
```

To send traces to a local self-hosted instance instead of app.traceroot.ai, uncomment `TRACEROOT_HOST_URL` in `.env`.

## Usage

```bash
pnpm demo
```

## What it does

Runs two demo queries through an `Agent` backed by `gpt-4o-mini`, all inside a single `demo_session` trace:

1. Weather comparison (San Francisco vs Tokyo)
2. Stock price lookup + calculation (NVDA +10%)

Tools: `get_weather`, `get_stock_price`, `calculate`

> `get_weather` and `get_stock_price` return hardcoded mock data — they exist to exercise tool-call instrumentation, not to demo real services. `calculate` evaluates plain arithmetic and rejects anything else.

## How TraceRoot is wired

- `TraceRoot.initialize({ instrumentModules: { openaiAgents: agents } })` instruments the `@openai/agents` module.
- `observe({ name: 'demo_session' }, ...)` groups both queries under one root span.
- `usingAttributes(...)` tags the trace with a session ID (`openai-agents-ts-session`), a user ID (`demo-user`) and the tags `demo` and `openai-agents`.
- `TraceRoot.shutdown()` runs in a `finally` block so buffered spans are exported before the process exits.

## TraceRoot UI

After the run, open your project's **Traces** page and look for the `demo_session` trace to see the agent run, its LLM calls and each tool invocation with inputs and outputs.
