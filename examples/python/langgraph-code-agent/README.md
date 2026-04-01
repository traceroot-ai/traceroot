# LangGraph Code Agent

Multi-agent code generator using LangGraph, instrumented with [Traceroot](https://traceroot.ai).

Orchestrates 4 agents in a pipeline with automatic retry on failure:

```
Plan → Code → Execute → Summarize (→ retry if failed)
```

## Setup

```bash
cp .env.example .env  # fill in your API keys
```

With `uv` (recommended):
```bash
uv run --no-project --python 3.13 --with-requirements requirements.txt python server.py
```

## Usage

**Server mode** (default):
```bash
python server.py

curl -X POST http://localhost:9999/code \
     -H "Content-Type: application/json" \
     -d '{"query": "2 sum in python"}'
```
