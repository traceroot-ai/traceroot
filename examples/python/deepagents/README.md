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

## What it does

A supervisor agent orchestrates two sub-agents to answer a research question:

1. **research-agent** — gathers information on the query topic
2. **critique-agent** — reviews the research for gaps, bias, and missing angles
3. **supervisor** — synthesises both outputs into a final structured report

TraceRoot captures the full nested trace: the top-level `research_session` span, each sub-agent invocation, and every LangChain LLM call inside them.
