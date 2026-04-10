# Claude Agent SDK

Multi-agent research pipeline using Claude Code as a library, instrumented with [TraceRoot](https://traceroot.ai).

## Setup

```bash
cp .env.example .env  # fill in your API keys
pnpm install
```

## Run

```bash
pnpm demo
```

## What it does

Runs a research pipeline with 3 subagents:
- **Researcher** — gathers info via WebSearch
- **Analyst** — processes data via Bash/python3
- **Writer** — synthesizes a summary report

The lead agent coordinates the subagents using the Agent tool.
