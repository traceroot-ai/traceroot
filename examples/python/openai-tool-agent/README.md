# OpenAI Tool Agent

ReAct-style agent with OpenAI streaming and tool use, instrumented with [TraceRoot](https://traceroot.ai).

## Setup

```bash
cp .env.example .env  # fill in your API keys
```

With `uv` (recommended):
```bash
uv run --no-project --python 3.13 --with-requirements requirements.txt python main.py
```

## Streaming pipeline

Demonstrates `@observe` on async generators — spans stay open until the last token, capturing real end-to-end latency.

```bash
uv run --no-project --python 3.13 --with-requirements requirements.txt python streaming-pipeline.py
```

## What it does

Runs two demo queries that exercise tool use:
1. Weather comparison (San Francisco vs Tokyo)
2. Stock price lookup + calculation (NVDA +10%)

Tools: `get_weather`, `get_stock_price`, `calculate`, `get_current_time`
