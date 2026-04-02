# LlamaIndex RAG

Simple RAG pipeline using LlamaIndex, instrumented with [TraceRoot](https://traceroot.ai).

## Setup
```bash
cp .env.example .env  # fill in your API keys
```

With `uv` (recommended):
```bash
uv run --no-project --python 3.13 --with-requirements requirements.txt python main.py
```

## What it does
Creates an in-memory document index and queries it. Demonstrates RAG pipeline tracing.
