# DeepSeek Tool Agent

ReAct-style agent that calls [DeepSeek](https://www.deepseek.com/) models using the official `openai` Python SDK, instrumented with [TraceRoot](https://traceroot.ai).

DeepSeek's API is OpenAI-wire-compatible — point the SDK at `https://api.deepseek.com`, pick `deepseek-flash` or `deepseek-v4-pro`, and TraceRoot's existing OpenAI integration captures the calls automatically.

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
| `deepseek-flash` (default) | DeepSeek-V4.1-Flash — supports tool calling, used by this demo |
| `deepseek-v4-pro` | DeepSeek-V4-Pro — supports tool calling |

Switch the default by passing `model=` to `ReActAgent(...)`.

Both models run in [thinking mode](https://api-docs.deepseek.com/guides/thinking_mode) by default. In thinking mode, every request that carries `tools` must send back the `reasoning_content` of all earlier assistant turns, or the API returns a 400. This ReAct loop keeps only `content`, so each request sends `"thinking": {"type": "disabled"}`. To use thinking mode, store each assistant message's `reasoning_content` in the history and remove that setting.

## Notes

DeepSeek's API has occasional rate-limit and availability issues. Errors mid-demo are usually upstream — check [status.deepseek.com](https://status.deepseek.com) before opening an issue against this repo.
