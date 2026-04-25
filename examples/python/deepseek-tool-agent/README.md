# DeepSeek Tool Agent

ReAct-style agent that calls [DeepSeek](https://www.deepseek.com/) models using the official `openai` Python SDK, instrumented with [TraceRoot](https://traceroot.ai).

DeepSeek's API is OpenAI-wire-compatible — point the SDK at `https://api.deepseek.com`, pick `deepseek-chat` (V3) or `deepseek-reasoner` (R1), and TraceRoot's existing OpenAI integration captures the calls automatically.

## Setup

```bash
cp .env.example .env  # fill in DEEPSEEK_API_KEY and TRACEROOT_API_KEY
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

## Models

| Model | Notes |
|---|---|
| `deepseek-chat` (default) | DeepSeek-V3 — fast, supports tool calling, used by this demo |
| `deepseek-reasoner` | DeepSeek-R1 — reasoning model with thinking tokens; needs custom response handling, not wired into the ReAct loop here |

Switch the default by passing `model=` to `ReActAgent(...)`.

## Notes

DeepSeek's API has occasional rate-limit and availability issues. Errors mid-demo are usually upstream — check [status.deepseek.com](https://status.deepseek.com) before opening an issue against this repo.
