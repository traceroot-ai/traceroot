# DeepAgents Multi-Agent Research (TypeScript)

Multi-agent research pipeline using [deepagents](https://www.npmjs.com/package/deepagents), instrumented with TraceRoot.

## Setup

```bash
cp .env.example .env  # fill in your API keys
pnpm install
pnpm demo
```

## What it does

A supervisor agent orchestrates two sub-agents in sequence:

1. **research-agent** — gathers information on the query topic
2. **critique-agent** — reviews the findings for accuracy, completeness, and gaps
3. **supervisor** — synthesizes both outputs into a final report written to `final_report.md`

TraceRoot intercepts all LangChain/LangGraph spans produced by deepagents internally, so the TraceRoot UI shows nested agent spans for the supervisor, each sub-agent invocation, and every LLM call.
