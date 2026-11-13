# Task groups (shown as "Topics")

Groups a project's traces by the task they were asked to do. This directory is
the per-trace half, in TypeScript; the periodic fit that creates the groups runs
in the Python backend. The two sides share data only through ClickHouse, reached
by the backend's `/api/v1/internal/task-groups/*` endpoints.

## What a round does

One BullMQ job per project (`round-<project>`), enqueued every five minutes for
each project that has the feature on (`TaskGroupSettings.enabled`, default off).

1. **Gate.** Off, no model key, or the day's spend cap reached: stop, and say
   why (`RoundStats.skipped`; `readTaskGroupState` derives the status the UI
   shows).
2. **Sample** (`sampler.ts`). For each of the last seven UTC days, ask the
   backend for finished traces without a summary, in sampling order: the first
   eight bytes of `sha256("<project>:<trace>")`, ascending. Take as many as the
   day's quota has room for: a fixed target per day (`DAILY_SAMPLE_TARGET`),
   opened in 24 equal slices so a burst cannot use it all and a quiet morning's
   quota carries forward. A trace's place in the order depends on nothing but its
   ids, so it is in or out the same way every time, and a project below the
   target is sampled fully.
3. **Summarize** (`summarize.ts`, `prompts.ts`). Render the trace with the same
   renderer the detectors use, then ask the model for one sentence naming the kind
   of task. The rendered run is fenced as data and the prompt says so; a closing
   tag inside the data is defanged.
4. **Embed and store.** Embed the summary (never the raw trace) with the shared
   embedding client and write summary, vector, models, prompt version and cost to
   `trace_task_digests`.
5. **Place** (`assign.ts`). Every stored summary without a placement under the
   current fit goes to the nearest group's center if it lies within that group's
   reach, otherwise to no group. No model call.

Spend is recorded per project per UTC day (`TaskGroupSpendDay`); a round only
summarizes as many traces as the remaining budget pays for at
`SUMMARY_COST_ESTIMATE_USD`.

## Names

`trace_task_digests` (summary and embedding per trace), `task_groups` (the
groups of a fit), `trace_group_members` (which group a trace is in). `lens`
is a column in each so another question can be asked of the same traces later.
The UI name lives in `TASK_GROUPS_LABEL` (`@traceroot/core/task-groups`).
