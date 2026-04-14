# CrewAI Agent

Multi-agent crew using CrewAI, instrumented with [TraceRoot](https://traceroot.ai).

## Setup
```bash
cp .env.example .env  # fill in your API keys
```

With `uv` (recommended):
```bash
uv run --no-project --python 3.13 --with-requirements requirements.txt python main.py
```

## What it does
Runs a 2-agent crew (researcher + writer) that gathers weather data and writes a comparison report.
