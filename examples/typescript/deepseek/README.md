# DeepSeek Tool Agent

ReAct-style agent that calls [DeepSeek](https://www.deepseek.com/) models using the official `openai` npm SDK, instrumented with [TraceRoot](https://traceroot.ai).

DeepSeek's API is OpenAI-wire-compatible — point the SDK at `https://api.deepseek.com`, pick `deepseek-flash` or `deepseek-v4-pro`, and TraceRoot's existing OpenAI instrumentation captures the calls automatically.

## Setup

```bash
cp .env.example .env  # fill in DEEPSEEK_API_KEY and TRACEROOT_API_KEY
pnpm install
```

## Usage

```bash
pnpm demo
```

## What it does

Runs three demo queries that exercise tool use:
1. Weather comparison (San Francisco vs Tokyo)
2. Stock price lookup + calculation (NVDA +10%)
3. Web search + summarization

Tools: `get_weather`, `get_stock_price`, `calculate`, `search_web`, `get_current_time`

> All tools except `calculate` and `get_current_time` return hardcoded mock data — they exist to exercise tool-call instrumentation, not to demo real services. In particular, `search_web` does **not** hit a real search API; it returns canned strings.

## Models

| Model | Notes |
|---|---|
| `deepseek-flash` (default) | DeepSeek-V4.1-Flash — supports tool calling, used by this demo |
| `deepseek-v4-pro` | DeepSeek-V4-Pro — supports tool calling |

Switch the default by changing the `model` field in `ReActAgent`.

Both models run in [thinking mode](https://api-docs.deepseek.com/guides/thinking_mode) by default. In thinking mode, every request that carries `tools` must send back the `reasoning_content` of all earlier assistant turns, or the API returns a 400. This ReAct loop stores final answers without `reasoning_content`, so each request sends `"thinking": {"type": "disabled"}`. To use thinking mode, store each assistant message's `reasoning_content` in the history and remove that setting.

## Notes

DeepSeek's API has occasional rate-limit and availability issues. Errors mid-demo are usually upstream — check [status.deepseek.com](https://status.deepseek.com) before opening an issue against this repo.
