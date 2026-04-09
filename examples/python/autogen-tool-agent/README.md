# AutoGen Agent (AG2)

Multi-agent conversation using the AutoGen framework with LLM tool use, instrumented with [TraceRoot](https://traceroot.ai).

*Note: This example utilizes `ag2[gemini]`, the community-maintained continuation of the AutoGen framework, configured to use Google's Gemini models.*

## Setup

```bash
cp .env.example .env  # fill in your API keys
```

With `uv` (recommended):
```bash
uv run --no-project --python 3.13 --with-requirements requirements.txt python main.py
```

## What it does

Runs a multi-agent loop (`AssistantAgent` and `UserProxyAgent`) to exercise tool use:
1. Weather comparison (San Francisco vs Tokyo)
2. Math evaluation (15 multiplied by 24)

Tools: `get_weather`, `calculate`
