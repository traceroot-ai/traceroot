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

## What it does

Runs demo queries using the Claude Agent SDK's built-in tools (Read, Glob, Grep, Bash).
Claude autonomously decides which tools to use and executes them.
