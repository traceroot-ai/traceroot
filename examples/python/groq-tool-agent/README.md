# Groq Tool Agent

ReAct-style agent with Groq tool calling, instrumented with [traceroot](https://traceroot.ai).

## Setup

```bash
cp .env.example .env  # fill in your API keys
```

With `uv` (recommended):
```bash
uv run --no-project --python 3.13 --with-requirements requirements.txt python main.py
```

Or with `pip`:
```bash
pip install -r requirements.txt
python main.py
```

## What it does

Runs two demo queries that exercise tool use:
1. Weather comparison (San Francisco vs Tokyo)

Tools: `get_weather`, `get_stock_price`, `calculate`, `get_current_time`
