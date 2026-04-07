# OpenAI Agents SDK

Multi-tool agent using the OpenAI Agents SDK, instrumented with [TraceRoot](https://traceroot.ai).

## Setup
```bash
cp .env.example .env  # fill in your API keys
```

With `uv` (recommended):
```bash
uv run --no-project --python 3.13 --with-requirements requirements.txt python main.py
```

## What it does
Runs a demo query that exercises tool use with the OpenAI Agents SDK.
Tools: `get_weather`, `calculate`
