# LiteLLM Tool Agent

ReAct-style agent that calls a [LiteLLM](https://github.com/BerriAI/litellm) proxy using the official `openai` npm SDK, instrumented with [TraceRoot](https://traceroot.ai).

LiteLLM is a unified OpenAI-compatible proxy in front of 100+ providers (OpenAI, Anthropic, Groq, Mistral, Together, Bedrock, Ollama…). On the TypeScript side, LiteLLM is the proxy server only — there is no native TS SDK. Users point the `openai` npm SDK at the proxy's URL, and TraceRoot's existing OpenAI instrumentation captures every call automatically.

## Start the LiteLLM proxy

LiteLLM runs as a Python process. In a separate terminal:

```bash
uv tool install 'litellm[proxy]'   # or: pip install 'litellm[proxy]'
export OPENAI_API_KEY=sk-...        # or any provider key matching the model below
litellm --model gpt-3.5-turbo
```

The proxy listens on `http://0.0.0.0:4000` by default. See the [LiteLLM proxy quick start](https://docs.litellm.ai/docs/proxy/quick_start) for routing to other providers (Anthropic, Groq, etc.).

## Setup

```bash
cp .env.example .env  # fill in TRACEROOT_API_KEY (LITELLM_* defaults work for the quick start above)
pnpm install
```

## Usage

```bash
pnpm demo        # tool-calling agent
pnpm streaming   # streaming pipeline (generator support)
```

## What it does

`pnpm demo` runs three demo queries that exercise tool use:
1. Weather comparison (San Francisco vs Tokyo)
2. Stock price lookup + calculation (NVDA +10%)
3. Web search + summarization

Tools: `get_weather`, `get_stock_price`, `calculate`, `search_web`, `get_current_time`

`pnpm streaming` runs a streaming pipeline that demonstrates `observe()` wrapping async generators — the span stays open across token boundaries so trace duration reflects real end-to-end latency.

## Why no `LiteLLMInstrumentation`?

LiteLLM's TS surface is the proxy's HTTP API — an OpenAI-compatible wire protocol. Calls from your TypeScript code go through the standard `openai` npm package, which TraceRoot already patches via [`OpenAIInstrumentation`](https://github.com/traceroot-ai/traceroot-ts/blob/main/packages/traceroot/src/instrumentation.ts). Spans are emitted with no extra wiring; a separate LiteLLM instrumentor would be redundant.

(For Python, the situation is different: `litellm` is a real SDK that benefits from a dedicated instrumentor. See issue [#734](https://github.com/traceroot-ai/traceroot/issues/734) for the Python side.)

## Models

The `model` field in `agent.ts` must match the alias your proxy is serving. The default `gpt-3.5-turbo` matches `litellm --model gpt-3.5-turbo`. To route through a different provider, change the proxy startup command and update the `model` constant in `ReActAgent` to match.

## Notes

- If you see `ECONNREFUSED 0.0.0.0:4000`, the proxy isn't running — start it as shown above.
- When the proxy has no `master_key` configured (the quick-start case), the `apiKey` value is ignored — any string works. We default to `sk-1234`, the placeholder used in [LiteLLM's own JS example](https://docs.litellm.ai/docs/proxy/user_keys). Set `LITELLM_API_KEY` in `.env` if your proxy enforces a master key.
- LiteLLM lets you swap providers without touching this code — just restart the proxy with a different `--model` and update the model constant.
