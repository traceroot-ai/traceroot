# Pydantic AI Agent

Tool-use agent using Pydantic AI, instrumented with [TraceRoot](https://traceroot.ai).

## Setup
```bash
cp .env.example .env  # fill in your API keys
```

With `uv` (recommended):
```bash
uv run --no-project --python 3.13 --with-requirements requirements.txt python main.py
```

## What it does
Runs demo queries that exercise tool use with Pydantic AI.
Tools: `get_weather`, `get_stock_price`, `calculate`
