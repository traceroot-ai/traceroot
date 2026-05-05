# OpenRouter Tool Agent

ReAct-style agent that calls models through [OpenRouter](https://openrouter.ai) using the official `openai` npm SDK, instrumented with [TraceRoot](https://traceroot.ai).

OpenRouter is OpenAI-wire-compatible — point the SDK at OpenRouter's `baseURL`, pick any model from their catalog (e.g. `anthropic/claude-3-5-sonnet`, `google/gemini-pro-1.5`, `meta-llama/llama-3.3-70b-instruct`), and TraceRoot's existing OpenAI instrumentation captures the calls automatically.

## Setup

```bash
cp .env.example .env  # fill in OPENROUTER_API_KEY and TRACEROOT_API_KEY
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

## Switching models

Change the `model` field in `ReActAgent`:

```ts
private readonly model = 'google/gemini-pro-1.5';
private readonly model = 'meta-llama/llama-3.3-70b-instruct';
private readonly model = 'openai/gpt-4o-mini';
```

Browse the full catalog at [openrouter.ai/models](https://openrouter.ai/models).
