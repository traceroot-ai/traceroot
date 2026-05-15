# OpenRouter Tool Agent

ReAct-style agent with [OpenRouter](https://openrouter.ai/) streaming and tool use, instrumented with [TraceRoot](https://traceroot.ai).

OpenRouter provides a unified API to 200+ models (GPT-4o, Claude, Llama, Gemini, Mistral, etc.). Since it's OpenAI-compatible, TraceRoot's OpenAI integration captures all calls automatically — no extra configuration needed.

## Setup

```bash
cp .env.example .env  # fill in OPENROUTER_API_KEY and TRACEROOT_API_KEY
```

With `uv` (recommended):
```bash
uv run --no-project --python 3.13 --with-requirements requirements.txt python main.py
```

## Streaming pipeline

Demonstrates `@observe` on async generators — spans stay open until the last token, capturing real end-to-end latency.

```bash
uv run --no-project --python 3.13 --with-requirements requirements.txt python streaming-pipeline.py
```

## What it does

Runs two demo queries that exercise tool use:
1. Weather comparison (San Francisco vs Tokyo)
2. Stock price lookup + calculation (NVDA +10%)

Tools: `get_weather`, `get_stock_price`, `calculate`, `get_current_time`

## Model selection

Change the model by passing a different OpenRouter model string to `ReActAgent()`:

```python
agent = ReActAgent(model="anthropic/claude-3-5-sonnet")
agent = ReActAgent(model="google/gemini-2.0-flash")
agent = ReActAgent(model="meta-llama/llama-3.3-70b-instruct")
```

See [openrouter.ai/models](https://openrouter.ai/models) for the full list.
