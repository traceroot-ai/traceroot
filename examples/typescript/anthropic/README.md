# Anthropic Tool Agent (TypeScript)

ReAct-style agent with Anthropic tool use, instrumented with [TraceRoot](https://traceroot.ai).

## Setup

```bash
cp .env.example .env  # fill in your API keys
pnpm install
pnpm demo
```

## What it does

Runs two demo queries through a ReAct agent backed by `claude-sonnet-4-5-20250929`:

1. Weather comparison (San Francisco vs Tokyo)
2. Stock price lookup + calculation (NVDA +10%)

Tools: `get_weather`, `get_stock_price`, `calculate`, `get_current_time`
