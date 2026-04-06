# CrewAI Sequential Research Crew (Python)

Provider-agnostic multi-agent research workflow using [CrewAI](https://crewai.com/), instrumented with [TraceRoot](https://traceroot.ai).

## Setup

```bash
cp .env.example .env  # fill in your API keys
```

With `uv` (recommended):
```bash
uv run --no-project --python 3.13 --with-requirements requirements.txt python main.py
```

The example prefers `examples/python/crewai/.env` when present and loads it with override enabled, so a local example key can replace stale shell or repo-wide environment variables.

## Model Configuration

The example is provider-agnostic at runtime.

Default OpenAI-style setup:

```env
MODEL_PROVIDER=openai
MODEL_NAME=gpt-4o-mini
MODEL_API_KEY=your_openai_api_key_here
```

Anthropic example:

```env
MODEL_PROVIDER=anthropic
MODEL_NAME=claude-sonnet-4-5
MODEL_API_KEY=your_anthropic_api_key_here
```

Gemini example:

```env
MODEL_PROVIDER=google
MODEL_NAME=gemini-2.5-flash
MODEL_API_KEY=your_gemini_api_key_here
```

OpenAI-compatible endpoint example:

```env
MODEL_PROVIDER=openai-compatible
MODEL_NAME=gpt-4o-mini
MODEL_API_KEY=your_api_key_here
MODEL_BASE_URL=https://your-endpoint.example/v1
```

LiteLLM fallback example:

```env
MODEL_PROVIDER=litellm
MODEL_NAME=openrouter/openai/gpt-4o-mini
MODEL_API_KEY=your_router_api_key_here
```

## What It Does

Runs a sequential 3-agent CrewAI workflow:

1. `Research Lead` turns mocked internal signals into a grounded research brief
2. `Risk Reviewer` critiques the brief for missing controls and rollout gaps
3. `Recommendation Writer` converts both into a final markdown memo

The example uses mocked internal tools instead of live web/search APIs, so it only needs TraceRoot credentials plus one model credential.

## TraceRoot Instrumentation

The example keeps the same overall instrumentation shape as the other Python examples in this repo:

- dotenv is loaded before model/SDK setup
- TraceRoot is initialized once near the top
- the top-level CrewAI run is wrapped in `@observe`
- mocked tool helpers are wrapped in `@observe(type="tool")`
- shared session metadata is attached when the installed TraceRoot SDK supports it

The code supports both TraceRoot SDK generations:

- Newer TraceRoot SDKs use the `Integration` + `observe` API and can enable provider auto-instrumentation for:
  - `openai` or `openai-compatible` -> `Integration.OPENAI`
  - `anthropic` -> `Integration.ANTHROPIC`
  - `google` -> `Integration.GOOGLE_GENAI`
- The current dependency set pins `traceroot==0.0.7`, which is the resolver-compatible version with CrewAI today. That path still captures the top-level crew span and tool spans, but it does not expose the newer provider auto-instrumentation helpers yet.

For `litellm` or unsupported providers, the example remains manually traced even on newer TraceRoot SDKs.

## Gemini Notes

For Gemini, the example accepts keys in this order:

1. `MODEL_API_KEY`
2. `GOOGLE_API_KEY`
3. `GEMINI_API_KEY`

If Google returns `API key expired` or `API_KEY_INVALID`, the issue is with the credential Google received, not with CrewAI tool wiring. In that case, set a fresh key in the example-local `.env` using `MODEL_API_KEY=...` to ensure it overrides any stale environment variable.
