# Agno Tool Agent

ReAct-style agent with the [Agno](https://docs.agno.com) framework and tool use, instrumented with [TraceRoot](https://traceroot.ai).

## Setup

```bash
cp .env.example .env  # fill in your API keys
```

With `uv` (recommended):
```bash
uv run --no-project --python 3.13 --with-requirements requirements.txt python main.py
```

## What it does

Runs two demo queries that exercise tool use:
1. Stock price lookup (Apple)
2. Web search (latest AI news)

Tools: `YFinanceTools`, `DuckDuckGoTools`
