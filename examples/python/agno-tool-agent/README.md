# Agno Tool Agent — TraceRoot Observability

A ReAct-style tool-use agent built with the [Agno](https://docs.agno.com) framework,
fully instrumented with TraceRoot.

## What gets traced

| Signal | Details |
|---|---|
| Agent runs | Each `agent.run()` / `agent.print_response()` call |
| Tool calls | YFinance and DuckDuckGo invocations with input/output |
| LLM calls | All model inference spans with token usage and latency |
| Model name | Captured on every LLM span |

## Setup

```bash
cp .env.example .env
# Fill in TRACEROOT_API_KEY and OPENAI_API_KEY
pip install -r requirements.txt
python main.py
```

## Usage in your own project

```python
import traceroot
from traceroot import Integration

traceroot.initialize(integrations=[Integration.AGNO])
```

One line — all Agno agent runs, tool calls, and LLM calls are traced automatically.
