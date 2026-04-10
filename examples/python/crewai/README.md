# CrewAI Research Crew (Python)

Sequential multi-agent research workflow using [CrewAI](https://crewai.com/), OpenAI, and [TraceRoot](https://traceroot.ai).

## Setup

```bash
cp .env.example .env  # fill in your API keys
```

With `uv` (recommended):

```bash
uv run --no-project --python 3.13 --with-requirements requirements.txt python main.py
```

## What it does

Runs a sequential 3-agent workflow:

1. `Research Lead` gathers internal signals for the topic
2. `Risk Reviewer` critiques rollout gaps and weak assumptions
3. `Recommendation Writer` turns both into a final markdown memo

The example uses mocked internal tools and records the full run in TraceRoot under the top-level `run_research_session` span.
