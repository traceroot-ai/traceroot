# Google ADK Workflow

Fan-out / fan-in graph `Workflow` built with the Google Agent Development Kit (ADK) 2.x, instrumented with [TraceRoot](https://traceroot.ai).

## Setup

```bash
cp .env.example .env  # fill in your API keys
```

With `uv` (recommended):
```bash
uv run --no-project --python 3.13 --with-requirements requirements.txt python main.py
```

## What it does

Writes a short travel brief for each demo city with Gemini (`gemini-3.8-flash`):

1. `record_city` (function node) stores the city in session state.
2. Three branches run in parallel: `get_weather` (function node), `find_attractions` and `suggest_food` (LLM agents).
3. `gather` (`JoinNode`) waits for all three branches.
4. `write_brief` (LLM agent) turns the joined results into the brief.

With `traceroot==0.2.0` you see the agent and LLM spans, but not ADK's
`invoke_workflow` / `invoke_node` spans, so the function nodes, the parallel
branches, and the join do not appear in the trace. Those spans need the next
traceroot release, which is not out yet.
