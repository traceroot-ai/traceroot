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

Runs demo queries using the Claude Agent SDK's built-in tools (Read, Glob, Grep, Bash).
Claude autonomously decides which tools to use and executes them.

- `main.py` — full demo: 2 topics, WebSearch researcher, higher turn budget.
- `minimal.py` — trimmed version of `main.py`: 1 topic, no WebSearch, low `max_turns`,
  "be brief" prompts. Same trace shape, finishes in ~1-2 min.
