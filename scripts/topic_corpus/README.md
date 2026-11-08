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

# Remove the corpus again (traces, spans, summaries, group memberships). Groups are not
# removed: they belong to the project's fit, not to a trace.
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

## Scoring a fit

After the groups exist (the app's scheduler fits them, or ask for a refresh), score them
against the manifest(s) of the project:

```bash
uv run python -m scripts.topic_corpus.score --manifest manifest.json --project-id <project id>
```

It prints the numbers below as JSON and exits 1 when any threshold fails. Only
summarized traces are scored. Truth is each trace's manifest label; the prediction is the
group it is in, or none.

| Measure | Threshold |
| --- | --- |
| `ari`: adjusted Rand index over the planted traces, "no group" counted as one more cluster | at least 0.7 |
| `topic_recall`: per planted topic, share of its traces in the one group holding most of them | at least 0.8 each |
| `mixed_groups`: groups where two or more planted topics each make up over 30% | none |
| `unassigned_share`: planted traces in no group | at most 0.2 |

`noise_unassigned_share` (true one-off requests left in no group) is reported for
information. A `request` injection trace shows no task and is labelled `noise`.

## Comparing with an incremental assignment

The fit is compared with assigning each summary, in time order, to an existing group or a
new one by a model that sees the few nearest groups (no refit):

```bash
uv run python -m scripts.topic_corpus.export_digests --project-id <id> --out digests.json
(cd frontend/worker && npx dotenv -e ../../.env -- npx tsx \
  src/ee/task-groups/eval/run-incremental.ts ../../digests.json ../../incremental.json)
uv run python -m scripts.topic_corpus.score --manifest manifest.json --assignments incremental.json
```

`run-incremental.ts` takes `--shuffle <seed>` to run in a shuffled order. The output holds the
model calls, their cost and the run time next to the assignments.

## Tests

```bash
uv run pytest tests/test_topic_corpus.py tests/test_topic_corpus_score.py \
  tests/test_topic_corpus_export.py tests/test_topic_corpus_clean.py
```
