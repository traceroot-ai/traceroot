# OpenRouter Tool Agent

ReAct-style agent using [OpenRouter](https://openrouter.ai/) with tool calling, instrumented with [TraceRoot](https://traceroot.ai).

OpenRouter is OpenAI-compatible, so TraceRoot's OpenAI integration captures all calls automatically — no extra configuration needed.

## Setup

```bash
cp .env.example .env  # fill in your API keys
pnpm install
```

## Usage

```bash
pnpm demo
```

## What it does

Runs two demo queries that exercise tool use:
1. Weather comparison (San Francisco vs Tokyo)
2. Stock price lookup + calculation (NVDA +10%)

Tools: `get_weather`, `get_stock_price`, `calculate`, `get_current_time`

## Model selection

The example defaults to `anthropic/claude-3-5-sonnet`. You can change the model in `agent.ts`:

```typescript
// Pick one:
'openai/gpt-4o'
'google/gemini-2.0-flash-001'
'meta-llama/llama-3.1-70b-instruct'
```

See [OpenRouter models](https://openrouter.ai/models) for the full list.
