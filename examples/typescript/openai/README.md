# OpenAI Tool Agent

ReAct-style agent with OpenAI tool calling, instrumented with [TraceRoot](https://traceroot.ai).

## Setup

```bash
cp .env.example .env  # fill in your API keys
pnpm install
```

## Usage

```bash
pnpm demo        # tool-calling agent
pnpm streaming   # streaming pipeline (generator support)
```

## What it does

Runs three demo queries that exercise tool use:
1. Weather comparison (San Francisco vs Tokyo)
2. Stock price lookup + calculation (NVDA +10%)
3. Web search + summarization

Tools: `get_weather`, `get_stock_price`, `calculate`, `search_web`, `get_current_time`
