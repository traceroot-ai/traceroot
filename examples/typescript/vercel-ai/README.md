# Vercel AI SDK Agent — TraceRoot Observability

A multi-step tool-use agent built with the [Vercel AI SDK](https://sdk.vercel.ai/) (`ai` package),
fully instrumented with TraceRoot.

## What gets traced

| Signal | Details |
|---|---|
| LLM calls | `generateText`, `streamText`, `generateObject`, `streamObject` |
| Tool calls | Each tool invocation as a child span with input/output |
| Token usage | Prompt + completion tokens per call |
| Model name | Captured on every LLM span |
| Latency | End-to-end and per-step timing |

## Setup

```bash
cp .env.example .env
# Fill in TRACEROOT_API_KEY and OPENAI_API_KEY
pnpm install
pnpm demo
```

## Usage in your own project

```typescript
// No instrumentModules needed for Vercel AI SDK
TraceRoot.initialize();

// Add experimental_telemetry to each call
const result = await generateText({
  model: openai('gpt-4o-mini'),
  prompt: 'Hello!',
  experimental_telemetry: { isEnabled: true },  // ← activates tracing
});
```

## Environment variables

| Variable | Description |
|---|---|
| `TRACEROOT_API_KEY` | Your TraceRoot API key |
| `TRACEROOT_HOST_URL` | TraceRoot endpoint (default: `https://app.traceroot.ai`) |
| `OPENAI_API_KEY` | OpenAI API key (swap for any provider) |