# DeepAgents Multi-Agent Research (TypeScript)

Multi-agent research pipeline using [deepagents](https://www.npmjs.com/package/deepagents), instrumented with TraceRoot.

## What it does

A supervisor agent orchestrates two sub-agents in sequence:

1. **research-agent** — searches the web via Tavily and gathers information on the query topic.
2. **critique-agent** — reviews the research findings for accuracy, completeness, and gaps.

The supervisor synthesizes both outputs into a final report written to `final_report.md`.

TraceRoot intercepts all LangChain/LangGraph spans produced by deepagents internally, so the Traceroot UI shows nested agent spans for the supervisor, each sub-agent invocation, and every LLM call.

## Setup

```bash
pnpm install
pnpm demo
```

## Environment variables

| Variable | Description |
|---|---|
| `ANTHROPIC_API_KEY` | Anthropic API key (used by Claude claude-sonnet-4-20250514) |
| `TAVILY_API_KEY` | Tavily API key (used by the research-agent for web search) |
| `TRACEROOT_API_KEY` | TraceRoot API key for exporting traces |

Copy the root `.env` or create one in this directory with the variables above.

## Output

- Console output: supervisor result printed to stdout.
- `final_report.md`: full synthesized research report written by the supervisor.
- Traces: visible in the Traceroot dashboard with nested spans — `research_session` → `supervisor` → `research-agent` → LLM calls → `critique-agent` → LLM calls.
