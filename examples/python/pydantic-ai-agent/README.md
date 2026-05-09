# PydanticAI Agent

Simple [PydanticAI](https://ai.pydantic.dev/) weather agent with tool use, instrumented with [TraceRoot](https://traceroot.ai).

## Setup

```bash
cp .env.example .env  # fill in your API keys
```

With `uv` (recommended):

```bash
uv run --no-project --python 3.13 --with-requirements requirements.txt python main.py
```

## What it does

Runs a typed PydanticAI agent that calls a weather tool and compares conditions across cities. The OpenInference PydanticAI instrumentor automatically emits spans for the agent run and tool call so they appear in TraceRoot.

## How instrumentation is wired

```python
import traceroot
from traceroot import Integration

traceroot.initialize(integrations=[Integration.PYDANTIC_AI])
```
