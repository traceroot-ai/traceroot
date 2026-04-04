# DeepAgents Multi-Agent Research (Python)

Multi-agent research pipeline using [deepagents](https://github.com/langchain-ai/deepagents), instrumented with [TraceRoot](https://traceroot.ai).

## Setup

```bash
cp .env.example .env  # fill in your API keys
```

With `uv` (recommended):
```bash
uv run --no-project --python 3.13 --with-requirements requirements.txt python main.py
```

## Environment variables

| Variable | Purpose |
|---|---|
| `TRACEROOT_API_KEY` | TraceRoot project key |
| `ANTHROPIC_API_KEY` | Claude model access (default) |
| `OPENAI_API_KEY` | Alternative model provider |
| `TAVILY_API_KEY` | Live web search via Tavily |

## What it does

A supervisor agent orchestrates two sub-agents to answer a research question:

1. **research-agent** — searches the web with Tavily and organises findings
2. **critique-agent** — reviews the research for gaps, bias, and missing angles
3. **supervisor** — synthesises both outputs into a final structured report

TraceRoot captures the full nested trace: the top-level `research_session` span, each sub-agent invocation, and every LangChain LLM call inside them, visible in the [TraceRoot dashboard](https://app.traceroot.ai).
