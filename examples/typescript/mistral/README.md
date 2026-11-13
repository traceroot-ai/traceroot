# Mistral Tool Agent

ReAct-style agent that calls [Mistral AI](https://mistral.ai) models using the official [`@mistralai/mistralai`](https://www.npmjs.com/package/@mistralai/mistralai) v2 SDK, instrumented with [TraceRoot](https://traceroot.ai).

## Setup

```bash
cp .env.example .env  # fill in MISTRAL_API_KEY and TRACEROOT_API_KEY
pnpm install
```

## Usage

```bash
pnpm demo
```

## What it does

Runs one demo query by default so it works reliably under Mistral free-tier rate limits. Use `pnpm demo:full` to run all three demo queries:

1. Weather comparison (San Francisco vs Tokyo)
2. Stock price lookup + calculation (NVDA +10%)
3. Web search + summarization

Tools: `get_weather`, `get_stock_price`, `calculate`, `search_web`, `get_current_time`

> All tools except `calculate` and `get_current_time` return hardcoded mock data — they exist to exercise tool-call instrumentation, not to demo real services.

## A note on instrumentation

Auto-instrumentation for the Mistral SDK is tracked in `traceroot-ts` ([issue #739](https://github.com/traceroot-ai/traceroot/issues/739)) and isn't shipped yet. Until it is, this example wraps `mistral.chat.complete` with `observe()` via the small [`traced-mistral.ts`](./traced-mistral.ts) helper, which emits the same OpenInference span attributes a future auto-instrumentor would:

| Attribute | Source |
|---|---|
| `openinference.span.kind` | `"LLM"` |
| `llm.system` / `llm.provider` | `"mistralai"` |
| `llm.model_name` | request `model` |
| `llm.token_count.prompt` / `completion` / `total` | response `usage.*` |
| `llm.invocation_parameters` | request body minus `messages` |
| `input.value` / `input.mime_type` | request `messages` |
| `output.value` / `output.mime_type` | response `choices[0].message` |
| `llm.response.finish_reasons` | response `choices[0].finishReason` |

**Why this matters:** trace shape stays correct *today* — no fake placeholders, no missing token counts. When the SDK ships native instrumentation, migration is two edits:

1. Add `instrumentModules: { mistral: mistralSdk }` to `TraceRoot.initialize(...)`.
2. Replace `tracedComplete(mistral, args)` with `mistral.chat.complete(args)` and delete `traced-mistral.ts`.

The agent loop and tool plumbing don't change.

## Models

| Model | Notes |
|---|---|
| `mistral-large-latest` (default) | Mistral's flagship; supports tool calling. Used by this demo. |
| `mistral-medium-latest` | Cheaper / faster, also supports tool calling. |
| `mistral-small-latest` | Lightweight; tool calling supported on recent revisions. |

Switch the default by changing the `model` field in `ReActAgent`.

## Notes

`@mistralai/mistralai` v2 is **ESM-only**, which is why `package.json` sets `"type": "module"` and the helper imports with the `.js` extension (`./traced-mistral.js`) — that's the standard NodeNext + ESM convention even when the source files are `.ts`.
