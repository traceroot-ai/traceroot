# Synthetic topic corpus

A deterministic generator of agent traces with **planted tasks**, used to check
that traces are grouped by what they were asked to do. It writes a label
manifest next to the traces, so a fit can be scored against ground truth.

## What it makes

- Up to 8 planted tasks (flight booking, hotel booking, refund processing, order
  cancellation, SQL analytics, code review, meeting summary, contract
  extraction), each with `--min-per-topic` to `--max-per-topic` traces (40 to 80
  by default). Two pairs are close neighbours on purpose (flights / hotels,
  refunds / cancellations).
- **Noise** traces: one-off requests with nothing in common
  (`--noise-share`, 12% of the planted traces by default).
- **Injection** traces (`--injections`, 4 by default), alternating two kinds. In a
  `tool_result` trace a planted-task trace has a tool result that tries to
  instruct the summarizer; it keeps its planted label. In a `request` trace the
  user's request itself is the instruction, so it shows no task and is labelled
  `noise`. Both carry the word `CANARY-<seed>`; a summary that contains it
  obeyed the data.
- Each trace is a small agent run: a root agent span, a planning model call,
  two to four tool calls and a final model call, with the request wording, names,
  places and ids varied per trace.

Everything is a function of the parameters. The same `--seed` gives the same
trace ids, texts and manifest on every run; nothing reads the clock. Traces are
timed at send time: each starts `offset_seconds` before the moment of sending,
spread over `--days` days and at least 15 minutes old.

## Commands

Run from the repository root.

```bash
# Label manifest only (nothing is sent)
uv run python -m scripts.topic_corpus manifest --seed 7 --out manifest.json

# Send through the real ingestion path: OTLP over HTTP to /api/v1/public/traces,
# then the ingest worker. The project's ingest key is read from the environment.
export TOPIC_CORPUS_PROJECT_KEY=...      # a key of the target project
uv run python -m scripts.topic_corpus send --seed 7 --marker "Northbeam Travel" --out manifest.json

# Remove the corpus again (traces, spans, summaries, group memberships)
uv run python -m scripts.topic_corpus clean --seed 7 --project-id <project id>
```

`clean` regenerates the same trace ids from the seed and parameters, so pass the
same ones you sent with. Use a development or evaluation project.

`--marker` puts a word in every trace's system prompt. Give two projects two
seeds and two markers to check that nothing from one appears in the other.

## The manifest

```json
{
  "params": { "seed": 7, "...": "..." },
  "topics": [{ "id": "flight_booking", "description": "...", "count": 60 }],
  "noise_count": 53,
  "traces": [
    { "trace_id": "...", "label": "flight_booking", "offset_seconds": 28782,
      "injection": null, "request": "Book me a flight ..." }
  ]
}
```

`label` is a planted task id, or `noise`. Absolute times are not recorded, so
two runs with one seed give byte-identical manifests.

## Tests

```bash
uv run pytest tests/test_topic_corpus.py
```
