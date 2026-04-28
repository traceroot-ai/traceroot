# OpenRouter Tool Agent

ReAct-style agent that calls models through [OpenRouter](https://openrouter.ai) using the official `openai` Python SDK, instrumented with [TraceRoot](https://traceroot.ai).

OpenRouter is OpenAI-wire-compatible — point the SDK at OpenRouter's `base_url`, pick any model from their catalog (e.g. `anthropic/claude-3-5-sonnet`, `google/gemini-pro-1.5`, `meta-llama/llama-3.3-70b-instruct`), and TraceRoot's existing OpenAI integration captures the calls automatically.

## Setup

```bash
cp .env.example .env  # fill in OPENROUTER_API_KEY and TRACEROOT_API_KEY
```

With `uv` (recommended):
```bash
uv run --no-project --python 3.13 --with-requirements requirements.txt python main.py
```

Or with pip:
```bash
pip install -r requirements.txt
python main.py
```

## What it does

Runs two demo queries that exercise tool use:
1. Weather comparison (San Francisco vs Tokyo)
2. Stock price lookup + calculation (NVDA +10%)

Tools: `get_weather`, `get_stock_price`, `calculate`, `get_current_time`

## Switching models

Change the `model` argument in `ReActAgent.__init__`:

```python
agent = ReActAgent(model="google/gemini-pro-1.5")
agent = ReActAgent(model="meta-llama/llama-3.3-70b-instruct")
agent = ReActAgent(model="openai/gpt-4o-mini")
```

Browse the full catalog at [openrouter.ai/models](https://openrouter.ai/models).
