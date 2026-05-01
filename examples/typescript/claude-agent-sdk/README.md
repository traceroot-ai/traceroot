# Claude Agent SDK

Multi-agent research pipeline using Claude Code as a library, instrumented with [TraceRoot](https://traceroot.ai).

## Setup

```bash
cp .env.example .env  # fill in your API keys
pnpm install
pnpm demo
```

## What it does

Iterates over `DEMO_TOPICS` and for each topic runs a 3-subagent pipeline:

1. **researcher** — gathers info via WebSearch
2. **analyst** — processes data via Bash / python3
3. **writer** — synthesizes a final summary report

The lead agent dispatches the subagents using the `Agent` tool. All topics share one `demo_session` trace.
