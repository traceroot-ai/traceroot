# Groq Agent (TypeScript)

ReAct-style agent with [Groq](https://groq.com/) tool use, instrumented with [TraceRoot](https://traceroot.ai).

Groq's API is OpenAI-wire-compatible, so this example uses the official `openai` SDK with `baseURL` pointed at Groq's OpenAI-compatible endpoint (`https://api.groq.com/openai/v1`). TraceRoot's OpenAI integration captures all calls automatically — no extra configuration needed.

## Setup

```bash
cp .env.example .env  # fill in GROQ_API_KEY and TRACEROOT_API_KEY
npm install
npm start
```

## What it does

Runs two demo queries that exercise tool use:
1. Weather comparison (San Francisco vs Tokyo)
2. Stock price lookup + calculation (NVDA +10%)

Tools: `get_weather`, `get_stock_price`, `calculate`, `get_current_time`

## Model selection

Change the model by passing a different Groq model string to `new ReActAgent()`:

```typescript
const agent = new ReActAgent("llama-3.3-70b-versatile");
const agent = new ReActAgent("llama-3.1-8b-instant");
const agent = new ReActAgent("openai/gpt-oss-120b");
```

See [console.groq.com/docs/models](https://console.groq.com/docs/models) for the full list.

## TraceRoot UI

After running the example, open [app.traceroot.ai](https://app.traceroot.ai) to view the captured trace. You'll see the full agent span, nested LLM calls, and individual tool invocations with their inputs and outputs.
