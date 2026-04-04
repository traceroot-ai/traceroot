# Anthropic Tool Agent (TypeScript)

ReAct-style agent with Anthropic tool use, instrumented with TraceRoot.

## Setup

Copy the root `.env.example` to `.env` and fill in your keys:

```bash
cp .env.example .env
```

Install dependencies and run:

```bash
pnpm install && pnpm demo
```

## Environment Variables

| Variable | Description |
|---|---|
| `ANTHROPIC_API_KEY` | Your Anthropic API key |
| `TRACEROOT_API_KEY` | Your TraceRoot API key |

## What It Does

Runs two demo queries through a ReAct agent backed by `claude-sonnet-4-5-20250929`:

1. **Weather comparison** — fetches weather for San Francisco and Tokyo, then compares them.
2. **Stock + math** — looks up NVDA's current price, then calculates what a 10% increase would be.

The agent loops over Anthropic's `tool_use` stop reason, dispatching calls to four built-in tools (`get_weather`, `get_stock_price`, `calculate`, `get_current_time`) until the model returns a final text response. All spans are exported to TraceRoot.
