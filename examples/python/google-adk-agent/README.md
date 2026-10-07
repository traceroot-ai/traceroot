# Google ADK Agent

Multi-tool agent using the Google Agent Development Kit (ADK), instrumented with [TraceRoot](https://traceroot.ai).

## Setup

```bash
cp .env.example .env  # fill in your API keys
```

With `uv` (recommended):
```bash
uv run --no-project --python 3.13 --with-requirements requirements.txt python main.py
```

## What it does

Runs demo queries using a Google ADK 2.x agent with Gemini (`gemini-3.8-flash`).
Tools: `get_weather`, `calculate`
