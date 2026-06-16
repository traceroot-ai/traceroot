# Live-stack E2E suite

Emit-and-assert tests that drive the **running** stack (backend `:8000`, ClickHouse,
Redis, Celery + TS detector workers) the way a real SDK does, and assert on what
persists. They stress recent worker/detector changes:

| File | What it proves |
|------|----|
| `test_vercel_cache_tokens.py` | Vercel `ai.usage.*` cache read/write breakdown persists; gross totals are gated to LLM spans (no AGENT-wrapper double-count); graceful v4/v5/v6 degradation. |
| `test_token_bucket_clamping.py` | NET-emitter clamp: when cache tokens meet/exceed the reported input, the uncached bucket floors to 0 and the stored gross input reconstructs from the cache buckets. |
| `test_llm_only_token_estimation.py` | Text-based token estimation runs only for LLM-kind spans, and is skipped for the `traceroot.claude-agent-sdk` scope. |
| `test_detector_enqueue_settle.py` | Detection enqueues exactly once per trace (no duplicate enqueue across batches) and evaluates only after 60s of quiescence (incl. the streaming early-root case). |

## Prerequisites

- The stack is **up** (you start it — see repo root). Postgres/Redis/ClickHouse/MinIO
  in Docker; backend + workers running.
- A **project API key** from the UI → exported as `TRACEROOT_API_KEY`.
- For the detector tests: a **detector** for that project, **enabled**, **sample rate 100%**, with
  **empty trigger conditions** (always triggers). Create it in the UI. The full-timing
  tests also need the **TS detector worker** running and a judge/BYOK provider for the
  run to *complete* (run-count/timing assertions hold even if the judge fails).

Everything else self-configures from the repo `.env` (loaded by the root
`tests/conftest.py`): `INTERNAL_API_SECRET`, `CLICKHOUSE_*`, `DATABASE_URL`,
`REDIS_URL`. The project id is derived from the API key via `/api/v1/public/whoami`;
the detector is auto-discovered from Postgres.

## Running

```bash
# fast layer (synthetic emit+assert; ~seconds each)
TRACEROOT_E2E=1 TRACEROOT_API_KEY=tr_... uv run pytest tests/e2e -v

# include the detector full-timing tests (each waits out the 60s window, ~70–130s)
TRACEROOT_E2E=1 TRACEROOT_E2E_SLOW=1 TRACEROOT_API_KEY=tr_... uv run pytest tests/e2e -v
```

Without `TRACEROOT_E2E=1` (or without the API key) every test **skips**, so a normal
`uv run pytest` run is unaffected. Optional overrides: `TRACEROOT_HOST` (default
`http://localhost:8000`).

## How it works

`harness.py` builds OTLP/JSON with the existing `tests/fixtures/otel_payloads.py`
builders, converts to protobuf via `ParseDict` (the exact reverse of the backend's
`MessageToDict` decode), and POSTs to `/api/v1/public/traces` with the Bearer key —
one `emit()` is one ingest batch, so multi-batch traces are several `emit()` calls
sharing a `trace_id`. Assertions read back through the internal-secret trace endpoint
(`usage_details` + `cost`), the settle-status endpoint, and ClickHouse
(`detector_runs` / `detector_findings`). Cost is checked against the real
`standard-model-prices.json` (regex-matched), not hard-coded rates.
