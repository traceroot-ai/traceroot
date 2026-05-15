# OpenRouter Tool Agent

ReAct-style agent with [OpenRouter](https://openrouter.ai/) tool calling, instrumented with [TraceRoot](https://traceroot.ai).

OpenRouter provides a unified API to 200+ models (GPT-4o, Claude, Llama, Gemini, Mistral, etc.). Since it's OpenAI-compatible, TraceRoot's OpenAI instrumentation captures all calls automatically — no extra configuration needed.

## Setup

```bash
cp .env.example .env  # fill in OPENROUTER_API_KEY and TRACEROOT_API_KEY
pnpm install
```

## Usage

```bash
pnpm demo        # tool-calling agent
```

## What it does

Runs three demo queries that exercise tool use:
1. Weather comparison (San Francisco vs Tokyo)
2. Stock price lookup + calculation (NVDA +10%)
3. Web search + summarization

Tools: `get_weather`, `get_stock_price`, `calculate`, `search_web`, `get_current_time`

## Model selection

Change the model by editing the `model` property in `ReActAgent`:

```ts
private readonly model = 'anthropic/claude-3-5-sonnet';
// or: 'google/gemini-2.0-flash'
// or: 'meta-llama/llama-3.3-70b-instruct'
```

See [openrouter.ai/models](https://openrouter.ai/models) for the full list.
