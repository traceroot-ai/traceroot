# CrewAI Sequential Research Crew (Python, OpenAI)

Sequential multi-agent research workflow using [CrewAI](https://crewai.com/) with OpenAI and [TraceRoot](https://traceroot.ai).

## Setup

```bash
cp .env.example .env
```

Fill in:

```env
TRACEROOT_API_KEY=your_traceroot_api_key_here
MODEL_NAME=gpt-4o-mini
MODEL_API_KEY=your_openai_api_key_here
```

The example prefers `examples/python/crewai/.env` when present and loads it with override enabled, so a local example key can replace stale shell or repo-wide environment variables.

Run it with `uv`:

```bash
uv run --no-project --python 3.13 --with-requirements requirements.txt python main.py
```

## What It Does

Runs a sequential 3-agent CrewAI workflow:

1. `Research Lead` turns mocked internal signals into a grounded research brief
2. `Risk Reviewer` critiques the brief for missing controls and rollout gaps
3. `Recommendation Writer` converts both into a final markdown memo

The example uses mocked internal tools instead of live web/search APIs, so it only needs TraceRoot credentials plus an OpenAI API key.

## TraceRoot Instrumentation

The example follows the same overall TraceRoot shape as the other Python examples in this repo:

- dotenv is loaded before model and SDK setup
- CrewAI telemetry is disabled before importing `crewai`
- the top-level session is wrapped in `@observe`
- the mocked helper tools are wrapped in `@observe(type="tool")`
- session metadata is attached with `using_attributes`, `update_current_trace`, and `update_current_span`
- traces are flushed in a `finally` block so failed runs still export captured spans

The current installable dependency set pins `traceroot==0.0.7`, because newer published TraceRoot releases do not yet resolve cleanly with stable CrewAI releases. The example keeps a compatibility layer so the tracing flow still stays consistent with the other examples.

## OpenAI Notes

The example accepts OpenAI keys in this order:

1. `MODEL_API_KEY`
2. `OPENAI_API_KEY`

If OpenAI returns an authentication error, the issue is with the credential OpenAI received, not with the CrewAI wiring. In that case, set a fresh key in the example-local `.env` using `MODEL_API_KEY=...` to ensure it overrides any stale environment variable.

If OpenAI returns a temporary `429` or rate-limit error, retry the run after a few minutes or reduce the request frequency.

## Adding a TraceRoot UI Screenshot

If you want to show proof in the PR that the CrewAI run was registered successfully in TraceRoot:

1. Add valid keys to `examples/python/crewai/.env`.
2. Run the example:

   ```bash
   uv run --no-project --python 3.13 --with-requirements requirements.txt python main.py
   ```

3. Open the TraceRoot UI and look for the latest run with:
   - session id: `crewai_py_openai_session`
   - tags: `example`, `python`, `crewai`, `openai`
   - top-level span: `run_research_session`

4. Open the trace details page and confirm you can see the CrewAI run plus the mocked tool spans.
5. Take a screenshot that clearly shows:
   - the trace/session name or session id
   - the span tree or span list
   - enough of the page to show it is the TraceRoot UI

6. Save the screenshot in this folder as:

   ```text
   examples/python/crewai/traceroot-ui.png
   ```

7. Add it to the README with:

   ```md
   ## TraceRoot UI

   ![TraceRoot UI showing the CrewAI run](./traceroot-ui.png)
   ```

8. Commit both the image and the README update so the screenshot renders in the PR and on GitHub.
