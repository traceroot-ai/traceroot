# LangSmith → TraceRoot importer

Moves historical LangSmith traces into a TraceRoot project. It reads LangSmith runs,
converts each run to an OpenInference-shaped OTLP span (the same attributes the live
LangChain integration sends), and posts them to `/api/v1/public/traces`.

## Sources

| Flag | Reads | Needs |
|---|---|---|
| `--parquet PATH` | A LangSmith bulk-export file, or the export folder (walked recursively) | `pyarrow`; bulk export needs LangSmith Plus or Enterprise |
| `--jsonl PATH` | Runs saved one JSON object per line (`Run.model_dump(mode="json")`) | — |
| `--api-project NAME_OR_ID` | Runs pulled live from the LangSmith API | `langsmith`, `LANGSMITH_API_KEY`; works on every plan, slower for large ranges |

## Usage

Run from the repo root.

```bash
# 1. Preview: convert, print per-day totals and a few trace trees, send nothing
python -m scripts.import_langsmith --parquet ./langsmith-export --dry-run

# 2. Import into the project that owns TRACEROOT_API_KEY
export TRACEROOT_API_KEY=tr-...            # project-scoped key
export TRACEROOT_HOST_URL=https://app.traceroot.ai
python -m scripts.import_langsmith --parquet ./langsmith-export \
    --start 2026-08-01 --end 2026-11-01 --redact basic
```

After sending, the importer re-reads 20 random traces from TraceRoot and compares
span counts and LLM token totals (`--verify N`, `0` to skip). It exits non-zero on a
mismatch.

## What gets mapped

| LangSmith run | TraceRoot span |
|---|---|
| `trace_id` | trace ID (the same UUID, so traces are easy to cross-reference) |
| `id`, `parent_run_id` | span ID / parent span ID (8-byte hash of the run UUID) |
| `run_type` | `openinference.span.kind`: llm→LLM, tool→TOOL, retriever, embedding, everything else→CHAIN; a chain named after `lc_agent_name` → AGENT |
| `inputs`, `outputs` | `input.value`, `output.value` (`{"output": x}` is unwrapped) |
| `error` | span status ERROR; first line as the status message, full text in metadata |
| `prompt_tokens`, `completion_tokens`, cache details | `llm.token_count.*` on **LLM spans only** |
| model, provider | `llm.model_name`, `llm.provider` |
| `thread_id` / `session_id` / `conversation_id`, `user_id` metadata | `session.id`, `user.id` |
| metadata, tags, `feedback_stats` | span metadata; root spans also carry trace metadata with `langsmith.feedback` |

Every span and trace carries `import.source: langsmith` in its metadata.

## Design notes

- **No double counting.** LangSmith rolls token counts and cost up onto every
  ancestor run. Only `llm` runs get token attributes, so each call is priced once.
- **Idempotent.** IDs are derived from LangSmith's UUIDs, and TraceRoot's span
  storage keeps one row per (project, trace, start time, span). Re-running an import,
  or resuming after a failure, rewrites rows instead of duplicating them.
- **Cost.** By default TraceRoot prices imported calls from its own pricing table,
  like live traces. `--use-langsmith-cost` keeps LangSmith's recorded cost instead.
- **Streaming.** Runs are converted and sent in batches (`--batch-spans`,
  `--batch-bytes`), so memory stays flat on large exports. `--min-interval` throttles
  requests. 429 and 5xx responses are retried with backoff.

## Before a customer import

- **Redaction.** Raw ingest bypasses the SDK's `redact` option, so redact here.
  `--redact basic` blanks emails, phone numbers, and US SSNs. Names and addresses need
  a customer hook: `--redact path/to/hook.py:fn`, a function that takes and returns a
  span's attribute dict. A hook that does not return a dict aborts the import.
- **Retention.** Imported traces keep their original dates. They are only visible
  inside the project plan's retention window (15/30/90 days, unlimited on Enterprise).
- **Detectors.** Ingest queues detector runs for every new trace. Pause the project's
  detectors during a large backfill unless you want them to run over the history.
- **Usage.** Imported spans count as ingestion on metered plans.
- **Overlap.** If the customer already traces live to TraceRoot, set `--end` to the
  cutover time so the same executions are not imported twice under different IDs.
- **Data handling.** Prefer running the importer where the customer's export lives
  (their bucket, their machine) so only redacted spans leave their environment.
