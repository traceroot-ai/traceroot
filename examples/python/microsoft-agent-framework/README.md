# Microsoft Agent Framework Multi-Agent App

A multi-agent travel concierge built with [Microsoft Agent Framework](https://github.com/microsoft/agent-framework)
and traced end-to-end with [TraceRoot](https://traceroot.ai).

Agent Framework is Microsoft's successor to AutoGen + Semantic Kernel, and its
defining feature is multi-agent orchestration. This example shows a
`TravelConcierge` that delegates to two specialist agents exposed as tools via
`Agent.as_tool()`:

```
TravelConcierge
├─ LocalGuide     (tools: get_weather, find_attractions)
└─ BudgetPlanner  (tools: convert_currency)
```

## Setup

```bash
cp .env.example .env  # fill in your API keys
```

You need a `TRACEROOT_API_KEY` and an `OPENAI_API_KEY`.

## Run

```bash
uv run --no-project --python 3.13 --with-requirements requirements.txt python main.py
```

Or with a plain virtualenv:

```bash
pip install -r requirements.txt
python main.py
```

## What it does

- `traceroot.initialize(integrations=[Integration.AGENT_FRAMEWORK])` turns on
  automatic tracing for Agent Framework. It registers the OpenInference span
  processor and enables Agent Framework's built-in OpenTelemetry emission, so the
  trace mirrors the agent hierarchy — every agent invocation, model call and tool
  execution is its own span, no manual instrumentation of the framework required.
- The tools are plain functions — Agent Framework already emits an `execute_tool`
  span for each call, so they are intentionally left undecorated to avoid
  doubling up the spans.
- The orchestration entry point is wrapped in `@observe(type="agent")` to give
  the trace a single named root, and runs inside
  `using_attributes(user_id=..., session_id=...)` so it's attributed to a user
  and session. `traceroot.flush()` makes sure spans are delivered before exit.

View the resulting traces at [traceroot.ai](https://traceroot.ai).
