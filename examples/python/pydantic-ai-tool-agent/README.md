# Pydantic AI Tool Agent

A tool-using financial research agent built with [pydantic-ai](https://ai.pydantic.dev), instrumented with [TraceRoot](https://traceroot.ai).

TraceRoot captures all agent runs, LLM calls, and tool invocations through pydantic-ai's native OpenTelemetry instrumentation — no `@observe` decorators needed for those spans. The `@observe` on `run_demo()` is optional: it creates a named parent span that groups both demo queries into a single trace.

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
1. Compare NVDA and MSFT stock prices and performance
2. Calculate share counts for Apple and Google at current prices

Tools: `get_stock_price`, `get_company_info`, `calculate`

## How instrumentation works

`traceroot.initialize(integrations=[Integration.PYDANTIC_AI])` calls `Agent.instrument_all()` internally, enabling pydantic-ai's native OTel instrumentation. An `OpenInferenceSpanProcessor` reshapes those spans into the format TraceRoot understands, so agent runs, LLM calls, and tool invocations all appear in the TraceRoot UI automatically.
