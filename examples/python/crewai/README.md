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

The example follows the same TraceRoot shape as the other Python examples in this repo:

- dotenv is loaded before model/SDK setup
- CrewAI telemetry is disabled before `crewai` imports so it does not fight TraceRoot for the global tracer provider
- TraceRoot is initialized once before importing CrewAI
- the top-level session remains wrapped in `@observe`
- the mocked internal tools are wrapped in `@observe(type="tool")`
- shared session metadata is attached with `using_attributes`, `update_current_trace`, and `update_current_span`
- traces are flushed in a `finally` block so failed runs still export captured spans

The current installable dependency set pins `traceroot==0.0.7`, because newer published TraceRoot releases do not yet resolve cleanly with stable CrewAI releases. The example keeps a compatibility layer so it still follows the same instrumentation style as the other Python examples:

- top-level CrewAI session span
- explicit tool/helper spans for the mocked internal tools
- attached session metadata and final output on the active trace/span

If a future compatible TraceRoot release adds modern provider integrations for this stack, the example code is already structured to use them when available.

## Gemini Notes

For Gemini, the example accepts keys in this order:

1. `MODEL_API_KEY`
2. `GOOGLE_API_KEY`
3. `GEMINI_API_KEY`

If Google returns `API key expired` or `API_KEY_INVALID`, the issue is with the credential Google received, not with CrewAI tool wiring. In that case, set a fresh key in the example-local `.env` using `MODEL_API_KEY=...` to ensure it overrides any stale environment variable.

## Provider Auth Notes

The example now rewrites common authentication failures into clearer runtime messages for:

- OpenAI and OpenAI-compatible endpoints
- Anthropic
- Google Gemini

That keeps provider-specific setup errors easier to diagnose without changing the underlying crew workflow.
