# Claude Agent SDK

Agent using Claude Code as a library, instrumented with [TraceRoot](https://traceroot.ai).

## Setup

```bash
cp .env.example .env  # fill in your API keys
```

With `uv` (recommended):
```bash
uv run --no-project --python 3.13 --with-requirements requirements.txt python main.py
```

For a fast end-to-end check (~1-2 min), run the minimal variant instead:
```bash
uv run --no-project --python 3.13 --with-requirements requirements.txt python minimal.py
```

## What it does

Runs demo queries using the Claude Agent SDK. Claude autonomously decides which
tools to use and executes them. Each variant exercises a distinct part of the SDK
surface, so they double as instrumentation smoke tests:

- `main.py` — full demo via `query()`: 2 topics, WebSearch researcher, higher turn budget.
- `minimal.py` — trimmed `query()` version: 1 topic, no WebSearch, low `max_turns`,
  "be brief" prompts. Same trace shape, finishes in ~1-2 min.
- `client.py` — the **persistent `ClaudeSDKClient`** API (a two-turn streaming
  session) rather than the one-shot `query()` helper. This is the API most
  production agents use.
- `client-mcp.py` — `ClaudeSDKClient` driving **MCP tools** (a self-contained
  in-process SDK MCP server). Covers the `mcp__<server>__<tool>` tool-span path
  production agents lean on; external stdio MCP servers produce the same span shape.
